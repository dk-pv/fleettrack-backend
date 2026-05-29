import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VehiclesService {
  constructor(
    private prisma: PrismaService,
  ) {}

  async create(body: any) {
    const {
      vehicleName,
      vehicleNumber,
      gpsDeviceId,
      driverName,
      clientName,
      status,
      latitude,
      longitude,
      speed,
    } = body;

    const existingVehicle =
      await this.prisma.vehicle.findUnique({
        where: {
          vehicleNumber,
        },
      });

    if (existingVehicle) {
      throw new BadRequestException(
        'Vehicle number already exists',
      );
    }

    const vehicle =
      await this.prisma.vehicle.create({
        data: {
          vehicleName,
          vehicleNumber,
          gpsDeviceId,
          driverName,
          clientName,
          status,
          latitude,
          longitude,
          speed,
        },
      });

    return {
      success: true,
      vehicle,
    };
  }

  async findAll() {
    const vehicles =
      await this.prisma.vehicle.findMany({
        orderBy: {
          createdAt: 'desc',
        },
      });

    return {
      success: true,
      vehicles,
    };
  }

  async findOne(id: string) {
    const vehicle =
      await this.prisma.vehicle.findUnique({
        where: {
          id,
        },
      });

    if (!vehicle) {
      throw new NotFoundException(
        'Vehicle not found',
      );
    }

    return {
      success: true,
      vehicle,
    };
  }

  async update(
    id: string,
    body: any,
  ) {
    const existingVehicle =
      await this.prisma.vehicle.findUnique({
        where: {
          id,
        },
      });

    if (!existingVehicle) {
      throw new NotFoundException(
        'Vehicle not found',
      );
    }

    const updatedVehicle =
      await this.prisma.vehicle.update({
        where: {
          id,
        },

        data: {
          vehicleName:
            body.vehicleName,

          vehicleNumber:
            body.vehicleNumber,

          gpsDeviceId:
            body.gpsDeviceId,

          driverName:
            body.driverName,

          clientName:
            body.clientName,

          status: body.status,

          latitude:
            body.latitude,

          longitude:
            body.longitude,

          speed: body.speed,
        },
      });

    return {
      success: true,
      vehicle: updatedVehicle,
    };
  }

  async remove(id: string) {
    const existingVehicle =
      await this.prisma.vehicle.findUnique({
        where: {
          id,
        },
      });

    if (!existingVehicle) {
      throw new NotFoundException(
        'Vehicle not found',
      );
    }

    await this.prisma.vehicle.delete({
      where: {
        id,
      },
    });

    return {
      success: true,
      message:
        'Vehicle deleted successfully',
    };
  }
}