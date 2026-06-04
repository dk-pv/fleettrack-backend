import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from './tracking.gateway';

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private prisma: PrismaService,

    private trackingGateway: TrackingGateway,
  ) {}

  @Cron('*/20 * * * * *')
  async syncVehicles() {
    try {
      this.logger.log('Syncing vehicles from AiroTrack...');

      const response = await fetch(process.env.AIROTRACK_API!);

      const data = await response.json();

      for (const item of data) {
        const vehicleNumber = item.vehicleNumber;

        const status = item.ignition ? 'MOVING' : 'IDLE';

        let vehicle = await this.prisma.vehicle.findUnique({
          where: {
            vehicleNumber,
          },
        });

        // CREATE VEHICLE IF NOT EXISTS

        if (!vehicle) {
          vehicle = await this.prisma.vehicle.create({
            data: {
              vehicleName: vehicleNumber,

              vehicleNumber,

              gpsDeviceId: vehicleNumber,

              providerName: 'airotrack',

              providerVehicleId: vehicleNumber,

              driverName: 'Unknown Driver',

              clientName: 'FleetTrack',

              ignition: item.ignition,

              batteryVoltage: item.power || 0,

              charge: item.charge || false,

              isOnline: true,

              status,

              latitude: item.lat || 0,

              longitude: item.long || 0,

              speed: item.speed || 0,

              lastSeenAt: new Date(),

              lastProviderUpdate: new Date(item.last_updated),
            },
          });

          this.logger.log(`Created vehicle: ${vehicleNumber}`);
        }

        // UPDATE EXISTING VEHICLE

        const updatedVehicle = await this.prisma.vehicle.update({
          where: {
            vehicleNumber,
          },

          data: {
            ignition: item.ignition,

            batteryVoltage: item.power || 0,

            charge: item.charge || false,

            isOnline: true,

            status,

            latitude: item.lat || 0,

            longitude: item.long || 0,

            speed: item.speed || 0,

            lastSeenAt: new Date(),

            lastProviderUpdate: new Date(item.last_updated),
          },
        });

        // SOCKET EMIT

        this.trackingGateway.server.emit(
          'vehicleLocationUpdate',
          updatedVehicle,
        );
      }

      this.logger.log('Vehicle sync completed');
    } catch (error) {
      console.log(error);

      this.logger.error('AiroTrack sync failed');
    }
  }
}
