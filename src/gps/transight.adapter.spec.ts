import { TransightAdapter } from './transight.adapter';

describe('TransightAdapter', () => {
  it('parses the "lat lng" location string', () => {
    expect(TransightAdapter.parseLocation('027.125795 078.454375')).toEqual({
      latitude: 27.125795,
      longitude: 78.454375,
    });
    expect(TransightAdapter.parseLocation('bad')).toBeNull();
    expect(TransightAdapter.parseLocation(null)).toBeNull();
  });

  it('parses UTC time with no tz marker AS UTC (not local)', () => {
    const d = TransightAdapter.parseUtcTime('2022-02-08 14:17:35');
    expect(d?.toISOString()).toBe('2022-02-08T14:17:35.000Z');
    expect(TransightAdapter.parseUtcTime('')).toBeNull();
  });

  it('accepts status 1, throws on 4 (rate limit) and other statuses', () => {
    expect(() => TransightAdapter.assertOk({ status: 1 }, 'x')).not.toThrow();
    expect(() => TransightAdapter.assertOk({ status: 4 }, 'x')).toThrow(
      /rate limit/i,
    );
    expect(() =>
      TransightAdapter.assertOk({ status: 5, messages: ['Data not available'] }, 'x'),
    ).toThrow(/status 5/);
  });

  it('normalizes inventory from get_all_vehicles', () => {
    const v = TransightAdapter.normalizeInventory({
      status: 1,
      data: [{ vehicle_number: 'API TEST', vehicle_id: 'VID9', imei: '123' }],
    });
    expect(v).toEqual([
      {
        providerName: 'transight',
        providerVehicleId: 'VID9',
        vehicleNumber: 'API TEST',
        imei: '123',
        gpsDeviceId: '123',
      },
    ]);
  });

  it('normalizes a position, joining IMEI → vehicle_id, never inventing battery', () => {
    const pos = TransightAdapter.normalizePosition(
      {
        vehicle: 'API TEST',
        imei: '123',
        ignition: true,
        speed: 10.5,
        location: '027.125795 078.454375',
        time: '2022-02-08 14:17:35',
      },
      (imei) =>
        imei === '123' ? { vehicleId: 'VID9', vehicleNumber: 'API TEST' } : undefined,
    );

    expect(pos).toMatchObject({
      providerName: 'transight',
      providerVehicleId: 'VID9',
      vehicleNumber: 'API TEST',
      imei: '123',
      latitude: 27.125795,
      longitude: 78.454375,
      speed: 10.5,
      ignition: true,
      batteryVoltage: null,
      charge: null,
    });
    expect(pos!.providerTimestamp?.toISOString()).toBe('2022-02-08T14:17:35.000Z');
  });

  it('falls back to IMEI as providerVehicleId when inventory misses', () => {
    const pos = TransightAdapter.normalizePosition(
      { vehicle: 'X', imei: '999', location: '1 2', time: '', speed: 0, ignition: false },
      () => undefined,
    );
    expect(pos!.providerVehicleId).toBe('999');
    expect(pos!.imei).toBe('999');
  });

  it('returns null when there is no IMEI and no resolvable id', () => {
    const pos = TransightAdapter.normalizePosition(
      { vehicle: 'X', location: '1 2', speed: 0, ignition: false },
      () => undefined,
    );
    expect(pos).toBeNull();
  });
});
