import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { TrackingGateway } from './tracking.gateway';
import { TrackingService } from './tracking.service';

@Module({
  // JwtModule so the gateway can verify the socket handshake token with the same secret.
  imports: [
    PrismaModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],

  providers: [TrackingGateway, TrackingService],

  exports: [TrackingGateway, TrackingService],
})
export class TrackingModule {}
