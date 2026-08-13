import { DashboardService } from './dashboard.service';

/**
 * Weekly activity (DSH-05). The day buckets are computed in Asia/Kolkata (+05:30),
 * deliberately NOT in the server's local timezone, so these assertions must hold no
 * matter which timezone the test machine runs in — that is exactly what they guard.
 *
 * The harness asserts on the `where` handed to Prisma as well as on the output, so a
 * future change cannot start pulling the whole trip table and bucketing it in memory.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** An instant that falls on the given Asia/Kolkata calendar date at `hh:mm` IST. */
function istInstant(dateKey: string, hh = 12, mm = 0): Date {
  return new Date(
    Date.parse(`${dateKey}T00:00:00.000Z`) -
      IST_OFFSET_MS +
      hh * 60 * 60 * 1000 +
      mm * 60 * 1000,
  );
}

/** The Asia/Kolkata calendar date an instant falls on. */
function istKey(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function makeService(scheduledStarts: Date[] = []) {
  const findMany = jest
    .fn()
    .mockResolvedValue(scheduledStarts.map((scheduledStart) => ({ scheduledStart })));
  const prisma: any = { trip: { findMany } };
  return { service: new DashboardService(prisma), findMany };
}

const argsOf = (findMany: jest.Mock) =>
  findMany.mock.calls[0][0] as {
    where: { clientId?: string; scheduledStart: { gte: Date; lt: Date } };
    select: Record<string, boolean>;
  };

const today = istKey(new Date());
const daysAgo = (n: number) => istKey(new Date(Date.now() - n * DAY_MS));

describe('DashboardService.getWeeklyActivity', () => {
  it('always returns exactly 7 buckets, oldest → newest, ending today', async () => {
    const { service } = makeService();
    const { data } = await service.getWeeklyActivity();

    expect(data.days).toHaveLength(7);
    expect(data.days[6].date).toBe(today);
    expect(data.days[0].date).toBe(daysAgo(6));

    const dates = data.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates); // ascending
  });

  it('zero-fills days that have no trips', async () => {
    const { service } = makeService([]);
    const { data } = await service.getWeeklyActivity();
    expect(data.days.every((d) => d.value === 0)).toBe(true);
  });

  it('buckets trips onto the correct Asia/Kolkata day', async () => {
    const { service } = makeService([
      istInstant(today, 9),
      istInstant(today, 18),
      istInstant(daysAgo(2), 11),
    ]);
    const { data } = await service.getWeeklyActivity();

    const valueOn = (date: string) =>
      data.days.find((d) => d.date === date)?.value;

    expect(valueOn(today)).toBe(2);
    expect(valueOn(daysAgo(2))).toBe(1);
    expect(valueOn(daysAgo(1))).toBe(0);
  });

  it('respects the IST day boundary, not the UTC one', async () => {
    // 00:30 IST today is 19:00 UTC *yesterday* — it must bucket as today.
    const { service } = makeService([istInstant(today, 0, 30)]);
    const { data } = await service.getWeeklyActivity();

    expect(data.days.find((d) => d.date === today)?.value).toBe(1);
    expect(data.days.find((d) => d.date === daysAgo(1))?.value).toBe(0);
  });

  it('queries a bounded rolling 7-day window covering today', async () => {
    const { service, findMany } = makeService();
    await service.getWeeklyActivity();

    const { where, select } = argsOf(findMany);
    expect(select).toEqual({ scheduledStart: true });

    // Window spans exactly 7 days and ends after "now".
    const span = where.scheduledStart.lt.getTime() - where.scheduledStart.gte.getTime();
    expect(span).toBe(7 * DAY_MS);
    expect(where.scheduledStart.lt.getTime()).toBeGreaterThan(Date.now());
    expect(istKey(where.scheduledStart.gte)).toBe(daysAgo(6));
  });

  it('a trip outside the window never creates an 8th bucket', async () => {
    const { service } = makeService([istInstant(daysAgo(30), 12)]);
    const { data } = await service.getWeeklyActivity();

    expect(data.days).toHaveLength(7);
    expect(data.days.every((d) => d.value === 0)).toBe(true);
  });

  it('ADMIN with no selected client queries fleet-wide (no clientId filter)', async () => {
    const { service, findMany } = makeService();
    await service.getWeeklyActivity(undefined);
    expect(argsOf(findMany).where.clientId).toBeUndefined();
  });

  it('ADMIN with a selected client scopes to that client', async () => {
    const { service, findMany } = makeService();
    await service.getWeeklyActivity('client-A');
    expect(argsOf(findMany).where.clientId).toBe('client-A');
  });

  it('reports the timezone the buckets were computed in', async () => {
    const { service } = makeService();
    const { data } = await service.getWeeklyActivity();
    expect(data.timeZone).toBe('Asia/Kolkata');
  });
});

/**
 * Tenant scoping lives in the controller for every dashboard endpoint (a CLIENT is
 * pinned to req.user.userId before the service is called), so it is asserted there —
 * the service receives an already-resolved id and must simply honour it.
 */
describe('DashboardController weekly-activity scoping', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    DashboardController,
  } = require('./dashboard.controller') as typeof import('./dashboard.controller');

  function makeController() {
    const getWeeklyActivity = jest.fn().mockResolvedValue({ success: true });
    const service: any = { getWeeklyActivity };
    return { controller: new DashboardController(service), getWeeklyActivity };
  }

  it('CLIENT is pinned to its own id and cannot override it via ?clientId', async () => {
    const { controller, getWeeklyActivity } = makeController();
    await controller.getWeeklyActivity(
      { user: { userId: 'client-1', role: 'CLIENT' } } as any,
      'client-OTHER',
    );
    expect(getWeeklyActivity).toHaveBeenCalledWith('client-1');
  });

  it('ADMIN may scope to a selected client', async () => {
    const { controller, getWeeklyActivity } = makeController();
    await controller.getWeeklyActivity(
      { user: { userId: 'admin-1', role: 'ADMIN' } } as any,
      'client-A',
    );
    expect(getWeeklyActivity).toHaveBeenCalledWith('client-A');
  });

  it('ADMIN with no selection stays fleet-wide', async () => {
    const { controller, getWeeklyActivity } = makeController();
    await controller.getWeeklyActivity(
      { user: { userId: 'admin-1', role: 'ADMIN' } } as any,
      undefined,
    );
    expect(getWeeklyActivity).toHaveBeenCalledWith(undefined);
  });
});
