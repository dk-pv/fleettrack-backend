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
    const { name, email, password, role } = body;

    const existingUser = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role,
      },
    });

    const { password: _, ...safeUser } = user;

    return {
      success: true,
      user: safeUser,
    };
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    const safeUsers = users.map(({ password, ...user }) => user);

    return {
      success: true,
      users: safeUsers,
    };
  }

  async update(id: string, body: any) {
    const { name, email, role } = body;

    const existingUser = await this.prisma.user.findUnique({
      where: {
        id,
      },
    });

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    const updatedUser = await this.prisma.user.update({
      where: {
        id,
      },

      data: {
        name,
        email,
        role,
      },
    });

    const { password: _, ...safeUser } = updatedUser;

    return {
      success: true,
      user: safeUser,
    };
  }

  async remove(id: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: {
        id,
      },
    });

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.delete({
      where: {
        id,
      },
    });

    return {
      success: true,
      message: 'User deleted',
    };
  }
}
