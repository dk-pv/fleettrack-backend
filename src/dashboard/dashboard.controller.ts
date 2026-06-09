import {
  Controller,
  Get,
} from "@nestjs/common";

import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(
    private dashboardService: DashboardService,
  ) {}

  /* DASHBOARD STATS */

  @Get("stats")
  async getDashboardStats() {
    return this.dashboardService.getDashboardStats();
  }

  /* ACTIVE VEHICLES */

  @Get("active-vehicles")
  async getActiveVehicles() {
    return this.dashboardService.getActiveVehicles();
  }
}