import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
  ) {}

  async login(body: any) {
    const { email, password } = body;

    const user =
      await this.prisma.user.findUnique({
        where: {
          email,
        },
      });

    if (!user) {
      throw new UnauthorizedException(
        'Invalid email',
      );
    }

    if (user.password !== password) {
      throw new UnauthorizedException(
        'Invalid password',
      );
    }

    return {
      success: true,
      message: 'Login successful',
      user,
      token: 'dummy-jwt-token',
    };
  }
}