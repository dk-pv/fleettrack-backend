
import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { TrackingGateway } from '../tracking/tracking.gateway';

@Module({
  controllers: [
    VehiclesController,
  ],

  providers: [
    VehiclesService,
    TrackingGateway,
  ],
})
export class VehiclesModule {}
