import { Module } from '@nestjs/common';
import { DelaysController, TripDelaysController } from './delays.controller';
import { DelaysService } from './delays.service';

@Module({
  controllers: [DelaysController, TripDelaysController],
  providers: [DelaysService],
})
export class DelaysModule {}
