import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { DelaysService } from './delays.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateDelayDto } from './dto/create-delay.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/**
 * Reported-delay ingest/serve API (DLY-01.1). Same authorization model as trips:
 * ADMIN accesses all delays; a CLIENT only its own trips' delays (enforced in the
 * service via the JWT `userId`).
 */
@Controller('delays')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DelaysController {
  constructor(private readonly delaysService: DelaysService) {}

  @Roles('ADMIN', 'CLIENT')
  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateDelayDto) {
    return this.delaysService.create(req.user, dto);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get()
  findAll(@Req() req: AuthedRequest) {
    return this.delaysService.findAll(req.user);
  }
}

/** Per-trip delay listing (DLY-01.1 — delays retrievable per trip). */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripDelaysController {
  constructor(private readonly delaysService: DelaysService) {}

  @Roles('ADMIN', 'CLIENT')
  @Get(':id/delays')
  findByTrip(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.delaysService.findByTrip(req.user, id);
  }
}
