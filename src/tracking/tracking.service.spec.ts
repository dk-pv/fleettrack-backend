import { TrackingService } from './tracking.service';
import { NormalizedPosition } from '../gps/gps-provider.interface';

/**
 * Vehicle identity resolution during a provider sync.
 *
 * These tests exist because production accumulated 12 duplicate Transight vehicles: the
 * adapter substitutes the IMEI for `providerVehicleId` whenever its inventory cache is
 * cold, the sync looked the vehicle up by `providerVehicleId` only, missed the existing
 * row, and created a second one. `@@unique([providerName, providerVehicleId])` could not
 * catch it because the two keys genuinely differ.
 *
 * They are driven through the real `syncVehicles()` rather than the private upsert, so the
 * assertions cover the path that actually runs in production.
 */

/** Minimal in-memory Vehicle table — lets us assert on row identity and row COUNT. */
function makeStore(seed: any[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = 1000;

  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const vehicle = {
    findFirst: jest.fn(
      async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: jest.fn(async ({ where }: any = {}) =>
      where ? rows.filter((r) => matches(r, where)) : rows,
    ),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `new-${nextId++}`, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error('no such vehicle: ' + where.id);
      for (const [k, v] of Object.entries(data))
        if (v !== undefined) (row as any)[k] = v;
      return row;
    }),
  };

  const history: any[] = [];

  const prisma: any = {
    vehicle,
    vehicleLocationHistory: {
      findFirst: jest.fn(async ({ where }: any) => {
        const forVehicle = history.filter(
          (h) => h.vehicleId === where.vehicleId,
        );
        return forVehicle[forVehicle.length - 1] ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        history.push(data);
        return data;
      }),
      count: jest.fn(
        async ({ where }: any) =>
          history.filter((h) => h.vehicleId === where.vehicleId).length,
      ),
    },
    trip: { findMany: jest.fn(async () => []) },
    tripBreadcrumb: { createMany: jest.fn(async () => ({ count: 0 })) },
    gpsIntegration: { findMany: jest.fn(async () => []) },
  };

  return { prisma, vehicle, rows, history };
}

function makeService(
  store: ReturnType<typeof makeStore>,
  positions: NormalizedPosition[],
  providerEnum = 'TRANSIGHT',
  pollIntervalSec = 300,
) {
  const gateway: any = { emitVehicleUpdate: jest.fn() };
  const gpsIntegration: any = {
    getActiveProviders: jest.fn(async () => [
      {
        config: { provider: providerEnum, pollIntervalSec, lastSyncedAt: null },
        provider: {
          name: providerEnum.toLowerCase(),
          getLatestPositions: async () => positions,
          getVehicles: async () => [],
        },
      },
    ]),
    markSynced: jest.fn(async () => undefined),
  };
  return {
    service: new TrackingService(store.prisma, gateway, gpsIntegration),
    gateway,
  };
}

/** A fresh Transight position for the KL84D1577 device from the production audit. */
const transightPos = (
  over: Partial<NormalizedPosition> = {},
): NormalizedPosition => ({
  providerName: 'transight',
  providerVehicleId: '228068',
  vehicleNumber: 'KL84D1577',
  imei: '860560066144082',
  gpsDeviceId: '860560066144082',
  latitude: 10.995818,
  longitude: 75.991227,
  speed: 12,
  ignition: true,
  batteryVoltage: null,
  charge: null,
  providerTimestamp: new Date(),
  ...over,
});

/** The existing legitimate row: keyed by vehicle_id, assigned to a client. */
const legitRow = () => ({
  id: 'cmsolbu900013htv0r6tnmpm1',
  vehicleName: 'KL84D1577',
  vehicleNumber: 'KL84D1577',
  gpsDeviceId: '860560066144082',
  providerName: 'transight',
  providerVehicleId: '228068',
  imei: '860560066144082',
  driverName: 'Real Driver',
  clientId: 'client-nesto',
  status: 'IDLE',
  isOnline: true,
  speed: 0,
  latitude: 10.9,
  longitude: 75.9,
  lastProviderUpdate: new Date(Date.now() - 10 * 60 * 1000),
  lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
});

