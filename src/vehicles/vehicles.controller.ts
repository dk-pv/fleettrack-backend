import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';

import type { Response } from 'express';

import { VehiclesService } from './vehicles.service';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { RolesGuard } from '../auth/roles.guard';

import { Roles } from '../auth/roles.decorator';

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'FLEET_MANAGER')
  @Post()
  create(@Body() body: any) {
    return this.vehiclesService.create(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'FLEET_MANAGER', 'VIEWER')
  @Get()
  findAll() {
    return this.vehiclesService.findAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'FLEET_MANAGER', 'VIEWER')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vehiclesService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'FLEET_MANAGER')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.vehiclesService.update(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.vehiclesService.remove(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'FLEET_MANAGER')
  @Patch(':id/location')
  updateLocation(@Param('id') id: string, @Body() body: any) {
    return this.vehiclesService.updateLocation(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'FLEET_MANAGER', 'VIEWER')
  @Get(':id/report')
  async generateReport(@Param('id') id: string, @Res() res: Response) {
    const pdfBuffer = await this.vehiclesService.generateVehicleReport(id);

    res.set({
      'Content-Type': 'application/pdf',

      'Content-Disposition': `attachment; filename=vehicle-report-${id}.pdf`,
    });

    res.send(pdfBuffer);
  }
}
