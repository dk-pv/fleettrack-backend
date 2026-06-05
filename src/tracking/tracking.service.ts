
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from './tracking.gateway';

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(
    TrackingService.name,
  );

  constructor(
    private prisma: PrismaService,
    private trackingGateway: TrackingGateway,
  ) {}

  @Cron('*/20 * * * * *')
  async syncVehicles() {
    try {
      this.logger.log(
        'Syncing vehicles from AiroTrack...',
      );

      const response = await fetch(
        process.env.AIROTRACK_API!,
      );

      if (!response.ok) {
        throw new Error(
          `AiroTrack API failed: ${response.status}`,
        );
      }

     const data = (await response.json()) as any[];

      for (const item of data) {
        const vehicleNumber =
          item.vehicleNumber;

        const status = item.ignition
          ? 'MOVING'
          : 'IDLE';

        let vehicle =
          await this.prisma.vehicle.findUnique({
            where: {
              vehicleNumber,
            },
            
          });


        if (!vehicle) {
          vehicle =
            await this.prisma.vehicle.create({
              data: {
                vehicleName:
                  vehicleNumber,

                vehicleNumber,

                gpsDeviceId:
                  vehicleNumber,

                providerName:
                  'airotrack',

                providerVehicleId:
                  vehicleNumber,

                driverName:
                  'Unknown Driver',

                clientName:
                  'FleetTrack',

                ignition:
                  item.ignition || false,

                batteryVoltage:
                  item.power || 0,

                charge:
                  item.charge || false,

                isOnline: true,

                status,

                latitude:
                  item.lat || 0,

                longitude:
                  item.long || 0,

                speed:
                  item.speed || 0,

                lastSeenAt:
                  new Date(),

                lastProviderUpdate:
                  new Date(
                    item.last_updated,
                  ),
              },
            });

          this.logger.log(
            `Created vehicle: ${vehicleNumber}`,
          );

          continue;
        }

        /* ------------------------------ */
        /* UPDATE VEHICLE */
        /* ------------------------------ */

        const updatedVehicle =
          await this.prisma.vehicle.update({
            where: {
              vehicleNumber,
            },

            data: {
              ignition:
                item.ignition || false,

              batteryVoltage:
                item.power || 0,

              charge:
                item.charge || false,

              isOnline: true,

              status,

              latitude:
                item.lat || 0,

              longitude:
                item.long || 0,

              speed:
                item.speed || 0,

              lastSeenAt:
                new Date(),

              lastProviderUpdate:
                new Date(
                  item.last_updated,
                ),
            },
          });

        /* ------------------------------ */
        /* SAVE LOCATION HISTORY */
        /* ------------------------------ */

        await this.prisma.vehicleLocationHistory.create(
          {
            data: {
              vehicleId:
                updatedVehicle.id,

              latitude:
                item.lat || 0,

              longitude:
                item.long || 0,

              speed:
                item.speed || 0,

              ignition:
                item.ignition || false,
            },
          },
        );

        /* ------------------------------ */
        /* SOCKET EMIT */
        /* ------------------------------ */

        this.trackingGateway.server.emit(
          'vehicleLocationUpdate',
          updatedVehicle,
        );
      }

      this.logger.log(
        'Vehicle sync completed',
      );
    } catch (error) {
      console.log(error);

      this.logger.error(
        'AiroTrack sync failed',
      );
    }
  }

  /* -------------------------------- */
  /* OFFLINE DETECTION */
  /* -------------------------------- */

  @Cron('0 */1 * * * *')
  async detectOfflineVehicles() {
    try {
      const fiveMinutesAgo =
        new Date(
          Date.now() -
            5 * 60 * 1000,
        );

      const offlineVehicles =
        await this.prisma.vehicle.findMany(
          {
            where: {
              lastSeenAt: {
                lt: fiveMinutesAgo,
              },

              isOnline: true,
            },
          },
        );

      for (const vehicle of offlineVehicles) {
        const updatedVehicle =
          await this.prisma.vehicle.update({
            where: {
              id: vehicle.id,
            },

            data: {
              isOnline: false,

              status: 'OFFLINE',
            },
          });

        this.trackingGateway.server.emit(
          'vehicleLocationUpdate',
          updatedVehicle,
        );

        this.logger.warn(
          `Vehicle offline: ${vehicle.vehicleNumber}`,
        );
      }
    } catch (error) {
      console.log(error);

      this.logger.error(
        'Offline detection failed',
      );
    }
  }
}
