import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async login(body: any) {
    const { email, password } = body;

    let account: any =
      await this.prisma.user.findUnique({
        where: { email },
      });

    let accountType = 'USER';

    if (!account) {
      account =
        await this.prisma.client.findUnique({
          where: { email },
        });

      accountType = 'CLIENT';
    }

    if (!account) {
      throw new UnauthorizedException(
        'Invalid email',
      );
    }

    const isPasswordValid =
      await bcrypt.compare(
        password,
        account.password,
      );

    if (!isPasswordValid) {
      throw new UnauthorizedException(
        'Invalid password',
      );
    }

    const token = this.jwtService.sign({
      userId: account.id,
      role:
        accountType === 'CLIENT'
          ? 'CLIENT'
          : account.role,
      accountType,
    });

    const { password: _, ...safeAccount } =
      account;

    const normalizedUser = {
      ...safeAccount,
      role:
        accountType === 'CLIENT'
          ? 'CLIENT'
          : safeAccount.role,
    };

    return {
      success: true,
      token,
      user: normalizedUser,
      accountType,
    };
  }
}