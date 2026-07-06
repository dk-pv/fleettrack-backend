import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { TripsService } from './trips.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripStatusDto } from './dto/update-trip-status.dto';
import { OverlapQueryDto } from './dto/overlap-query.dto';

/**
 * Trip Management API.
 *
 * Role rule (inverse of vehicles): the CLIENT owns the trip lifecycle; the ADMIN
 * is read-only. Ownership (client sees only its own trips) is enforced in the
 * service via the JWT `userId`, which is the Client id for a CLIENT account.
 */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Roles('CLIENT')
  @Post()
  create(@Req() req: Request, @Body() dto: CreateTripDto) {
    return this.tripsService.create((req as any).user, dto);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get()
  findAll(@Req() req: Request, @Query('clientId') clientId?: string) {
    return this.tripsService.findAll((req as any).user, clientId);
  }

  // Must precede @Get(':id') so the ':id' route doesn't capture "overlap".
  @Roles('ADMIN', 'CLIENT')
  @Get('overlap')
  checkOverlap(@Req() req: Request, @Query() query: OverlapQueryDto) {
    return this.tripsService.checkOverlap((req as any).user, query);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.findOne((req as any).user, id);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get(':id/timeline')
  timeline(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getTimeline((req as any).user, id);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get(':id/progress')
  progress(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getProgress((req as any).user, id);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get(':id/eta')
  eta(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getEta((req as any).user, id);
  }

  @Roles('ADMIN', 'CLIENT')
  @Get(':id/breadcrumbs')
  breadcrumbs(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.getBreadcrumbs((req as any).user, id);
  }

  @Roles('CLIENT')
  @Patch(':id/status')
  updateStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateTripStatusDto,
  ) {
    return this.tripsService.updateStatus((req as any).user, id, dto);
  }

  @Roles('CLIENT')
  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateTripDto,
  ) {
    return this.tripsService.update((req as any).user, id, dto);
  }

  @Roles('CLIENT')
  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.tripsService.remove((req as any).user, id);
  }
}
