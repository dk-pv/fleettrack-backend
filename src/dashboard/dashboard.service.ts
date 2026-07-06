import { Injectable } from '@nestjs/common';
import { Prisma, TripStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getVehicleStatus } from '../common/utils/vehicle-status';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Trip summary counts for the dashboard (DSH-01.1). One grouped query over the
   * existing Trip.status; the lifecycle statuses are folded into the four dashboard
   * buckets. Scoped by clientId the same way as the other dashboard stats (the
   * controller pins a CLIENT to its own id). No new schema, no per-trip work.
   *
   * Buckets mirror TRIP_SUMMARY_BUCKETS on the frontend so the card counts match
   * the drill-down filter (`delayed` = the DELAYED lifecycle status, which is what
   * the drill-down list filters on — not the on-the-fly ETA-05.1 prediction).
   */
  async getTripSummary(clientId?: string) {
    const where: Prisma.TripWhereInput = clientId ? { clientId } : {};

    const grouped = await this.prisma.trip.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    const countOf = (status: TripStatus) =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;

    return {
      success: true,
      data: {
        active:
          countOf(TripStatus.STARTED) +
          countOf(TripStatus.ONGOING) +
          countOf(TripStatus.DELAYED),
        upcoming: countOf(TripStatus.PLANNED) + countOf(TripStatus.ASSIGNED),
        delayed: countOf(TripStatus.DELAYED),
        completed: countOf(TripStatus.COMPLETED),
      },
    };
  }

  async getDashboardStats(clientId?: string) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: clientId
        ? {
            clientId,
          }
        : undefined,
    });

    let totalVehicles = vehicles.length;
    let activeVehicles = 0;
    let offlineVehicles = 0;
    let idleVehicles = 0;

    vehicles.forEach((vehicle) => {
      const status = getVehicleStatus(
        vehicle.ignition,
        vehicle.speed,
      );

      if (status === 'MOVING') {
        activeVehicles++;
      }

      if (status === 'IDLE') {
        idleVehicles++;
      }

      if (status === 'OFFLINE') {
        offlineVehicles++;
      }
    });

    return {
      success: true,
      data: {
        totalVehicles,
        activeVehicles,
        offlineVehicles,
        idleVehicles,
      },
    };
  }

  async getActiveVehicles(clientId?: string) {
  const vehicles = await this.prisma.vehicle.findMany({
    where: {
      ...(clientId ? { clientId } : {}),
      ignition: true,
    },

    orderBy: {
      updatedAt: "desc",
    },

    take: 5,
  });

  const activeVehicles = vehicles.map((vehicle) => ({
    id: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    driverName: vehicle.driverName,
    speed: vehicle.speed,
    status: getVehicleStatus(
      vehicle.ignition,
      vehicle.speed
    ),
  }));

  return {
    success: true,
    data: activeVehicles,
  };
}
}