export type VehicleStatus =
  | "MOVING"
  | "IDLE"
  | "OFFLINE";

export function getVehicleStatus(
  ignition: boolean,
  speed: number,
): VehicleStatus {
  /* MOVING */

  if (speed > 0) {
    return "MOVING";
  }

  /* IDLE */

  if (
    ignition === true &&
    speed === 0
  ) {
    return "IDLE";
  }

  /* OFFLINE */

  return "OFFLINE";
}