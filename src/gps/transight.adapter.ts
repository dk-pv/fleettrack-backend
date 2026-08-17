import { Logger } from '@nestjs/common';

import {
  GpsProvider,
  GpsProviderConfig,
  NormalizedPosition,
  NormalizedVehicle,
} from './gps-provider.interface';

/**
 * Transight API v2.5 adapter. POST {baseUrl}/{endpoint}/ with a JSON body { apikey }.
 * Success is status:1; status:4 is the rate limit; other non-1 statuses are errors.
 *   - get_all_vehicles           → inventory [{ vehicle_number, vehicle_id, imei }]  (100/day)
 *   - get_all_vehicles_last_data → positions [{ vehicle, imei, ignition, speed, location, time }] (500/day)
 * Positions carry no vehicle_id, so identity is resolved by joining IMEI → inventory
 * (cached with a TTL to respect the 100/day inventory limit). location is a
 * space-separated "lat lng" string; time is LOCAL (IST) with no tz marker — see
 * parseProviderTime, which corrects an earlier assumption that it was UTC.
 * Transight provides no power/charge/battery — those are never invented.
 */
export class TransightAdapter implements GpsProvider {
  readonly name = 'transight' as const;

  private readonly logger = new Logger(TransightAdapter.name);

  private inventoryByImei = new Map<
    string,
    { vehicleId: string; vehicleNumber: string }
  >();
  private inventoryFetchedAt = 0;
  private static readonly INVENTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

  constructor(private config: GpsProviderConfig) {}

  setConfig(config: GpsProviderConfig): void {
    this.config = config;
  }

