import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestsController } from './trip-requests.controller';
import { TripsService } from '../trips/trips.service';
import { RolesGuard } from '../auth/roles.guard';
import { CreateTripDto } from '../trips/dto/create-trip.dto';

/**
 * Slice 1 — request creation + ownership-scoped reads. A real TripsService (for its
 * ownership checks) runs over a mocked Prisma that the request service shares; ownership
 * is driven by what customer/vehicle findFirst return (a row = owned, null = not owned).
 * No Trip is ever created in Slice 1 (prisma.trip.create must stay untouched).
 */
function makeService(
  opts: { customer?: any; vehicle?: any; found?: any; list?: any[] } = {},
) {
  const prisma: any = {
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue('customer' in opts ? opts.customer : { id: 'cust' }),
    },
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue('vehicle' in opts ? opts.vehicle : { id: 'veh' }),
    },
    tripRequest: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'req1', ...data }),
        ),
      findMany: jest.fn().mockResolvedValue(opts.list ?? []),
      findUnique: jest.fn().mockResolvedValue(opts.found ?? null),
    },
    trip: { create: jest.fn() }, // must NEVER be called in Slice 1
  };
  const notifications = {
    onTripRequested: jest.fn().mockResolvedValue({ id: 'n1' }),
    onTripRequestApproved: jest.fn().mockResolvedValue({ id: 'n2' }),
    onTripRequestRejected: jest.fn().mockResolvedValue({ id: 'n3' }),
  };
  const trips = new TripsService(prisma, {} as any, notifications as any);
  const service = new TripRequestsService(prisma, trips, notifications as any);
  return { service, prisma, notifications };
}

const clientUser = { userId: 'client-1', role: 'CLIENT' } as any;
const adminUser = { userId: 'admin-1', role: 'ADMIN' } as any;

const baseDto = (over: Partial<CreateTripDto> = {}): CreateTripDto =>
  ({
    vehicleId: 'veh-1',
    driverId: 'drv:john',
    driverName: 'John',
    customerId: 'cust-1',
    origin: 'A',
    destination: 'B',
    scheduledStart: '2026-09-01T08:00:00.000Z',
    scheduledEnd: '2026-09-01T12:00:00.000Z',
    ...over,
  }) as CreateTripDto;

