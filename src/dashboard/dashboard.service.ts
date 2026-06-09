
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
  ) {}

  async getDashboardData() {
    /* ----------------------------- */
    /* VEHICLE COUNTS */
    /* ----------------------------- */

    const totalVehicles =
      await this.prisma.vehicle.count();

    const activeVehicles =
      await this.prisma.vehicle.count({
        where: {
          status: 'MOVING',
        },
      });

    const offlineVehicles =
      await this.prisma.vehicle.count({
        where: {
          status: 'OFFLINE',
        },
      });

    /* ----------------------------- */
    /* WEEKLY ACTIVITY */
    /* ----------------------------- */

    const weeklyActivity = [
      {
        day: 'Mon',
        value: 40,
      },
      {
        day: 'Tue',
        value: 55,
      },
      {
        day: 'Wed',
        value: 48,
      },
      {
        day: 'Thu',
        value: 70,
      },
      {
        day: 'Fri',
        value: 62,
      },
      {
        day: 'Sat',
        value: 30,
      },
      {
        day: 'Sun',
        value: 18,
      },
    ];

    /* ----------------------------- */
    /* ACTIVE VEHICLES */
    /* ----------------------------- */

    const recentVehicles =
      await this.prisma.vehicle.findMany({
        take: 5,

        orderBy: {
          updatedAt: 'desc',
        },

        select: {
          id: true,

          vehicleNumber: true,

          driverName: true,

          speed: true,

          status: true,
        },
      });

    return {
      success: true,

      stats: {
        totalVehicles,

        activeVehicles,

        offlineVehicles,
      },

      weeklyActivity,

      activeVehiclesList:
        recentVehicles,
    };
  }
}
