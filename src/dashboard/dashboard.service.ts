import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getVehicleStatus } from '../common/utils/vehicle-status';
@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /* -------------------------------- */
  /* DASHBOARD STATS */
  /* -------------------------------- */

  async getDashboardStats() {
    const vehicles = await this.prisma.vehicle.findMany();

    let totalVehicles = vehicles.length;

    let activeVehicles = 0;

    let offlineVehicles = 0;

    vehicles.forEach((vehicle) => {
      const status = getVehicleStatus(vehicle.ignition, vehicle.speed);

      if (status === 'MOVING' || status === 'IDLE') {
        activeVehicles++;
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
      },
    };
  }

  /* -------------------------------- */
  async getActiveVehicles() {
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: {
        updatedAt: 'desc',
      },

      take: 5,
    });

    const activeVehicles = vehicles
      .map((vehicle) => {
        const status = getVehicleStatus(vehicle.ignition, vehicle.speed);

        return {
          id: vehicle.id,

          vehicleNumber: vehicle.vehicleNumber,

          driverName: vehicle.driverName,

          speed: vehicle.speed,

          status,
        };
      })

      .filter((vehicle) => vehicle.status !== 'OFFLINE');

    return {
      success: true,

      data: activeVehicles,
    };
  } 
}
