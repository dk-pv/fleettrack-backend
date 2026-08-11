import { AiroTrackAdapter } from './airotrack.adapter';

describe('AiroTrackAdapter.normalizePosition', () => {
  it('maps the confirmed live AiroTrack shape', () => {
    const p = AiroTrackAdapter.normalizePosition({
      vehicleNumber: 'KL01AB1234',
      last_updated: '2026-08-11 10:00:00',
      lat: 10.5,
      long: 76.2,
      speed: 42,
      ignition: true,
      power: 12.4,
      charge: true,
    });

    expect(p).toMatchObject({
      providerName: 'airotrack',
      providerVehicleId: 'KL01AB1234',
      vehicleNumber: 'KL01AB1234',
      imei: null,
      gpsDeviceId: 'KL01AB1234',
      latitude: 10.5,
      longitude: 76.2,
      speed: 42,
      ignition: true,
      batteryVoltage: 12.4,
      charge: true,
    });
    expect(p!.providerTimestamp).toBeInstanceOf(Date);
  });

  it('returns null when vehicleNumber is missing', () => {
    expect(AiroTrackAdapter.normalizePosition({ lat: 1, long: 2 })).toBeNull();
  });

  it('defaults missing coords/speed to 0 and keeps absent battery as null', () => {
    const p = AiroTrackAdapter.normalizePosition({
      vehicleNumber: 'X',
      ignition: false,
    });
    expect(p).toMatchObject({
      latitude: 0,
      longitude: 0,
      speed: 0,
      ignition: false,
      batteryVoltage: null,
      charge: null,
    });
    expect(p!.providerTimestamp).toBeNull();
  });
});
