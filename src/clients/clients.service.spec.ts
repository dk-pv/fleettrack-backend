import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ClientsService } from './clients.service';

// Hashing is not under test — stub it so the specs stay fast and deterministic.
jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed-pw') }));

const createdClient = {
  id: 'c1',
  name: 'Client A',
  email: 'a@x.com',
  password: 'hashed-pw',
  apiUrl: '',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeService(opts: {
  existingEmail?: boolean;
  findMany?: any[];
  updateCount?: number;
  clientExists?: boolean;
  activeTrip?: boolean;
} = {}) {
  const activeTrip = opts.activeTrip
    ? { id: 't1', vehicle: { vehicleNumber: 'A1' } }
    : null;
  const tx = {
    client: {
      create: jest.fn().mockResolvedValue(createdClient),
      update: jest.fn().mockResolvedValue(createdClient),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue(opts.findMany ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount ?? 0 }),
    },
    trip: { findFirst: jest.fn().mockResolvedValue(activeTrip) },
  };
  const prisma: any = {
    client: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.existingEmail || opts.clientExists ? { id: 'c1' } : null,
        ),
      delete: jest.fn().mockResolvedValue({}),
    },
    trip: {
      findFirst: jest.fn().mockResolvedValue(activeTrip),
    },
    $transaction: jest.fn((cb: any) => cb(tx)),
  };
  return { service: new ClientsService(prisma), prisma, tx };
}

const dto = (vehicleIds: string[] = []) => ({
  name: 'Client A',
  email: 'a@x.com',
  password: 'secret6',
  vehicleIds,
});

describe('ClientsService.create', () => {
  it('assigns selected vehicles atomically and returns a password-free client', async () => {
    const { service, tx } = makeService({
      findMany: [
        { id: 'v1', clientId: null, vehicleNumber: 'A1' },
        { id: 'v2', clientId: null, vehicleNumber: 'A2' },
      ],
      updateCount: 2,
    });

    const res = await service.create(dto(['v1', 'v2']) as any);

    expect(res.success).toBe(true);
    expect(res.client).toEqual(
      expect.objectContaining({ id: 'c1', email: 'a@x.com' }),
    );
    expect((res.client as any).password).toBeUndefined();
    expect((res.client as any).apiUrl).toBeUndefined();
    expect(tx.vehicle.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['v1', 'v2'] }, clientId: null },
      data: { clientId: 'c1' },
    });
  });

  it('409 when a selected vehicle is already assigned (no update attempted)', async () => {
    const { service, tx } = makeService({
      findMany: [{ id: 'v1', clientId: 'other', vehicleNumber: 'A1' }],
    });
    await expect(service.create(dto(['v1']) as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('400 when a selected vehicle does not exist', async () => {
    const { service } = makeService({ findMany: [] });
    await expect(service.create(dto(['vX']) as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400 for a restricted vehicle, exactly like a missing one (nothing assigned)', async () => {
    const { service, tx } = makeService({
      findMany: [{ id: 'vr', clientId: null, vehicleNumber: 'KL85B1418' }],
    });
    await expect(service.create(dto(['vr']) as any)).rejects.toThrow(
      'One or more selected vehicles do not exist',
    );
    expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('409 (rollback) on a concurrent-assign race (updated count mismatch)', async () => {
    const { service } = makeService({
      findMany: [{ id: 'v1', clientId: null, vehicleNumber: 'A1' }],
      updateCount: 0,
    });
    await expect(service.create(dto(['v1']) as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('400 on duplicate email, without opening a transaction', async () => {
    const { service, prisma } = makeService({ existingEmail: true });
    await expect(service.create(dto([]) as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates with no vehicles when none selected', async () => {
    const { service, tx } = makeService();
    const res = await service.create(dto([]) as any);
    expect(res.success).toBe(true);
    expect(tx.vehicle.findMany).not.toHaveBeenCalled();
  });
});

describe('ClientsService.update', () => {
  it('leaves vehicle assignments untouched when vehicleIds is omitted', async () => {
    const { service, tx } = makeService({ clientExists: true });

    const res = await service.update('c1', {
      name: 'Client B',
      email: 'b@x.com',
    });

    expect(res.success).toBe(true);
    expect(res.client).not.toHaveProperty('password');
    expect(tx.client.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Client B', email: 'b@x.com' },
    });
    expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('makes vehicleIds the full set: unassigns the rest, keeps own, assigns new', async () => {
    const { service, tx } = makeService({
      clientExists: true,
      findMany: [
        { id: 'v1', clientId: 'c1', vehicleNumber: 'A1' },
        { id: 'v2', clientId: null, vehicleNumber: 'A2' },
      ],
      updateCount: 1,
    });

    await service.update('c1', { vehicleIds: ['v1', 'v2', 'v2'] });

    expect(tx.vehicle.updateMany).toHaveBeenNthCalledWith(1, {
      where: { clientId: 'c1', id: { notIn: ['v1', 'v2', 'v2'] } },
      data: { clientId: null },
    });
    expect(tx.vehicle.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['v2'] }, clientId: null },
      data: { clientId: 'c1' },
    });
  });

  it('an empty list unassigns every vehicle and deletes none', async () => {
    const { service, tx } = makeService({ clientExists: true });

    await service.update('c1', { vehicleIds: [] });

    expect(tx.vehicle.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.vehicle.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'c1', id: { notIn: [] } },
      data: { clientId: null },
    });
    // The only lookup is the restricted-vehicle check; nothing is assigned.
    expect(tx.vehicle.findMany).toHaveBeenCalledTimes(1);
    expect(tx.vehicle.findMany).toHaveBeenCalledWith({
      where: { clientId: 'c1' },
      select: { id: true, vehicleNumber: true },
    });
  });

  it('never unassigns a restricted vehicle the client still holds', async () => {
    const { service, tx } = makeService({
      clientExists: true,
      findMany: [{ id: 'vr', clientId: 'c1', vehicleNumber: 'KL 85 B 1418' }],
    });

    await service.update('c1', { vehicleIds: [] });

    expect(tx.vehicle.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'c1', id: { notIn: ['vr'] } },
      data: { clientId: null },
    });
  });

  it("409 when a vehicle is another client's (client left unchanged)", async () => {
    const { service, tx } = makeService({
      clientExists: true,
      findMany: [{ id: 'v9', clientId: 'other', vehicleNumber: 'B9' }],
    });

    await expect(
      service.update('c1', { vehicleIds: ['v9'] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.client.update).not.toHaveBeenCalled();
  });

  it('409 when removing a vehicle on an active trip (nothing unassigned)', async () => {
    const { service, tx } = makeService({
      clientExists: true,
      activeTrip: true,
    });

    await expect(service.update('c1', { vehicleIds: [] })).rejects.toThrow(
      'A1 is on an active trip',
    );
    expect(tx.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('404 when the client does not exist (nothing written)', async () => {
    const { service, tx } = makeService({ clientExists: false });

    await expect(service.update('nope', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.client.update).not.toHaveBeenCalled();
  });
});

describe('ClientsService.remove', () => {
  it('409 when the client has an active trip (vehicle stays put, not deleted)', async () => {
    const { service, prisma } = makeService({ clientExists: true, activeTrip: true });
    await expect(service.remove('c1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.client.delete).not.toHaveBeenCalled();
  });

  it('deletes the client when no active trip', async () => {
    const { service, prisma } = makeService({ clientExists: true, activeTrip: false });
    const res = await service.remove('c1');
    expect(res.success).toBe(true);
    expect(prisma.client.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });

  it('404 when the client does not exist', async () => {
    const { service } = makeService({ clientExists: false });
    await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
