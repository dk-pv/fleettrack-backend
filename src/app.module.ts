import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { ClientsModule } from './clients/clients.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { TrackingModule } from './tracking/tracking.module';
import { UsersModule } from './users/users.module';
import { TripsModule } from './trips/trips.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { CustomersModule } from './customers/customers.module';
import { DelaysModule } from './delays/delays.module';
import { TripCostModule } from './trip-cost/trip-cost.module';
import { UploadModule } from './upload/upload.module';
import { PodModule } from './pod/pod.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    VehiclesModule,
    ClientsModule,
    DashboardModule,
    TrackingModule,
    UsersModule,
    TripsModule,
    GeocodingModule,
    CustomersModule,
    DelaysModule,
    TripCostModule,
    UploadModule,
    PodModule,
    NotificationsModule,
  ],
})
export class AppModule {}
