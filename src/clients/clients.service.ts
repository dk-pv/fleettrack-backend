import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ClientsService {
  constructor(private prisma: PrismaService) {}

  async create(body: any) {
    const { name, email, password, apiUrl } = body;

    const existingClient = await this.prisma.client.findUnique({
      where: {
        email,
      },
    });

    if (existingClient) {
      throw new BadRequestException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const client = await this.prisma.client.create({
      data: {
        name,
        email,
        password: hashedPassword,
        apiUrl,
      },
    });

    const { password: _, ...safeClient } = client;

    return {
      success: true,
      client: safeClient,
    };
  }

  async findAll() {
    const clients = await this.prisma.client.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    const safeClients = clients.map(({ password, ...client }) => client);

    return {
      success: true,
      clients: safeClients,
    };
  }

  async update(id: string, body: any) {
    const { name, email, apiUrl } = body;

    const existingClient = await this.prisma.client.findUnique({
      where: {
        id,
      },
    });

    if (!existingClient) {
      throw new NotFoundException('Client not found');
    }

    const updatedClient = await this.prisma.client.update({
      where: {
        id,
      },

      data: {
        name,
        email,
        apiUrl,
      },
    });

    const { password: _, ...safeClient } = updatedClient;

    return {
      success: true,
      client: safeClient,
    };
  }

  async remove(id: string) {
    const existingClient = await this.prisma.client.findUnique({
      where: { id },
    });

    if (!existingClient) {
      throw new NotFoundException('Client not found');
    }

    await this.prisma.vehicle.deleteMany({
      where: { clientId: id },
    });

    await this.prisma.client.delete({
      where: { id },
    });

    return {
      success: true,
      message: 'Client deleted',
    };
  }
}
