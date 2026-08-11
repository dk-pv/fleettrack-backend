// Normalized shapes that BOTH providers map into, so the sync never sees a
// provider-specific payload. Provider-specific parsing stays in the adapters;
// vehicle persistence is never duplicated inside a provider.

export type GpsProviderKey = 'airotrack' | 'transight';

export interface NormalizedVehicle {
  providerName: GpsProviderKey;
  /** Stable provider identity. AiroTrack: vehicleNumber. Transight: vehicle_id. */
  providerVehicleId: string;
  /** Display number plate. */
  vehicleNumber: string;
  /** Transight device IMEI; AiroTrack has none (null). */
  imei?: string | null;
  gpsDeviceId?: string | null;
}

export interface NormalizedPosition extends NormalizedVehicle {
  latitude: number;
  longitude: number;
  speed: number;
  ignition: boolean;
  /**
   * AiroTrack-only extras. Transight does NOT provide power/charge/battery —
   * these are left null there and never invented.
   */
  batteryVoltage?: number | null;
  charge?: boolean | null;
  /** Provider "last_updated" / "time" as a UTC Date, or null if absent/unparseable. */
  providerTimestamp?: Date | null;
}

export interface GpsProviderConfig {
  baseUrl: string;
  /** token (AiroTrack) or apikey (Transight). Never logged or serialized. */
  credential: string;
  system?: string | null;
}

export interface GpsProvider {
  readonly name: GpsProviderKey;
  /** Identity/inventory list (no position needed). */
  getVehicles(): Promise<NormalizedVehicle[]>;
  /** Latest positions for all vehicles (bulk). */
  getLatestPositions(): Promise<NormalizedPosition[]>;
}
