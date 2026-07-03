import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getVehicleStatus } from '../common/utils/vehicle-status';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

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