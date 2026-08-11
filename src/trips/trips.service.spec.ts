import { BadRequestException } from '@nestjs/common';
import { TripsService } from './trips.service';

/**
 * Security guard: a CLIENT must not attach a vehicle it does not own to a trip —
 * that would leak the vehicle's live position/ETA/breadcrumbs through the trip read
 * endpoints (e.g. GET /trips/:id/progress). Only the reject path is exercised: it is
 * the assertion that fails if assertOwnedVehicle is ever dropped from create()/update().
 */
function makeService(ownedVehicle: any, trip?: any) {
  const prisma: any = {
    vehicle: { findFirst: jest.fn().mockResolvedValue(ownedVehicle) },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cust' }) },
    trip: { findUnique: jest.fn().mockResolvedValue(trip ?? null) },
  };
  // geocoding + notifications are never reached on the reject path.
  return new TripsService(prisma, {} as any, {} as any);
}

const user = { userId: 'client-1', role: 'CLIENT' } as any;

describe('TripsService vehicle-ownership guard', () => {
  it('create rejects a vehicle the client does not own (400 INVALID_VEHICLE)', async () => {
    const service = makeService(null); // {id, clientId} finds nothing → not owned
    await expect(
      service.create(user, { vehicleId: 'v-other' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update rejects re-linking a vehicle the client does not own', async () => {
    const service = makeService(null, { id: 't1', clientId: 'client-1' });
    await expect(
      service.update(user, 't1', { vehicleId: 'v-other' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