  private async post(endpoint: string): Promise<any> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/${endpoint}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: this.config.credential }),
    });
    if (!res.ok) throw new Error(`Transight HTTP ${res.status} on ${endpoint}`);
    const json = await res.json();
    TransightAdapter.assertOk(json, endpoint);
    return json;
  }

  /** Throws on any non-success status; status 4 is the daily rate limit. */
  static assertOk(json: any, endpoint: string): void {
    const status = Number(json?.status);
    if (status === 1) return;
    if (status === 4) {
      throw new Error(`Transight rate limit reached on ${endpoint} (status 4)`);
    }
    const msg = Array.isArray(json?.messages)
      ? json.messages.join('; ')
      : 'unknown error';
    throw new Error(
      `Transight error status ${String(json?.status)} on ${endpoint}: ${msg}`,
    );
  }

  /** "027.125795 078.454375" → { latitude, longitude }; null if unparseable. */
  static parseLocation(
    location: unknown,
  ): { latitude: number; longitude: number } | null {
    if (typeof location !== 'string') return null;
    const parts = location.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const latitude = Number(parts[0]);
    const longitude = Number(parts[1]);
    if (isNaN(latitude) || isNaN(longitude)) return null;
    return { latitude, longitude };
  }

  /**
   * Transight sends "YYYY-MM-DD HH:mm:ss" with NO timezone marker, and the value is
   * LOCAL time (IST, UTC+05:30) — not UTC, which is what this adapter assumed.
   *
   * Verified against the live production account on 2026-08-14: the newest fix read
   * "2026-08-14 17:47:49" while real UTC was 12:18:50 — 5h29m ahead. Appending "Z"
   * therefore dated every Transight position ~5.5 HOURS INTO THE FUTURE, which made
   * `now - fixTime` negative for the whole fleet. Any freshness check built on that
   * silently passes forever, and "last seen" was displayed 5.5 hours wrong.
   *
   * The offset is overridable without a code change for accounts in another timezone.
   */
  static offsetMinutes(): number {
    const raw = Number(process.env.TRANSIGHT_UTC_OFFSET_MINUTES);
    return Number.isFinite(raw) ? raw : 330; // +05:30 (IST)
  }

  /** Parse a Transight local-time string into a real UTC Date; null if unusable. */
  static parseProviderTime(
    time: unknown,
    offsetMinutes: number = TransightAdapter.offsetMinutes(),
  ): Date | null {
    if (typeof time !== 'string' || !time.trim()) return null;

    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
      time.trim(),
    );
    if (!m) return null;

    const utcMs =
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] ?? 0),
      ) -
      offsetMinutes * 60_000;

    const d = new Date(utcMs);
    return isNaN(d.getTime()) ? null : d;
  }

  static normalizeInventory(json: any): NormalizedVehicle[] {
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .filter((i: any) => i?.vehicle_id != null)
      .map((i: any) => {
        const imei = i.imei != null ? String(i.imei) : null;
        return {
          providerName: 'transight' as const,
          providerVehicleId: String(i.vehicle_id),
          vehicleNumber: String(i.vehicle_number ?? i.vehicle_id),
          imei,
          gpsDeviceId: imei,
        };
      });
  }

  /** Pure mapping of one last-data row → NormalizedPosition (unit-tested). */
  static normalizePosition(
    item: any,
    resolve: (
      imei: string | null,
    ) => { vehicleId: string; vehicleNumber: string } | undefined,
  ): NormalizedPosition | null {
    const imei = item?.imei != null ? String(item.imei) : null;
    const loc = TransightAdapter.parseLocation(item?.location);
    const identity = resolve(imei);
    // providerVehicleId = vehicle_id when known, else fall back to the (stable) IMEI.
    // The fallback is flagged so the sync knows this identity is unproven — see
    // NormalizedPosition.identityIsFallback.
    const providerVehicleId = identity?.vehicleId ?? imei;
    if (!providerVehicleId) return null;
    const identityIsFallback = !identity;
    return {
      providerName: 'transight',
      providerVehicleId: String(providerVehicleId),
      vehicleNumber: String(
        identity?.vehicleNumber ?? item?.vehicle ?? providerVehicleId,
      ),
      imei,
      gpsDeviceId: imei,
      latitude: loc?.latitude ?? 0,
      longitude: loc?.longitude ?? 0,
      speed: Number(item?.speed) || 0,
      ignition: Boolean(item?.ignition),
      batteryVoltage: null,
      charge: null,
      providerTimestamp: TransightAdapter.parseProviderTime(item?.time),
      identityIsFallback,
    };
  }

  async getVehicles(): Promise<NormalizedVehicle[]> {
    const json = await this.post('get_all_vehicles');
    const vehicles = TransightAdapter.normalizeInventory(json);
    this.inventoryByImei.clear();
    for (const v of vehicles) {
      if (v.imei) {
        this.inventoryByImei.set(v.imei, {
          vehicleId: v.providerVehicleId,
          vehicleNumber: v.vehicleNumber,
        });
      }
    }
    this.inventoryFetchedAt = Date.now();
    return vehicles;
  }

  /**
   * Refresh the IMEI → vehicle_id map when it is empty or past its TTL.
   *
   * A failure here is NOT fatal — a stale cache still resolves identity correctly, and
   * positions must keep flowing. But it is no longer silent: this failing with an EMPTY
   * cache is the precise condition that made every position fall back to an IMEI key and
   * created 12 duplicate vehicle rows in production on 2026-08-14. It has to be visible in
   * the logs, and distinguishable from the harmless "stale but usable" case.
   */
  private async ensureInventory(): Promise<void> {
    const stale =
      Date.now() - this.inventoryFetchedAt > TransightAdapter.INVENTORY_TTL_MS;
    if (this.inventoryByImei.size === 0 || stale) {
      try {
        await this.getVehicles();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (this.inventoryByImei.size === 0) {
          // No cache at all: identity cannot be resolved for ANY vehicle this cycle.
          this.logger.error(
            `Transight inventory unavailable and the identity cache is EMPTY (${reason}). ` +
              `Positions this cycle carry a fallback IMEI identity: existing vehicles are ` +
              `still matched by IMEI, but no NEW vehicle will be created until inventory ` +
              `recovers. Note get_all_vehicles is capped at 100 calls/day.`,
          );
        } else {
          this.logger.warn(
            `Transight inventory refresh failed (${reason}); continuing with the cached ` +
              `IMEI → vehicle_id map from ${new Date(this.inventoryFetchedAt).toISOString()}.`,
          );
        }
      }
    }
  }

  async getLatestPositions(): Promise<NormalizedPosition[]> {
    await this.ensureInventory();
    const json = await this.post('get_all_vehicles_last_data');
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .map((item: any) =>
        TransightAdapter.normalizePosition(item, (imei) =>
          imei ? this.inventoryByImei.get(imei) : undefined,
        ),
      )
      .filter((v: NormalizedPosition | null): v is NormalizedPosition => v !== null);
  }
}
