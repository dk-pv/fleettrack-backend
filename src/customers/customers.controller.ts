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

import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

/**
 * Customer directory API (CUS-01 / CUS-02). Tenant-owned data: a CLIENT manages
 * only its own customers (mirrors the trips module — ownership is derived from the
 * JWT `userId`, which is the Client id). The ADMIN does not manage customers.
 */
@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  /** The authenticated client's id (owner of every customer in this request). */
  private clientId(req: Request): string {
    return (req as any).user.userId;
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateCustomerDto) {
    return this.customersService.create(this.clientId(req), dto);
  }

  @Get()
  findAll(@Req() req: Request) {
    return this.customersService.findAll(this.clientId(req));
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.customersService.findOne(this.clientId(req), id);
  }

  // Trip history for a customer (CUS-07.2) — scoped to the client's own trips.
  @Get(':id/trips')
  listTrips(@Req() req: Request, @Param('id') id: string) {
    return this.customersService.listTrips(this.clientId(req), id);
  }

  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(this.clientId(req), id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.customersService.remove(this.clientId(req), id);
  }

  /* Reusable pickup/delivery address book (CUS-05 / CUS-06) */

  @Get(':id/addresses')
  listAddresses(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('kind') kind?: string,
  ) {
    return this.customersService.listAddresses(this.clientId(req), id, kind);
  }

  @Post(':id/addresses')
  addAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CreateAddressDto,
  ) {
    return this.customersService.addAddress(this.clientId(req), id, dto);
  }

  @Patch(':id/addresses/:addressId')
  updateAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('addressId') addressId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.customersService.updateAddress(
      this.clientId(req),
      id,
      addressId,
      dto,
    );
  }

  @Delete(':id/addresses/:addressId')
  removeAddress(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('addressId') addressId: string,
  ) {
    return this.customersService.removeAddress(this.clientId(req), id, addressId);
  }
}
