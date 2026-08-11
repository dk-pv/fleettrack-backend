import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Vehicle, TripStatus, VehicleStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from './tracking.gateway';
import { GpsIntegrationService } from '../gps/gps-integration.service';
import { NormalizedPosition } from '../gps/gps-provider.interface';

function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));

  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function isValidCoord(lat: number, lng: number): boolean {
  if (isNaN(lat) || isNaN(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

const MIN_SAVE_DISTANCE_METERS = 10;

/** Trip statuses that are actively travelling and should record GPS breadcrumbs. */
const ACTIVE_TRIP_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  // Reentrancy guard — a single poller. If a tick is still running (slow provider
  // or DB), the next @Cron tick is skipped rather than starting a second sync.
  private isSyncing = false;

  constructor(
    private prisma: PrismaService,
    private trackingGateway: TrackingGateway,
    private gpsIntegration: GpsIntegrationService,
  ) {}

  /**
   * Transient DB connectivity errors (e.g. Neon serverless cold-start or idle
   * disconnect). Safe to skip — the next scheduled tick retries.
   */
  private isTransientDbError(error: unknown): boolean {
    const e = error as { code?: string; errorCode?: string };
    const code = e?.code ?? e?.errorCode;
    return code === 'P1001' || code === 'P1002' || code === 'P1017';
  }

  private deriveStatus(ignition: boolean, speed: number): VehicleStatus {
    if (ignition && speed > 0) return 'MOVING';
    if (ignition && speed <= 0) return 'IDLE';
    return 'OFFLINE';
  }

  /**
   * Poll every active GPS provider that is due (per-provider cadence, so Transight's
   * ~5-min bulk stays under its 500/day limit while AiroTrack can poll every minute),
   * normalize positions through the provider adapters, and upsert into the shared
   * vehicle inventory. A provider sync NEVER assigns a vehicle to a client: new
   * vehicles land as unassigned inventory (clientId = null); existing vehicles keep
   * their clientId untouched.
   */
  @Cron('0 * * * * *')
  async syncVehicles() {
    if (this.isSyncing) {
      this.logger.warn('Previous sync still running — skipping this tick');
      return;
    }
    this.isSyncing = true;

    try {
      const providers = await this.gpsIntegration.getActiveProviders();

      for (const { config, provider } of providers) {
        const dueMs = (config.pollIntervalSec ?? 300) * 1000;
        const last = config.lastSyncedAt ? config.lastSyncedAt.getTime() : 0;
        if (Date.now() - last < dueMs) continue; // not due yet (rate-limit cadence)

        try {
          const positions = await provider.getLatestPositions();
          this.logger.log(
            `Provider ${config.provider}: ${positions.length} positions`,
          );

          for (const pos of positions) {
            await this.upsertPosition(pos);
          }

          await this.gpsIntegration.markSynced(config.provider, null);
        } catch (providerError) {
          if (this.isTransientDbError(providerError)) {
            this.logger.warn(
              `DB temporarily unreachable while syncing ${config.provider} — skipping`,
            );
            continue;
          }
          const msg =
            providerError instanceof Error
              ? providerError.message
              : String(providerError);
          this.logger.error(`Provider ${config.provider} sync failed: ${msg}`);
          await this.gpsIntegration.markSynced(config.provider, msg);
        }
      }
    } catch (error) {
      if (this.isTransientDbError(error)) {
        this.logger.warn('DB temporarily unreachable — skipping this sync tick');
        return;
      }
      this.logger.error(
        'Vehicle sync failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Insert a new (unassigned) vehicle or update an existing one, keyed by provider
   * identity (providerName + providerVehicleId) — NOT by clientId, so assignment is
   * preserved. Records location history + trip breadcrumbs and broadcasts the update
   * (scoped: owning client's room + admins; unassigned → admins only).
   */
  private async upsertPosition(pos: NormalizedPosition): Promise<void> {
    const status = this.deriveStatus(pos.ignition, pos.speed);

    const existing = await this.prisma.vehicle.findFirst({
      where: {
        providerName: pos.providerName,
        providerVehicleId: pos.providerVehicleId,
      },
    });

    if (!existing) {
      const created = await this.prisma.vehicle.create({
        data: {
          vehicleName: pos.vehicleNumber,
          vehicleNumber: pos.vehicleNumber,
          gpsDeviceId: pos.gpsDeviceId ?? pos.vehicleNumber,
          providerName: pos.providerName,
          providerVehicleId: pos.providerVehicleId,
          imei: pos.imei ?? null,
          driverName: 'Unknown Driver',
          clientId: null, // unassigned global inventory — never auto-assigned
          ignition: pos.ignition,
          batteryVoltage: pos.batteryVoltage ?? undefined,
          charge: pos.charge ?? undefined,
          isOnline: true,
          status,
          latitude: pos.latitude,
          longitude: pos.longitude,
          speed: pos.speed,
          lastSeenAt: new Date(),
          lastProviderUpdate: pos.providerTimestamp ?? new Date(),
        },
      });

      this.logger.log(
        `New unassigned inventory vehicle ${pos.vehicleNumber} (${pos.providerName})`,
      );
      this.trackingGateway.emitVehicleUpdate(created);
      return;
    }

    const updated = await this.prisma.vehicle.update({
      where: { id: existing.id },
      // Position/telemetry only — clientId is deliberately absent so assignment is
      // never changed by a sync. Transight lacks battery/charge → undefined = no-op.
      data: {
        ignition: pos.ignition,
        batteryVoltage: pos.batteryVoltage ?? undefined,
        charge: pos.charge ?? undefined,
        imei: pos.imei ?? existing.imei ?? undefined,
        isOnline: true,
        status,
        latitude: pos.latitude,
        longitude: pos.longitude,
        speed: pos.speed,
        lastSeenAt: new Date(),
        lastProviderUpdate: pos.providerTimestamp ?? new Date(),
      },
    });

    await this.recordHistoryAndBreadcrumbs(updated, pos);

    // Scoped delivery: only the owning client's room + admins (never global).
    this.trackingGateway.emitVehicleUpdate(updated);
  }

  /**
   * Persist a location-history point (with computed heading) and a trip breadcrumb,
   * gated by the same 10m movement filter as before. Unchanged logic, just factored
   * out of the sync loop so both providers reuse it.
   */
  private async recordHistoryAndBreadcrumbs(
    vehicle: Vehicle,
    pos: NormalizedPosition,
  ): Promise<void> {
    if (!isValidCoord(pos.latitude, pos.longitude)) return;

    const lastHistory = await this.prisma.vehicleLocationHistory.findFirst({
      where: { vehicleId: vehicle.id },
      orderBy: { createdAt: 'desc' },
    });

    let shouldSave = true;
    let heading = 0;

    if (lastHistory) {
      const dist = haversineDistance(
        lastHistory.latitude,
        lastHistory.longitude,
        pos.latitude,
        pos.longitude,
      );

      if (dist < MIN_SAVE_DISTANCE_METERS) {
        shouldSave = false;
      } else {
        heading = calculateBearing(
          lastHistory.latitude,
          lastHistory.longitude,
          pos.latitude,
          pos.longitude,
        );
      }
    }

    if (!shouldSave) return;

    await this.prisma.vehicleLocationHistory.create({
      data: {
        vehicleId: vehicle.id,
        latitude: pos.latitude,
        longitude: pos.longitude,
        speed: pos.speed,
        ignition: pos.ignition,
        heading,
      },
    });

    await this.recordTripBreadcrumbs(vehicle.id, {
      lat: pos.latitude,
      lng: pos.longitude,
      speed: pos.speed,
      heading,
    });
  }

  @Cron('0 */1 * * * *')
  async detectOfflineVehicles() {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const offlineVehicles = await this.prisma.vehicle.findMany({
        where: {
          lastSeenAt: {
            lt: fiveMinutesAgo,
          },
          isOnline: true,
        },
      });

      for (const vehicle of offlineVehicles) {
        const updatedVehicle = await this.prisma.vehicle.update({
          where: {
            id: vehicle.id,
          },
          data: {
            isOnline: false,
            status: 'OFFLINE',
          },
        });

        // Scoped delivery: only the owning client's room + admins (never global).
        this.trackingGateway.emitVehicleUpdate(updatedVehicle);

        this.logger.warn(`Vehicle offline: ${vehicle.vehicleNumber}`);
      }
    } catch (error) {
      if (this.isTransientDbError(error)) {
        this.logger.warn(
          'DB temporarily unreachable — skipping offline detection',
        );
        return;
      }
      this.logger.error(
        'Offline detection failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Append a GPS breadcrumb to every trip this vehicle is actively running, so a
   * completed trip can later replay its real travelled route. Called only when the
   * vehicle has moved far enough to persist (reuses the location-history filter).
   */
  private async recordTripBreadcrumbs(
    vehicleId: string,
    point: { lat: number; lng: number; speed: number; heading: number },
  ) {
    try {
      const activeTrips = await this.prisma.trip.findMany({
        where: { vehicleId, status: { in: ACTIVE_TRIP_STATUSES } },
        select: { id: true },
      });

      if (activeTrips.length === 0) return;

      await this.prisma.tripBreadcrumb.createMany({
        data: activeTrips.map((trip) => ({
          tripId: trip.id,
          latitude: point.lat,
          longitude: point.lng,
          speed: point.speed,
          heading: point.heading,
        })),
      });
    } catch (error) {
      // Breadcrumb recording is secondary — never let it disrupt vehicle sync or
      // the live location broadcast. The next tick retries.
      this.logger.warn(
        `Failed to record trip breadcrumbs for vehicle ${vehicleId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
