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

  // Transight sends local (IST) time with no tz marker. Treating it as UTC dated every
  // position 5.5h in the future, which made `now - fixTime` negative and defeated every
  // downstream freshness check. Verified against production 2026-08-14.
  it('parses tz-less time as IST (+05:30), not UTC', () => {
    const d = TransightAdapter.parseProviderTime('2022-02-08 14:17:35');
    expect(d?.toISOString()).toBe('2022-02-08T08:47:35.000Z');
  });

  it('rejects unusable timestamps instead of inventing one', () => {
    expect(TransightAdapter.parseProviderTime('')).toBeNull();
    expect(TransightAdapter.parseProviderTime(null)).toBeNull();
    expect(TransightAdapter.parseProviderTime('not-a-date')).toBeNull();
  });

  it('honours an explicit offset override (other-timezone accounts)', () => {
    const d = TransightAdapter.parseProviderTime('2022-02-08 14:17:35', 0);
    expect(d?.toISOString()).toBe('2022-02-08T14:17:35.000Z');
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
    // 14:17:35 IST → 08:47:35 UTC
    expect(pos!.providerTimestamp?.toISOString()).toBe('2022-02-08T08:47:35.000Z');
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

/**
 * Identity-fallback flagging. Transight positions carry no vehicle_id, so the adapter
 * substitutes the IMEI when its inventory cache cannot resolve one. That substitution is
 * now flagged, because the sync must not CREATE a vehicle on an unproven identity — doing
 * so is what produced 12 duplicate rows in production on 2026-08-14.
 */
describe('TransightAdapter identity fallback flag', () => {
  const rawPosition = {
    vehicle: 'KL84D1577',
    imei: '860560066144082',
    ignition: true,
    speed: 12,
    location: '010.995818 075.991227',
    time: '2026-08-14 17:47:49',
  };

  it('marks identity as PROVEN when the inventory cache resolves a vehicle_id', () => {
    const pos = TransightAdapter.normalizePosition(rawPosition, () => ({
      vehicleId: '228068',
      vehicleNumber: 'KL84D1577',
    }));

    expect(pos!.providerVehicleId).toBe('228068');
    expect(pos!.identityIsFallback).toBe(false);
  });

  it('marks identity as FALLBACK when the cache misses and the IMEI stands in', () => {
    const pos = TransightAdapter.normalizePosition(rawPosition, () => undefined);

    expect(pos!.providerVehicleId).toBe('860560066144082'); // the IMEI, not a vehicle_id
    expect(pos!.identityIsFallback).toBe(true);
  });

  it('still drops a position that has neither a resolvable id nor an IMEI', () => {
    expect(
      TransightAdapter.normalizePosition(
        { vehicle: 'X', location: '1 2', speed: 0, ignition: false, time: '' },
        () => undefined,
      ),
    ).toBeNull();
  });
});
