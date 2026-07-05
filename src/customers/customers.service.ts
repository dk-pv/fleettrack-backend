import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

/**
 * Customer directory CRUD (CUS-01 / CUS-02). Admin-managed master data, mirroring
 * the clients module. Trip history (CUS-07), contact/tax (CUS-03/04) and the
 * address book (CUS-05/06) are out of scope for Phase 1.
 */
@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCustomerDto) {
    const customer = await this.prisma.customer.create({
      data: {
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

  async findAll() {
    const customers = await this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, customers };
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');

    return { success: true, customer };
  }

  async update(id: string, dto: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Customer not found');

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

  async remove(id: string) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Customer not found');

    await this.prisma.customer.delete({ where: { id } });

    return { success: true, message: 'Customer deleted' };
  }
}
