import {
  Controller,
  Delete,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import { RolesGuard } from '../auth/roles.guard';

import { Roles } from '../auth/roles.decorator';

@Controller('vehicles')
export class VehiclesController {
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
  )
  @Roles(
    'ADMIN',
    'FLEET_MANAGER',
    'VIEWER',
  )
  @Get()
  findAll() {
    return {
      success: true,
      message:
        'Vehicles list access granted',
    };
  }

  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
  )
  @Roles('ADMIN')
  @Delete(':id')
  deleteVehicle(
    @Param('id') id: string,
  ) {
    return {
      success: true,
      message: `Vehicle ${id} deleted`,
    };
  }
}