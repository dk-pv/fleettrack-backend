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
 * space-separated "lat lng" string; time is UTC with no tz marker.
 * Transight provides no power/charge/battery — those are never invented.
 */
export class TransightAdapter implements GpsProvider {
  readonly name = 'transight' as const;

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

  /** Transight time is UTC WITHOUT a tz marker ("2022-02-08 14:17:35") — parse as UTC. */
  static parseUtcTime(time: unknown): Date | null {
    if (typeof time !== 'string' || !time.trim()) return null;
    const iso = time.trim().replace(' ', 'T') + 'Z';
    const d = new Date(iso);
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
    const providerVehicleId = identity?.vehicleId ?? imei;
    if (!providerVehicleId) return null;
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
      providerTimestamp: TransightAdapter.parseUtcTime(item?.time),
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

  private async ensureInventory(): Promise<void> {
    const stale =
      Date.now() - this.inventoryFetchedAt > TransightAdapter.INVENTORY_TTL_MS;
    if (this.inventoryByImei.size === 0 || stale) {
      try {
        await this.getVehicles();
      } catch {
        // Keep any stale cache; positions fall back to IMEI as providerVehicleId.
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
