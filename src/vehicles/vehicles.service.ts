import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';

@Injectable()
export class VehiclesService {
  constructor(
    private prisma: PrismaService,
    private trackingGateway: TrackingGateway,
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

    const existingVehicle = await this.prisma.vehicle.findUnique({
      where: {
        vehicleNumber,
      },
    });

    if (existingVehicle) {
      throw new BadRequestException('Vehicle number already exists');
    }

    const vehicle = await this.prisma.vehicle.create({
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
    const vehicles = await this.prisma.vehicle.findMany({
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
    const vehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    return {
      success: true,
      vehicle,
    };
  }

  async update(id: string, body: any) {
    const existingVehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
    });

    if (!existingVehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    const updatedVehicle = await this.prisma.vehicle.update({
      where: {
        id,
      },

      data: {
        vehicleName: body.vehicleName,

        vehicleNumber: body.vehicleNumber,

        gpsDeviceId: body.gpsDeviceId,

        driverName: body.driverName,

        clientName: body.clientName,

        status: body.status,

        latitude: body.latitude,

        longitude: body.longitude,

        speed: body.speed,
      },
    });

    return {
      success: true,
      vehicle: updatedVehicle,
    };
  }

  async remove(id: string) {
    const existingVehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
    });

    if (!existingVehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    await this.prisma.vehicle.delete({
      where: {
        id,
      },
    });

    return {
      success: true,
      message: 'Vehicle deleted successfully',
    };
  }

  async updateLocation(id: string, body: any) {
    const existingVehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
    });

    if (!existingVehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    const updatedVehicle = await this.prisma.vehicle.update({
      where: {
        id,
      },

      data: {
        latitude: body.latitude,

        longitude: body.longitude,

        speed: body.speed,

        status: body.status,
      },
    });

    this.trackingGateway.server.emit('vehicleLocationUpdate', updatedVehicle);

    return {
      success: true,

      vehicle: updatedVehicle,
    };
  }

  async generateVehicleReport(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: {
        id,
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    const doc = new PDFDocument({
      margin: 50,
    });

    const buffers: Uint8Array[] = [];

    doc.on('data', (chunk) => {
      buffers.push(chunk);
    });

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });

      // Title
      doc.fontSize(24).text('Fleet Vehicle Report', {
        align: 'center',
      });

      doc.moveDown(2);

      // Vehicle Details
      doc.fontSize(16).text(`Vehicle Name: ${vehicle.vehicleName}`);

      doc.moveDown();

      doc.text(`Vehicle Number: ${vehicle.vehicleNumber}`);

      doc.moveDown();

      doc.text(`Driver Name: ${vehicle.driverName}`);

      doc.moveDown();

      doc.text(`Client Name: ${vehicle.clientName}`);

      doc.moveDown();

      doc.text(`GPS Device ID: ${vehicle.gpsDeviceId}`);

      doc.moveDown();

      doc.text(`Status: ${vehicle.status}`);

      doc.moveDown();

      doc.text(`Latitude: ${vehicle.latitude}`);

      doc.moveDown();

      doc.text(`Longitude: ${vehicle.longitude}`);

      doc.moveDown();

      doc.text(`Speed: ${vehicle.speed} km/h`);

      doc.moveDown();

      doc.text(`Generated At: ${new Date().toLocaleString()}`);

      doc.end();
    });
  }
}