describe('TrackingService vehicle identity resolution', () => {
  /* ---- A ---- */
  it('A. finds the existing vehicle by providerVehicleId and updates it', async () => {
    const store = makeStore([legitRow()]);
    const { service } = makeService(store, [transightPos()]);

    await service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows[0].id).toBe('cmsolbu900013htv0r6tnmpm1');
    expect(store.rows[0].speed).toBe(12);
  });

  /* ---- B ---- */
  it('B. providerVehicleId misses but IMEI matches → reuses the row, no duplicate', async () => {
    const store = makeStore([legitRow()]);
    // Inventory cache cold: the adapter substituted the IMEI for the vehicle_id.
    const { service } = makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
      }),
    ]);

    await service.syncVehicles();

    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1); // the duplicate that used to appear here
    expect(store.rows[0].id).toBe('cmsolbu900013htv0r6tnmpm1'); // same vehicle ID
    expect(store.rows[0].providerVehicleId).toBe('860560066144082'); // re-keyed
    expect(store.rows[0].speed).toBe(12); // and still received the position
  });

  it('B2. re-keys back to the real vehicle_id once inventory recovers, still one row', async () => {
    const store = makeStore([legitRow()]);

    // cycle 1: cold cache → IMEI key
    await makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
      }),
    ]).service.syncVehicles();
    // cycle 2: inventory back → real vehicle_id
    await makeService(store, [transightPos()]).service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].id).toBe('cmsolbu900013htv0r6tnmpm1');
    expect(store.rows[0].providerVehicleId).toBe('228068');
    expect(store.vehicle.create).not.toHaveBeenCalled();
  });

  /* ---- C ---- */
  it('C1. unknown vehicle on a FALLBACK identity → creates nothing, defers', async () => {
    const store = makeStore([]); // nothing to match
    const { service } = makeService(store, [
      transightPos({
        providerVehicleId: '999999999999999',
        imei: '999999999999999',
        identityIsFallback: true,
      }),
    ]);

    await service.syncVehicles();

    // A cold cache cannot tell "new vehicle" from "existing vehicle we failed to
    // resolve", so it must not guess — that guess is what created the 12 duplicates.
    expect(store.vehicle.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('C2. unknown vehicle on a PROVEN identity → still created (behaviour unchanged)', async () => {
    const store = makeStore([]);
    const { service } = makeService(store, [
      transightPos({ providerVehicleId: '228099', imei: '860560069999999' }),
    ]);

    await service.syncVehicles();

    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].clientId).toBeNull(); // lands as unassigned inventory
  });

  /* ---- D ---- */
  it('D. AiroTrack is unaffected — no IMEI, no fallback flag, creates and updates normally', async () => {
    const airoPos: NormalizedPosition = {
      providerName: 'airotrack',
      providerVehicleId: 'KL85B7233',
      vehicleNumber: 'KL85B7233',
      imei: null,
      gpsDeviceId: 'KL85B7233',
      latitude: 11.05,
      longitude: 75.98,
      speed: 30,
      ignition: true,
      batteryVoltage: 28.1,
      charge: true,
      providerTimestamp: new Date(),
    };

    const store = makeStore([]);
    const first = makeService(store, [airoPos], 'AIROTRACK', 60);
    await first.service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].providerName).toBe('airotrack');

    // second cycle updates the same row rather than adding another
    const second = makeService(
      store,
      [{ ...airoPos, speed: 44 }],
      'AIROTRACK',
      60,
    );
    await second.service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].speed).toBe(44);
    expect(store.vehicle.create).toHaveBeenCalledTimes(1);
  });

  /* ---- E ---- */
  it('E. client assignment survives an IMEI re-key', async () => {
    const store = makeStore([legitRow()]);
    const { service } = makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
      }),
    ]);

    await service.syncVehicles();

    expect(store.rows[0].clientId).toBe('client-nesto');
    expect(store.rows[0].driverName).toBe('Real Driver');
    // the sync must never write clientId at all
    for (const call of store.vehicle.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('clientId');
    }
  });

  /* ---- F ---- */
  it('F. location history stays attached to the SAME vehicle id across a re-key', async () => {
    const store = makeStore([legitRow()]);

    // cycle 1 (proven identity) records history against the legit id
    await makeService(store, [transightPos()]).service.syncVehicles();
    // cycle 2 arrives with a fallback IMEI identity and moves far enough to persist
    await makeService(store, [
      transightPos({
        providerVehicleId: '860560066144082',
        identityIsFallback: true,
        latitude: 11.5,
        longitude: 76.5,
      }),
    ]).service.syncVehicles();

    expect(store.rows).toHaveLength(1);
    const id = store.rows[0].id;
    expect(id).toBe('cmsolbu900013htv0r6tnmpm1');
    expect(store.history.length).toBeGreaterThan(0);
    // every history point belongs to the one surviving vehicle
    expect(store.history.every((h) => h.vehicleId === id)).toBe(true);
  });
});
