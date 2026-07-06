import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDelayDto } from './dto/create-delay.dto';

type AuthUser = { userId: string; role: string; accountType?: string };

/**
 * Reported-delay ingest/serve (DLY-01.1). A delay always belongs to a trip, so
 * authorization mirrors the trips module: ADMIN accesses all delays; a CLIENT is
 * scoped to delays on its own trips (derived from `trip.clientId` via the JWT).
 */
@Injectable()
export class DelaysService {
  constructor(private prisma: PrismaService) {}

  private readonly delayInclude = {
    trip: { select: { id: true, reference: true, clientId: true } },
  };

  /** A trip the caller may access (CLIENT owns it, ADMIN any); throws otherwise. */
  private async getAccessibleTrip(user: AuthUser, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (user.role === 'CLIENT' && trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  /** Ingest a reported delay against a trip (DLY-01.1). */
  async create(user: AuthUser, dto: CreateDelayDto) {
    await this.getAccessibleTrip(user, dto.tripId);

    const delay = await this.prisma.delay.create({
      data: {
        tripId: dto.tripId,
        category: dto.category,
        reason: dto.reason ?? null,
        remarks: dto.remarks ?? null,
        durationMinutes: dto.durationMinutes ?? 0,
        reportedAt: dto.reportedAt ? new Date(dto.reportedAt) : new Date(),
        source: dto.source ?? 'PORTAL',
        reportedBy: dto.reportedBy ?? null,
      },
      include: this.delayInclude,
    });

    return { success: true, delay };
  }

  /** List delays; ADMIN sees all, a CLIENT only its own trips' delays. */
  async findAll(user: AuthUser) {
    const where: Prisma.DelayWhereInput =
      user.role === 'CLIENT' ? { trip: { clientId: user.userId } } : {};

    const delays = await this.prisma.delay.findMany({
      where,
      include: this.delayInclude,
      orderBy: { reportedAt: 'desc' },
    });

    return { success: true, delays };
  }

  /** Delays reported for a single trip (DLY-01.1 — retrievable per trip). */
  async findByTrip(user: AuthUser, tripId: string) {
    await this.getAccessibleTrip(user, tripId);

    const delays = await this.prisma.delay.findMany({
      where: { tripId },
      orderBy: { reportedAt: 'desc' },
    });

    return { success: true, delays };
  }
}
