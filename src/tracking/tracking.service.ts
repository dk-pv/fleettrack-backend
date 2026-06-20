import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from './tracking.gateway';
import { VehicleStatus } from '@prisma/client';

function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));

  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function isValidCoord(lat: number, lng: number): boolean {
  if (isNaN(lat) || isNaN(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

const MIN_SAVE_DISTANCE_METERS = 10;

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
      const clients = await this.prisma.client.findMany();

      for (const client of clients) {
        try {
          this.logger.log(`Syncing vehicles for client: ${client.name}`);

          const response = await fetch(client.apiUrl);

          if (!response.ok) {
            this.logger.error(
              `API failed for client ${client.name}: ${response.status}`,
            );
            continue;
          }

          const data = (await response.json()) as any[];

          for (const item of data) {
            const vehicleNumber = item.vehicleNumber;
            const lat = item.lat || 0;
            const lng = item.long || 0;

            let status: VehicleStatus = 'OFFLINE';

            if (item.ignition && item.speed > 0) {
              status = 'MOVING';
            } else if (item.ignition && item.speed <= 0) {
              status = 'IDLE';
            }

            let vehicle = await this.prisma.vehicle.findFirst({
              where: {
                clientId: client.id,
                vehicleNumber,
              },
            });

            if (!vehicle) {
              vehicle = await this.prisma.vehicle.create({
                data: {
                  vehicleName: vehicleNumber,
                  vehicleNumber,
                  gpsDeviceId: vehicleNumber,
                  providerName: 'airotrack',
                  providerVehicleId: vehicleNumber,
                  driverName: 'Unknown Driver',
                  clientId: client.id,
                  ignition: item.ignition || false,
                  batteryVoltage: item.power || 0,
                  charge: item.charge || false,
                  isOnline: true,
                  status,
                  latitude: lat,
                  longitude: lng,
                  speed: item.speed || 0,
                  lastSeenAt: new Date(),
                  lastProviderUpdate: new Date(item.last_updated),
                },
              });

              this.logger.log(
                `Created vehicle ${vehicleNumber} for ${client.name}`,
              );

              continue;
            }

            const updatedVehicle = await this.prisma.vehicle.update({
              where: {
                id: vehicle.id,
              },
              data: {
                ignition: item.ignition || false,
                batteryVoltage: item.power || 0,
                charge: item.charge || false,
                isOnline: true,
                status,
                latitude: lat,
                longitude: lng,
                speed: item.speed || 0,
                lastSeenAt: new Date(),
                lastProviderUpdate: new Date(item.last_updated),
              },
            });

            if (isValidCoord(lat, lng)) {
              const lastHistory =
                await this.prisma.vehicleLocationHistory.findFirst({
                  where: {
                    vehicleId: updatedVehicle.id,
                  },
                  orderBy: {
                    createdAt: 'desc',
                  },
                });

              let shouldSave = true;
              let heading = 0;

              if (lastHistory) {
                const dist = haversineDistance(
                  lastHistory.latitude,
                  lastHistory.longitude,
                  lat,
                  lng,
                );

                if (dist < MIN_SAVE_DISTANCE_METERS) {
                  shouldSave = false;
                } else {
                  heading = calculateBearing(
                    lastHistory.latitude,
                    lastHistory.longitude,
                    lat,
                    lng,
                  );
                }
              }

              if (shouldSave) {
                await this.prisma.vehicleLocationHistory.create({
                  data: {
                    vehicleId: updatedVehicle.id,
                    latitude: lat,
                    longitude: lng,
                    speed: item.speed || 0,
                    ignition: item.ignition || false,
                    heading,
                  },
                });
              }
            }

            this.trackingGateway.server.emit(
              'vehicleLocationUpdate',
              {
                ...updatedVehicle,
                timestamp: Date.now(),
              },
            );
          }
        } catch (clientError) {
          this.logger.error(
            `Client sync failed: ${client.name}`,
          );
          console.log(clientError);
        }
      }
    } catch (error) {
      console.log(error);
      this.logger.error('Vehicle sync failed');
    }
  }

  @Cron('0 */1 * * * *')
  async detectOfflineVehicles() {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const offlineVehicles = await this.prisma.vehicle.findMany({
        where: {
          lastSeenAt: {
            lt: fiveMinutesAgo,
          },
          isOnline: true,
        },
      });

      for (const vehicle of offlineVehicles) {
        const updatedVehicle = await this.prisma.vehicle.update({
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
          {
            ...updatedVehicle,
            timestamp: Date.now(),
          },
        );

        this.logger.warn(
          `Vehicle offline: ${vehicle.vehicleNumber}`,
        );
      }
    } catch (error) {
      console.log(error);
      this.logger.error('Offline detection failed');
    }
  }
}