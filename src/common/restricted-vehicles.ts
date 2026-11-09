/**
 * Vehicles permanently blocked from FleetTrack (2026-11-06).
 *
 * A restricted vehicle is treated as if it did not exist: no API response or socket event
 * carries it, it cannot be assigned to a client or put on a trip, and the GPS sync neither
 * creates nor updates it. Its existing rows (vehicle, location history, any trip that already
 * references it) stay in the database untouched.
 *
 * Plates are compared normalized (uppercase, letters and digits only), so the block holds
 * whatever format a provider sent or the database stored: "KL 85 B 1418", "kl-85-b-1418" and
 * "KL85B1418" are the same vehicle. Matching happens in code, never as an exact-match SQL
 * filter, for that reason.
 */
const RESTRICTED_VEHICLE_NUMBERS = new Set([
  'KL85B1418',
  'KL85B6934',
  'KL85B3285',
  'KL85B3218',
  'KL85B4876',
  'KL84B4876',
]);

export function isRestrictedVehicle(vehicleNumber?: string | null): boolean {
  return RESTRICTED_VEHICLE_NUMBERS.has(
    (vehicleNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  );
}
