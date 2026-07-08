import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma, TripStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { NotificationQueryDto } from './dto/notification-query.dto';

type AuthUser = { userId: string; role: string; accountType?: string };

/** Minimal trip identity a trigger passes in (the owning client + reference). */
interface TripRef {
  id: string;
  reference: string;
  clientId: string;
  status: TripStatus;
}

const DEFAULT_LIMIT = 30;

/**
 * The trip status transitions that raise a notification (NOT-01.2 / NOT-02.1 / NOT-03.1),
 * with their copy. Any other transition is intentionally silent. Keeping the event→type
 * mapping here — not in the Trips module — lets a trigger site add a single call.
 */
const TRIP_STATUS_NOTIFICATION: Partial<
  Record<
    TripStatus,
    { type: NotificationType; title: string; message: (ref: string) => string }
  >
> = {
  [TripStatus.STARTED]: {
    type: NotificationType.TRIP_STARTED,
    title: 'Trip started',
    message: (ref) => `Trip ${ref} has started.`,
  },
  [TripStatus.DELAYED]: {
    type: NotificationType.TRIP_DELAYED,
    title: 'Trip delayed',
    message: (ref) => `Trip ${ref} is delayed.`,
  },
  [TripStatus.COMPLETED]: {
    type: NotificationType.TRIP_COMPLETED,
    title: 'Trip completed',
    message: (ref) => `Trip ${ref} has been completed.`,
  },
};

/**
 * In-portal notifications (NOT-01…04). Single source of truth: every notification is
 * created here and, on create, broadcast as a lightweight `notification:new` signal over
 * the shared tracking socket (no content on the wire — clients refetch the auth-scoped
 * list). The Trip/POD modules only call the semantic `on*` triggers; the event→type and
 * copy mapping lives here so those completed modules add no notification logic.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private trackingGateway: TrackingGateway,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Triggers (called by the Trip / POD modules — Slice 2)            */
  /* ---------------------------------------------------------------- */

  /**
   * React to a trip status change. Only the operationally meaningful transitions
   * (started / delayed / completed) raise a notification; anything else is a no-op.
   */
  async onTripStatusChanged(trip: TripRef): Promise<void> {
    const cfg = TRIP_STATUS_NOTIFICATION[trip.status];
    if (!cfg) return;
    await this.create({
      type: cfg.type,
      title: cfg.title,
      message: cfg.message(trip.reference),
      clientId: trip.clientId,
      tripId: trip.id,
    });
  }

  /** React to a proof-of-delivery confirmation (NOT-04.1). */
  async onPodConfirmed(trip: TripRef): Promise<void> {
    await this.create({
      type: NotificationType.POD_UPLOADED,
      title: 'Proof of delivery',
      message: `Proof of delivery submitted for trip ${trip.reference}.`,
      clientId: trip.clientId,
      tripId: trip.id,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Core                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Persist a notification and broadcast a refetch signal — the single writer used by
   * every trigger. Never throws into the caller's flow: a notification failure must not
   * break the trip status change or POD confirmation that triggered it.
   */
  async create(data: {
    type: NotificationType;
    title: string;
    message: string;
    clientId: string;
    tripId?: string | null;
  }): Promise<void> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          type: data.type,
          title: data.title,
          message: data.message,
          clientId: data.clientId,
          tripId: data.tripId ?? null,
        },
      });
      // Lightweight signal only (no content on the broadcast): scoped clients refetch the
      // auth-protected list. Reuses the shared tracking socket — no new gateway.
      this.trackingGateway.server.emit('notification:new', {
        clientId: row.clientId,
      });
    } catch {
      // Secondary to the domain action — swallow so the trigger site is never disrupted.
    }
  }

  /* ---------------------------------------------------------------- */
  /* Read side (scoped by the trip-ownership rule)                    */
  /* ---------------------------------------------------------------- */

  /** A CLIENT sees only its own notifications; an ADMIN sees all. */
  private scopeWhere(user: AuthUser): Prisma.NotificationWhereInput {
    return user.role === 'CLIENT' ? { clientId: user.userId } : {};
  }

  async list(user: AuthUser, query: NotificationQueryDto) {
    const where: Prisma.NotificationWhereInput = {
      ...this.scopeWhere(user),
      ...(query.unread === 'true' ? { read: false } : {}),
    };
    const take = query.limit ?? DEFAULT_LIMIT;

    const [notifications, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.notification.count({
        where: { ...this.scopeWhere(user), read: false },
      }),
    ]);

    return { success: true, notifications, unreadCount };
  }

  /** Mark one notification read (only within the caller's scope). */
  async markRead(user: AuthUser, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, ...this.scopeWhere(user) },
      data: { read: true },
    });
    return { success: true };
  }

  /** Mark every notification in the caller's scope read. */
  async markAllRead(user: AuthUser) {
    await this.prisma.notification.updateMany({
      where: { ...this.scopeWhere(user), read: false },
      data: { read: true },
    });
    return { success: true };
  }
}
