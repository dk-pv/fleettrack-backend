import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TripEventAction, TripStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripStatusDto } from './dto/update-trip-status.dto';
import { OverlapQueryDto } from './dto/overlap-query.dto';
import { computeRouteProgress, GeoPoint } from './trip-progress.util';
import { computeEta } from './trip-eta.util';
import { GeocodingService } from '../geocoding/geocoding.service';

type AuthUser = { userId: string; role: string; accountType?: string };

const ROUTE_DEVIATION_THRESHOLD_M = 2000;

const STATUS_NOTE: Record<TripStatus, string> = {
  PLANNED: 'Trip created',
  ASSIGNED: 'Vehicle & driver assigned',
  STARTED: 'Trip started',
  ONGOING: 'In transit',
  DELAYED: 'Trip delayed',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
};

/** Lifecycle state machine — allowed next statuses per current status. */
const TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  PLANNED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['STARTED', 'CANCELLED'],
  STARTED: ['ONGOING', 'DELAYED', 'CANCELLED'],
  ONGOING: ['DELAYED', 'COMPLETED', 'CANCELLED'],
  DELAYED: ['ONGOING', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Stops may only be added / removed / reordered before a trip starts (TM-05). */
const STOP_EDITABLE_STATUSES: TripStatus[] = [
  TripStatus.PLANNED,
  TripStatus.ASSIGNED,
];

/** Statuses for which a destination ETA is meaningful (trip in transit — ETA-01). */
const ETA_ACTIVE_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

const tripInclude = {
  client: { select: { id: true, name: true } },
  vehicle: { select: { id: true, vehicleNumber: true, vehicleName: true } },
  customer: { select: { id: true, name: true } },
  stops: { orderBy: { sequence: 'asc' as const } },
};

@Injectable()
export class TripsService {
  constructor(
    private prisma: PrismaService,
    private geocoding: GeocodingService,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Reads                                                            */
  /* ---------------------------------------------------------------- */

  async findAll(user: AuthUser, selectedClientId?: string) {
    const where: Prisma.TripWhereInput = {};

    // ADMIN may narrow by a selected client; a CLIENT is pinned to its own trips.
    if (user.role === 'ADMIN' && selectedClientId) {
      where.clientId = selectedClientId;
    }
    if (user.role === 'CLIENT') {
      where.clientId = user.userId;
    }

    const trips = await this.prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, trips: trips.map((t) => this.mapTrip(t)) };
  }

  async findOne(user: AuthUser, id: string) {
    const trip = await this.getReadable(user, id);
    return { success: true, trip: this.mapTrip(trip) };
  }

  async getTimeline(user: AuthUser, id: string) {
    await this.getReadable(user, id);

    const events = await this.prisma.tripEvent.findMany({
      where: { tripId: id },
      orderBy: { createdAt: 'asc' },
    });

    return { success: true, events: events.map((e) => this.mapEvent(e)) };
  }

  /**
   * GPS breadcrumb history (TM-21) — the trip's actual travelled path, recorded by
   * the tracking service while the trip was active. Ordered oldest→newest and
   * mapped to the frontend's TrailPoint shape for playback.
   */
  async getBreadcrumbs(user: AuthUser, id: string) {
    await this.getReadable(user, id);

    const crumbs = await this.prisma.tripBreadcrumb.findMany({
      where: { tripId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      success: true,
      breadcrumbs: crumbs.map((c) => ({
        lat: c.latitude,
        lng: c.longitude,
        timestamp: c.createdAt.getTime(),
        heading: c.heading,
        speed: c.speed,
      })),
    };
  }

  async getProgress(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true } },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
            vehicleName: true,
            latitude: true,
            longitude: true,
          },
        },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    return {
      success: true,
      progress: {
        ...progress,
        hasVehiclePosition,
        isDeviating:
          hasVehiclePosition &&
          progress.deviationMeters > ROUTE_DEVIATION_THRESHOLD_M,
      },
      vehiclePosition: position,
    };
  }

  /**
   * Destination ETA (ETA-01.1 / ETA-01.2). Fully derived: reuses the route-progress
   * `remainingMeters` and the assigned vehicle's live speed (falling back to an
   * average) — no Maps travel time, no external calls. ETA is null unless the trip
   * is in transit, has a live position, and has distance remaining.
   */
  async getEta(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { select: { latitude: true, longitude: true, speed: true } },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    const canEstimate =
      ETA_ACTIVE_STATUSES.includes(trip.status) &&
      hasVehiclePosition &&
      progress.remainingMeters > 0;

    const eta = canEstimate
      ? computeEta(progress.remainingMeters, trip.vehicle?.speed, new Date())
      : null;

    return {
      success: true,
      eta: eta
        ? {
            etaTimestamp: eta.etaTimestamp,
            etaSeconds: eta.etaSeconds,
            basisSpeedKmh: eta.basisSpeedKmh,
            remainingMeters: progress.remainingMeters,
            hasVehiclePosition,
          }
        : null,
    };
  }

  /**
   * Resource availability check (TM-09 / TM-10). Returns the active trips that
   * double-book a candidate vehicle OR driver for the given window. A CLIENT is
   * scoped to its own trips; an ADMIN checks across all trips.
   */
  async checkOverlap(user: AuthUser, query: OverlapQueryDto) {
    const resourceCount = [query.vehicleId, query.driverId].filter(
      Boolean,
    ).length;
    if (resourceCount !== 1) {
      throw new BadRequestException(
        'Provide exactly one of vehicleId or driverId',
      );
    }

    const start = new Date(query.start);
    const end = new Date(query.end);
    // An empty/invalid window can't clash with anything.
    if (!(end > start)) {
      return { success: true, hasOverlap: false, conflicts: [] };
    }

    const conflicts = await this.findOverlapConflicts({
      clientId: user.role === 'CLIENT' ? user.userId : undefined,
      vehicleId: query.vehicleId,
      driverId: query.driverId,
      start,
      end,
      excludeTripId: query.excludeTripId,
    });

    return { success: true, hasOverlap: conflicts.length > 0, conflicts };
  }

  /* ---------------------------------------------------------------- */
  /* Writes (CLIENT only — enforced by @Roles + ownership below)       */
  /* ---------------------------------------------------------------- */

  async create(user: AuthUser, dto: CreateTripDto) {
    // A linked customer must belong to this client (CUS-07.1) — the server-side
    // guarantee behind the form only listing the client's own customers.
    await this.assertOwnedCustomer(user.userId, dto.customerId);

    // Reject double-booking of the vehicle/driver (409 VEHICLE_OVERLAP /
    // DRIVER_OVERLAP) — the server-side guarantee behind the client pre-check.
    await this.assertNoResourceOverlap(user.userId, {
      vehicleId: dto.vehicleId,
      driverId: dto.driverId,
      start: new Date(dto.scheduledStart),
      end: new Date(dto.scheduledEnd),
    });

    const actor = await this.resolveActor(user);

    // Geocode addresses server-side (single source of truth) unless the caller
    // already supplied coordinates — this makes stored coords, and therefore
    // route/progress/deviation, real.
    const origin = await this.resolveCoords(
      dto.origin,
      dto.originLat,
      dto.originLng,
    );
    const destination = await this.resolveCoords(
      dto.destination,
      dto.destinationLat,
      dto.destinationLng,
    );
    const stops = await this.resolveStopCoords(dto.stops ?? []);

    // TM-01.2: a trip created with both a vehicle and a driver is already
    // assigned, so it persists as ASSIGNED; it only rests in PLANNED when
    // created without an assignment.
    const initialStatus =
      dto.vehicleId && dto.driverId ? TripStatus.ASSIGNED : TripStatus.PLANNED;

    const trip = await this.prisma.trip.create({
      data: {
        reference: dto.reference ?? this.generateReference(),
        status: initialStatus,
        clientId: user.userId, // owner is always the authenticated client
        vehicleId: dto.vehicleId ?? null,
        driverId: dto.driverId ?? null,
        driverName: dto.driverName ?? null,
        customerId: dto.customerId ?? null,
        origin: dto.origin,
        originLat: origin.lat,
        originLng: origin.lng,
        destination: dto.destination,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
        distanceKm: dto.distanceKm ?? 0,
        durationMins: dto.durationMins ?? 0,
        notes: dto.notes ?? null,
        scheduledStart: new Date(dto.scheduledStart),
        scheduledEnd: new Date(dto.scheduledEnd),
        stops: {
          create: stops,
        },
        events: {
          create: {
            action: TripEventAction.CREATED,
            status: initialStatus,
            note: STATUS_NOTE[initialStatus],
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async update(user: AuthUser, id: string, dto: UpdateTripDto) {
    const existing = await this.getOwned(user, id);

    // A (re)linked customer must belong to this client (CUS-07.1).
    await this.assertOwnedCustomer(user.userId, dto.customerId);

    // TM-05.1: stops may only be edited before the trip starts.
    if (
      dto.stops !== undefined &&
      !STOP_EDITABLE_STATUSES.includes(existing.status)
    ) {
      throw new BadRequestException('STOPS_LOCKED');
    }

    // Re-check availability against the effective resource + window after the
    // patch, excluding this trip from its own check.
    await this.assertNoResourceOverlap(user.userId, {
      vehicleId: dto.vehicleId ?? existing.vehicleId,
      driverId: dto.driverId ?? existing.driverId,
      start: dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : existing.scheduledStart,
      end: dto.scheduledEnd ? new Date(dto.scheduledEnd) : existing.scheduledEnd,
      excludeTripId: id,
    });

    const actor = await this.resolveActor(user);

    const data: Prisma.TripUncheckedUpdateInput = {
      reference: dto.reference,
      vehicleId: dto.vehicleId,
      driverId: dto.driverId,
      driverName: dto.driverName,
      customerId: dto.customerId,
      distanceKm: dto.distanceKm,
      durationMins: dto.durationMins,
      notes: dto.notes,
      scheduledStart: dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : undefined,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
      events: {
        create: {
          action: TripEventAction.UPDATED,
          note: 'Trip details updated',
          actorRole: actor.role,
          actorName: actor.name,
        },
      },
    };

    // Re-geocode origin/destination whenever they change (unless coords supplied).
    if (dto.origin !== undefined) {
      const origin = await this.resolveCoords(
        dto.origin,
        dto.originLat,
        dto.originLng,
      );
      data.origin = dto.origin;
      data.originLat = origin.lat;
      data.originLng = origin.lng;
    }
    if (dto.destination !== undefined) {
      const destination = await this.resolveCoords(
        dto.destination,
        dto.destinationLat,
        dto.destinationLng,
      );
      data.destination = dto.destination;
      data.destinationLat = destination.lat;
      data.destinationLng = destination.lng;
    }

    // TM-05.1: replace the whole stop list — delete existing stops and recreate
    // them in the new order with a fresh 1-based sequence + geocoded coords. One
    // atomic write covers add / remove / reorder.
    if (dto.stops !== undefined) {
      const stops = await this.resolveStopCoords(dto.stops);
      data.stops = {
        deleteMany: {},
        create: stops,
      };
    }

    const trip = await this.prisma.trip.update({
      where: { id },
      data,
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async updateStatus(user: AuthUser, id: string, dto: UpdateTripStatusDto) {
    const existing = await this.getOwned(user, id);

    if (!TRANSITIONS[existing.status].includes(dto.status)) {
      throw new BadRequestException(
        `Cannot change status from ${existing.status} to ${dto.status}`,
      );
    }

    const actor = await this.resolveActor(user);
    const now = new Date();
    const startsNow =
      dto.status === TripStatus.STARTED || dto.status === TripStatus.ONGOING;

    const trip = await this.prisma.trip.update({
      where: { id },
      data: {
        status: dto.status,
        startedAt: startsNow && !existing.startedAt ? now : undefined,
        completedAt: dto.status === TripStatus.COMPLETED ? now : undefined,
        events: {
          create: {
            action: TripEventAction.STATUS_CHANGED,
            status: dto.status,
            note: STATUS_NOTE[dto.status],
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async remove(user: AuthUser, id: string) {
    await this.getOwned(user, id);
    await this.prisma.trip.delete({ where: { id } });
    return { success: true };
  }

  /* ---------------------------------------------------------------- */
  /* Access helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** A trip a CLIENT owns or an ADMIN may read; throws otherwise. */
  private async getReadable(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: tripInclude,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);
    return trip;
  }

  /** A trip the authenticated CLIENT owns; throws otherwise. */
  private async getOwned(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  private assertReadable(user: AuthUser, ownerClientId: string) {
    if (user.role === 'CLIENT' && ownerClientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
  }

  /**
   * A trip may only be linked to a customer the client owns (CUS-07.1). No-op when
   * no customer is being set; throws 400 INVALID_CUSTOMER otherwise.
   */
  private async assertOwnedCustomer(
    clientId: string,
    customerId?: string | null,
  ) {
    if (!customerId) return;
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, clientId },
    });
    if (!customer) throw new BadRequestException('INVALID_CUSTOMER');
  }

  private async resolveActor(
    user: AuthUser,
  ): Promise<{ role: string; name: string | null }> {
    if (user.role === 'CLIENT') {
      const client = await this.prisma.client.findUnique({
        where: { id: user.userId },
        select: { name: true },
      });
      return { role: 'CLIENT', name: client?.name ?? null };
    }
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true },
    });
    return { role: user.role, name: account?.name ?? null };
  }

  private generateReference(): string {
    const year = new Date().getFullYear();
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `TRIP-${year}-${rand}`;
  }

  /* ---------------------------------------------------------------- */
  /* Geocoding (server-side, via GeocodingService — single source)     */
  /* ---------------------------------------------------------------- */

  /** Use caller-supplied coordinates when present, else geocode the address. */
  private async resolveCoords(
    address: string,
    lat?: number | null,
    lng?: number | null,
  ): Promise<{ lat: number | null; lng: number | null }> {
    if (typeof lat === 'number' && typeof lng === 'number') {
      return { lat, lng };
    }
    const point = await this.geocoding.geocode(address);
    return { lat: point?.lat ?? null, lng: point?.lng ?? null };
  }

  /** Resolve coordinates for each stop (sequential; assigns a 1-based sequence). */
  private async resolveStopCoords(stops: NonNullable<CreateTripDto['stops']>) {
    const out: {
      address: string;
      sequence: number;
      lat: number | null;
      lng: number | null;
    }[] = [];
    for (let i = 0; i < stops.length; i++) {
      const coords = await this.resolveCoords(
        stops[i].address,
        stops[i].lat,
        stops[i].lng,
      );
      out.push({
        address: stops[i].address,
        sequence: i + 1,
        lat: coords.lat,
        lng: coords.lng,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Overlap (double-booking) — one canonical query for check + guard  */
  /* ---------------------------------------------------------------- */

  /**
   * Active trips that book the same vehicle or driver during [start, end).
   * Half-open interval — touching edges (one ends exactly as the next begins) do
   * NOT clash — matching the client-side check. COMPLETED and CANCELLED trips have
   * released the resource, so they never block. When `clientId` is given the scan
   * is scoped to that client's trips.
   */
  private async findOverlapConflicts(params: {
    clientId?: string;
    vehicleId?: string | null;
    driverId?: string | null;
    start: Date;
    end: Date;
    excludeTripId?: string;
  }) {
    const where: Prisma.TripWhereInput = {
      status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
      scheduledStart: { lt: params.end },
      scheduledEnd: { gt: params.start },
    };

    if (params.clientId) where.clientId = params.clientId;
    if (params.vehicleId) where.vehicleId = params.vehicleId;
    if (params.driverId) where.driverId = params.driverId;
    if (params.excludeTripId) where.id = { not: params.excludeTripId };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        id: true,
        reference: true,
        scheduledStart: true,
        scheduledEnd: true,
        status: true,
      },
      orderBy: { scheduledStart: 'asc' },
    });

    return trips.map((t) => ({
      tripId: t.id,
      reference: t.reference,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      status: t.status,
    }));
  }

  /**
   * Throws 409 VEHICLE_OVERLAP / DRIVER_OVERLAP if the vehicle or driver is already
   * booked for an overlapping window. Reuses findOverlapConflicts so the create /
   * update guard and the check endpoint share one algorithm.
   */
  private async assertNoResourceOverlap(
    clientId: string,
    params: {
      vehicleId?: string | null;
      driverId?: string | null;
      start: Date;
      end: Date;
      excludeTripId?: string;
    },
  ) {
    if (params.vehicleId) {
      const conflicts = await this.findOverlapConflicts({
        clientId,
        vehicleId: params.vehicleId,
        start: params.start,
        end: params.end,
        excludeTripId: params.excludeTripId,
      });
      if (conflicts.length > 0) {
        throw new ConflictException('VEHICLE_OVERLAP');
      }
    }

    if (params.driverId) {
      const conflicts = await this.findOverlapConflicts({
        clientId,
        driverId: params.driverId,
        start: params.start,
        end: params.end,
        excludeTripId: params.excludeTripId,
      });
      if (conflicts.length > 0) {
        throw new ConflictException('DRIVER_OVERLAP');
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Shaping helpers (Prisma row -> API shape the frontend consumes)   */
  /* ---------------------------------------------------------------- */

  private routePoints(trip: {
    originLat: number | null;
    originLng: number | null;
    destinationLat: number | null;
    destinationLng: number | null;
    stops: { lat: number | null; lng: number | null }[];
  }): GeoPoint[] {
    const points: GeoPoint[] = [];
    if (trip.originLat != null && trip.originLng != null) {
      points.push({ lat: trip.originLat, lng: trip.originLng });
    }
    for (const s of trip.stops) {
      if (s.lat != null && s.lng != null) {
        points.push({ lat: s.lat, lng: s.lng });
      }
    }
    if (trip.destinationLat != null && trip.destinationLng != null) {
      points.push({ lat: trip.destinationLat, lng: trip.destinationLng });
    }
    return points;
  }

  private vehiclePosition(
    vehicle: { latitude: number; longitude: number } | null,
  ): GeoPoint | null {
    if (!vehicle) return null;
    const { latitude, longitude } = vehicle;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return null;
    }
    if (latitude === 0 && longitude === 0) return null;
    return { lat: latitude, lng: longitude };
  }

  private mapTrip(t: any) {
    return {
      id: t.id,
      reference: t.reference,
      status: t.status,
      clientId: t.clientId,
      client: t.client
        ? { id: t.client.id, name: t.client.name }
        : { id: t.clientId, name: '' },
      vehicleId: t.vehicleId,
      vehicle: t.vehicle
        ? {
            id: t.vehicle.id,
            vehicleNumber: t.vehicle.vehicleNumber,
            vehicleName: t.vehicle.vehicleName,
          }
        : null,
      driverId: t.driverId,
      driverName: t.driverName,
      customerId: t.customerId,
      customer: t.customer
        ? { id: t.customer.id, name: t.customer.name }
        : null,
      origin: t.origin,
      originCoords:
        t.originLat != null && t.originLng != null
          ? { lat: t.originLat, lng: t.originLng }
          : undefined,
      destination: t.destination,
      destinationCoords:
        t.destinationLat != null && t.destinationLng != null
          ? { lat: t.destinationLat, lng: t.destinationLng }
          : undefined,
      stops: (t.stops ?? []).map((s: any) => ({
        id: s.id,
        address: s.address,
        sequence: s.sequence,
        coords:
          s.lat != null && s.lng != null
            ? { lat: s.lat, lng: s.lng }
            : undefined,
      })),
      distanceKm: t.distanceKm,
      durationMins: t.durationMins,
      notes: t.notes,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private mapEvent(e: any) {
    return {
      id: e.id,
      tripId: e.tripId,
      action: e.action,
      status: e.status ?? null,
      note: e.note ?? null,
      actor: { role: e.actorRole, name: e.actorName ?? null },
      timestamp: e.createdAt,
    };
  }
}
