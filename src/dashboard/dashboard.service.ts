import { Injectable } from '@nestjs/common';
import { Prisma, TripStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getVehicleStatus } from '../common/utils/vehicle-status';
import {
  detectDelay,
  DEFAULT_DELAY_MARGIN_MINUTES,
} from '../trips/trip-delay.util';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Delivery performance metrics (DSH-04.1). Historical on-time vs delayed split
   * over COMPLETED trips: the actual completedAt is compared to scheduledEnd via
   * the same ETA-05.1 delay rule (detectDelay + DEFAULT_DELAY_MARGIN_MINUTES), so a
   * "delayed delivery" means the same thing as everywhere else in the app. Scoped
   * by clientId like the other dashboard stats. Two queries — a count plus one
   * narrow findMany of completed trips' timestamps — so no N+1 and no per-trip work.
   *
   * The DELAYED lifecycle status is deliberately NOT used: a completed trip's status
   * is COMPLETED (DELAYED is a transient in-transit state), so only completedAt vs
   * scheduledEnd measures whether a delivery actually arrived late.
   */
  async getDeliveryMetrics(clientId?: string) {
    const where: Prisma.TripWhereInput = clientId ? { clientId } : {};

    const [total, completedTrips] = await Promise.all([
      this.prisma.trip.count({ where }),
      this.prisma.trip.findMany({
        where: { ...where, status: TripStatus.COMPLETED },
        select: { scheduledEnd: true, completedAt: true },
      }),
    ]);

    const completed = completedTrips.length;
    let delayed = 0;
    for (const trip of completedTrips) {
      // completedAt is stamped on the COMPLETED transition; fall back defensively.
      const arrival = trip.completedAt ?? trip.scheduledEnd;
      if (
        detectDelay(trip.scheduledEnd, arrival, DEFAULT_DELAY_MARGIN_MINUTES)
          .isDelayed
      ) {
        delayed += 1;
      }
    }
    const onTime = completed - delayed;

    const pct = (part: number, whole: number) =>
      whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

    return {
      success: true,
      data: {
        total,
        completed,
        onTime,
        delayed,
        completionRate: pct(completed, total),
        onTimeRate: pct(onTime, completed),
        delayedRate: pct(delayed, completed),
      },
    };
  }

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