describe('TripRequestsService.create', () => {
  it('creates a PENDING request and does NOT create a Trip', async () => {
    const { service, prisma } = makeService();
    const res = await service.create(clientUser, baseDto());
    expect(res.success).toBe(true);
    expect(res.request.status).toBe('PENDING');
    expect(prisma.tripRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('derives clientId from the JWT, ignoring any clientId in the body', async () => {
    const { service, prisma } = makeService();
    await service.create(
      clientUser,
      baseDto({ clientId: 'attacker-client' } as any),
    );
    expect(prisma.tripRequest.create.mock.calls[0][0].data.clientId).toBe(
      'client-1',
    );
  });

  it('rejects a vehicle the client does not own (no request persisted)', async () => {
    const { service, prisma } = makeService({ vehicle: null });
    await expect(service.create(clientUser, baseDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tripRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a customer the client does not own (no request persisted)', async () => {
    const { service, prisma } = makeService({ customer: null });
    await expect(service.create(clientUser, baseDto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tripRequest.create).not.toHaveBeenCalled();
  });

  it('defaults the persisted status to PENDING', async () => {
    const { service, prisma } = makeService();
    await service.create(clientUser, baseDto());
    expect(prisma.tripRequest.create.mock.calls[0][0].data.status).toBe(
      'PENDING',
    );
  });
});

describe('TripRequestsService reads', () => {
  it('scopes a CLIENT list to its own requests (cannot list all like an admin)', async () => {
    const { service, prisma } = makeService();
    await service.findAll(clientUser);
    expect(prisma.tripRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client-1' } }),
    );
  });

  it('lets an ADMIN list all requests (unscoped)', async () => {
    const { service, prisma } = makeService();
    await service.findAll(adminUser);
    expect(prisma.tripRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it("forbids a CLIENT from reading another client's request", async () => {
    const { service } = makeService({
      found: { id: 'req1', clientId: 'other-client' },
    });
    await expect(service.findOne(clientUser, 'req1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets an ADMIN read any request', async () => {
    const { service } = makeService({
      found: { id: 'req1', clientId: 'other-client' },
    });
    const res = await service.findOne(adminUser, 'req1');
    expect(res.success).toBe(true);
  });

  it('404s an unknown request', async () => {
    const { service } = makeService({ found: null });
    await expect(service.findOne(clientUser, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('request payload validation (reused CreateTripDto rules)', () => {
  it('rejects a payload missing the required trip fields', async () => {
    const dto = plainToInstance(CreateTripDto, {});
    const invalid = new Set((await validate(dto)).map((e) => e.property));
    expect(invalid.has('origin')).toBe(true);
    expect(invalid.has('destination')).toBe(true);
    expect(invalid.has('scheduledStart')).toBe(true);
    expect(invalid.has('scheduledEnd')).toBe(true);
  });
});

/* ================================================================ */
/* Slice 2 — approve / reject                                        */
/* ================================================================ */

/**
 * A fuller harness for approval/rejection: a real TripsService (so approval genuinely
 * re-runs ownership + overlap revalidation + create) over a mocked Prisma + geocoding,
 * plus a mocked NotificationsService whose triggers we assert on. Ownership is driven by
 * customer/vehicle findFirst (a row = owned, null = not owned); overlap by trip.findMany;
 * the atomic claim by tripRequest.updateMany's `count`. Request coords are supplied so
 * trips.create never needs geocoding.
 */
function makeApproval(opts: any = {}) {
  const request = {
    id: 'req1',
    status: 'PENDING',
    clientId: 'client-1',
    reference: null,
    vehicleId: 'veh-1',
    driverId: 'drv:john',
    driverName: 'John',
    customerId: 'cust-1',
    origin: 'Kochi',
    destination: 'Calicut',
    originLat: 9.93,
    originLng: 76.26,
    destinationLat: 11.25,
    destinationLng: 75.78,
    stops: null,
    distanceKm: 180,
    durationMins: 240,
    notes: null,
    scheduledStart: new Date('2026-09-01T08:00:00.000Z'),
    scheduledEnd: new Date('2026-09-01T12:00:00.000Z'),
    tripId: null,
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    ...(opts.request ?? {}),
  };

  const prisma: any = {
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue('customer' in opts ? opts.customer : { id: 'cust-1' }),
    },
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue('vehicle' in opts ? opts.vehicle : { id: 'veh-1' }),
    },
    client: { findUnique: jest.fn().mockResolvedValue({ name: 'Client One' }) },
    trip: {
      findMany: jest.fn().mockResolvedValue(opts.overlap ?? []),
      create:
        opts.tripCreate ??
        jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: 'trip-99', ...data, stops: [] }),
          ),
    },
    tripRequest: {
      findUnique: jest.fn().mockResolvedValue(request),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      update: opts.updateFail
        ? jest.fn().mockRejectedValue(new Error('meta write failed'))
        : jest
            .fn()
            .mockImplementation(({ data }: any) =>
              Promise.resolve({ ...request, status: 'APPROVED', ...data }),
            ),
    },
  };
  const geocoding = { geocode: jest.fn().mockResolvedValue({ lat: 0, lng: 0 }) };
  const notifications = {
    onTripRequested: jest.fn().mockResolvedValue({ id: 'n1' }),
    onTripRequestApproved: jest.fn().mockResolvedValue({ id: 'n2' }),
    onTripRequestRejected: jest.fn().mockResolvedValue({ id: 'n3' }),
  };
  const trips = new TripsService(prisma, geocoding as any, notifications as any);
  const service = new TripRequestsService(prisma, trips, notifications as any);
  return { service, prisma, notifications, request };
}

/** A fake ExecutionContext targeting one controller handler, for the RolesGuard. */
function guardCtx(handler: any, user: any) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => TripRequestsController,
  } as any;
}

describe('create() fires the TRIP_REQUESTED admin notification', () => {
  it('notifies the ADMIN audience when a request is created', async () => {
    const { service, notifications } = makeService();
    await service.create(clientUser, baseDto());
    expect(notifications.onTripRequested).toHaveBeenCalledTimes(1);
    expect(notifications.onTripRequested.mock.calls[0][0]).toEqual(
      expect.objectContaining({ clientId: 'client-1' }),
    );
    // No client-facing approval/rejection notification on mere creation.
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
    expect(notifications.onTripRequestRejected).not.toHaveBeenCalled();
  });
});

describe('TripRequestsService.approve', () => {
  it('lets an ADMIN approve a PENDING request', async () => {
    const { service } = makeApproval();
    const res = await service.approve(adminUser, 'req1');
    expect(res.success).toBe(true);
    expect(res.request.status).toBe('APPROVED');
  });

  it('forbids a CLIENT from approving (approve route is ADMIN-only)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.approve, { role: 'CLIENT' }),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.approve, { role: 'ADMIN' }),
      ),
    ).toBe(true);
  });

  it('cannot approve an already-APPROVED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'APPROVED' } });
    await expect(service.approve(adminUser, 'req1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('cannot approve a REJECTED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'REJECTED' } });
    await expect(service.approve(adminUser, 'req1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('creates exactly one Trip', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1');
    expect(prisma.trip.create).toHaveBeenCalledTimes(1);
  });

  it('creates the Trip in ASSIGNED status (vehicle + driver present)', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1');
    expect(prisma.trip.create.mock.calls[0][0].data.status).toBe('ASSIGNED');
  });

  it('stores the created tripId on the request', async () => {
    const { service, prisma } = makeApproval();
    const res = await service.approve(adminUser, 'req1');
    expect(prisma.tripRequest.update.mock.calls[0][0].data.tripId).toBe(
      'trip-99',
    );
    expect(res.request.tripId).toBe('trip-99');
  });

  it('stores the reviewer id and review timestamp', async () => {
    const { service, prisma } = makeApproval();
    await service.approve(adminUser, 'req1');
    const data = prisma.tripRequest.update.mock.calls[0][0].data;
    expect(data.reviewedById).toBe('admin-1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('revalidates vehicle ownership against current state (rolls back if not owned)', async () => {
    const { service, prisma } = makeApproval({ vehicle: null });
    await expect(service.approve(adminUser, 'req1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Ownership was checked with the OWNING client, not the admin.
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      where: { id: 'veh-1', clientId: 'client-1' },
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    // Claim rolled back APPROVED → PENDING.
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('revalidates customer ownership against current state (rolls back if not owned)', async () => {
    const { service, prisma } = makeApproval({ customer: null });
    await expect(service.approve(adminUser, 'req1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'cust-1', clientId: 'client-1' },
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('revalidates vehicle overlap (rolls back on a new double-booking)', async () => {
    const { service, prisma } = makeApproval({
      overlap: [{ tripId: 't-x', reference: 'TRIP-X' }],
    });
    await expect(service.approve(adminUser, 'req1')).rejects.toMatchObject({
      message: 'VEHICLE_OVERLAP',
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('revalidates driver overlap (rolls back on a new double-booking)', async () => {
    const { service, prisma } = makeApproval({
      request: { vehicleId: null }, // isolate the driver overlap check
      overlap: [{ tripId: 't-y', reference: 'TRIP-Y' }],
    });
    await expect(service.approve(adminUser, 'req1')).rejects.toMatchObject({
      message: 'DRIVER_OVERLAP',
    });
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
  });

  it('rolls the request back to PENDING when Trip creation fails', async () => {
    const { service, prisma, notifications } = makeApproval({
      tripCreate: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(service.approve(adminUser, 'req1')).rejects.toThrow('db down');
    expect(prisma.tripRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'req1', status: 'APPROVED', tripId: null },
      data: { status: 'PENDING' },
    });
    // No approval notification when no Trip was created.
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
  });

  it('does NOT roll back to PENDING when metadata persistence fails AFTER Trip creation', async () => {
    const { service, prisma, notifications } = makeApproval({ updateFail: true });
    // The metadata write throws, and that error surfaces to the caller.
    await expect(service.approve(adminUser, 'req1')).rejects.toThrow(
      'meta write failed',
    );
    // The Trip was created exactly once.
    expect(prisma.trip.create).toHaveBeenCalledTimes(1);
    // The ONLY updateMany was the APPROVED claim — there is NO revert-to-PENDING call.
    expect(prisma.tripRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.tripRequest.updateMany.mock.calls[0][0].data).toEqual({
      status: 'APPROVED',
    });
    const revertedToPending = prisma.tripRequest.updateMany.mock.calls.some(
      (c: any[]) => c[0]?.data?.status === 'PENDING',
    );
    expect(revertedToPending).toBe(false);
    // Best-effort notification never fired (the error was thrown before it).
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
  });

  it('a re-approval after a metadata failure cannot create a duplicate Trip (request stays APPROVED)', async () => {
    // After the metadata-write failure the row is APPROVED in the DB. A retry sees APPROVED
    // and 409s WITHOUT creating a second Trip — the duplicate-Trip invariant holds.
    const { service, prisma } = makeApproval({ request: { status: 'APPROVED' } });
    await expect(service.approve(adminUser, 'req1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('a losing concurrent approval (claim count 0) creates no Trip and 409s', async () => {
    const { service, prisma, notifications } = makeApproval({ claimCount: 0 });
    await expect(service.approve(adminUser, 'req1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.trip.create).not.toHaveBeenCalled();
    expect(notifications.onTripRequestApproved).not.toHaveBeenCalled();
  });

  it('notifies the requesting CLIENT only after the Trip is created', async () => {
    const { service, notifications } = makeApproval();
    await service.approve(adminUser, 'req1');
    expect(notifications.onTripRequestApproved).toHaveBeenCalledTimes(1);
    const [reqArg, tripIdArg] =
      notifications.onTripRequestApproved.mock.calls[0];
    expect(reqArg.clientId).toBe('client-1');
    expect(tripIdArg).toBe('trip-99');
  });
});

describe('TripRequestsService.reject', () => {
  it('lets an ADMIN reject a PENDING request', async () => {
    const { service, prisma } = makeApproval();
    const res = await service.reject(adminUser, 'req1', 'No capacity');
    expect(res.success).toBe(true);
    expect(prisma.tripRequest.updateMany.mock.calls[0][0].data.status).toBe(
      'REJECTED',
    );
  });

  it('forbids a CLIENT from rejecting (reject route is ADMIN-only)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.reject, { role: 'CLIENT' }),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        guardCtx(TripRequestsController.prototype.reject, { role: 'ADMIN' }),
      ),
    ).toBe(true);
  });

  it('rejects a missing reason (no claim written)', async () => {
    const { service, prisma } = makeApproval();
    await expect(
      service.reject(adminUser, 'req1', undefined as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only reason (no claim written)', async () => {
    const { service, prisma } = makeApproval();
    await expect(service.reject(adminUser, 'req1', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('stores the trimmed reason, reviewer id and timestamp', async () => {
    const { service, prisma } = makeApproval();
    await service.reject(adminUser, 'req1', '  No capacity  ');
    const data = prisma.tripRequest.updateMany.mock.calls[0][0].data;
    expect(data.rejectionReason).toBe('No capacity');
    expect(data.reviewedById).toBe('admin-1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('creates no Trip on rejection', async () => {
    const { service, prisma } = makeApproval();
    await service.reject(adminUser, 'req1', 'No capacity');
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('cannot reject an already-APPROVED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'APPROVED' } });
    await expect(
      service.reject(adminUser, 'req1', 'too late'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('cannot reject an already-REJECTED request', async () => {
    const { service, prisma } = makeApproval({ request: { status: 'REJECTED' } });
    await expect(
      service.reject(adminUser, 'req1', 'again'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tripRequest.updateMany).not.toHaveBeenCalled();
  });

  it('notifies the requesting CLIENT of the rejection', async () => {
    const { service, notifications } = makeApproval();
    await service.reject(adminUser, 'req1', 'No capacity');
    expect(notifications.onTripRequestRejected).toHaveBeenCalledTimes(1);
    expect(notifications.onTripRequestRejected.mock.calls[0][0]).toEqual(
      expect.objectContaining({ clientId: 'client-1', rejectionReason: 'No capacity' }),
    );
  });
});
