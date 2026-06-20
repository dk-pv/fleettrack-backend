import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private dashboardService: DashboardService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  async getDashboardStats(
    @Req() req: any,
    @Query('clientId') clientId?: string,
  ) {
    const user = req.user;

    const filterClientId =
      user.role === 'CLIENT'
        ? user.userId
        : clientId;

    return this.dashboardService.getDashboardStats(
      filterClientId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('active-vehicles')
  async getActiveVehicles(
    @Req() req: any,
    @Query('clientId') clientId?: string,
  ) {
    const user = req.user;

    const filterClientId =
      user.role === 'CLIENT'
        ? user.userId
        : clientId;

    return this.dashboardService.getActiveVehicles(
      filterClientId,
    );
  }
}