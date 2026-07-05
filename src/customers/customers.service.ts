import { Injectable, NotFoundException } from '@nestjs/common';
import { AddressKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

/**
 * Customer directory CRUD (CUS-01 / CUS-02). Tenant-owned data: every operation is
 * scoped to the authenticated CLIENT (its `clientId`), so a client sees and mutates
 * only its own customers — mirroring the trips module's ownership model.
 */
@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async create(clientId: string, dto: CreateCustomerDto) {
    const customer = await this.prisma.customer.create({
      data: {
        clientId,
        name: dto.name,
        type: dto.type,
        company: dto.company ?? null,
        contactPerson: dto.contactPerson ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
        taxId: dto.taxId ?? null,
        registrationNumber: dto.registrationNumber ?? null,
        notes: dto.notes ?? null,
      },
    });

    return { success: true, customer };
  }

  async findAll(clientId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, customers };
  }

  async findOne(clientId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, clientId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    return { success: true, customer };
  }

  async update(clientId: string, id: string, dto: UpdateCustomerDto) {
    await this.assertCustomer(clientId, id);

    const customer = await this.prisma.customer.update({
      where: { id },
      data: {
        name: dto.name,
        type: dto.type,
        company: dto.company,
        contactPerson: dto.contactPerson,
        email: dto.email,
        phone: dto.phone,
        address: dto.address,
        taxId: dto.taxId,
        registrationNumber: dto.registrationNumber,
        notes: dto.notes,
      },
    });

    return { success: true, customer };
  }

  async remove(clientId: string, id: string) {
    await this.assertCustomer(clientId, id);

    await this.prisma.customer.delete({ where: { id } });

    return { success: true, message: 'Customer deleted' };
  }

  /* ---------------------------------------------------------------- */
  /* Reusable pickup/delivery address book (CUS-05 / CUS-06)           */
  /* ---------------------------------------------------------------- */

  /** Assert the customer exists AND belongs to this client; throws otherwise. */
  private async assertCustomer(clientId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, clientId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
  }

  /** List a customer's addresses, optionally filtered by kind. */
  async listAddresses(clientId: string, customerId: string, kind?: string) {
    await this.assertCustomer(clientId, customerId);

    const validKind =
      kind === AddressKind.PICKUP || kind === AddressKind.DELIVERY
        ? (kind as AddressKind)
        : undefined;

    const addresses = await this.prisma.customerAddress.findMany({
      where: { customerId, ...(validKind ? { kind: validKind } : {}) },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return { success: true, addresses };
  }

  async addAddress(clientId: string, customerId: string, dto: CreateAddressDto) {
    await this.assertCustomer(clientId, customerId);

    const address = await this.prisma.customerAddress.create({
      data: {
        customerId,
        kind: dto.kind,
        label: dto.label,
        address: dto.address,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        isDefault: dto.isDefault ?? false,
      },
    });

    return { success: true, address };
  }

  async updateAddress(
    clientId: string,
    customerId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ) {
    await this.assertCustomer(clientId, customerId);

    const existing = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundException('Address not found');

    const address = await this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        kind: dto.kind,
        label: dto.label,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        isDefault: dto.isDefault,
      },
    });

    return { success: true, address };
  }

  async removeAddress(clientId: string, customerId: string, addressId: string) {
    await this.assertCustomer(clientId, customerId);

    const existing = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundException('Address not found');

    await this.prisma.customerAddress.delete({ where: { id: addressId } });

    return { success: true, message: 'Address deleted' };
  }

  /* ---------------------------------------------------------------- */
  /* Trip history (CUS-07.2) — trips placed for this customer          */
  /* ---------------------------------------------------------------- */

  /**
   * List a customer's trips, newest first (CUS-07.2). Scoped to the authenticated
   * client — the customer must belong to it, and only that client's trips are
   * returned. Shaped for the shared trip table (reference / route / vehicle /
   * driver / schedule / status).
   */
  async listTrips(clientId: string, customerId: string) {
    await this.assertCustomer(clientId, customerId);

    const trips = await this.prisma.trip.findMany({
      where: { customerId, clientId },
      include: {
        vehicle: { select: { id: true, vehicleNumber: true, vehicleName: true } },
        stops: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      trips: trips.map((t) => ({
        id: t.id,
        reference: t.reference,
        status: t.status,
        origin: t.origin,
        destination: t.destination,
        vehicle: t.vehicle
          ? {
              id: t.vehicle.id,
              vehicleNumber: t.vehicle.vehicleNumber,
              vehicleName: t.vehicle.vehicleName,
            }
          : null,
        driverName: t.driverName,
        stops: t.stops.map((s) => ({ id: s.id })),
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
      })),
    };
  }
}
