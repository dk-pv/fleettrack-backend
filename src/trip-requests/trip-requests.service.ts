import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TripRequest, TripRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../trips/trips.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateTripDto } from '../trips/dto/create-trip.dto';

type AuthUser = { userId: string; role: string; accountType?: string };

/**
 * Trip Request + Admin Approval workflow (Slice 1). A CLIENT submits the existing trip
 * payload; it is stored as a PENDING TripRequest — NO Trip is created here. Approval
 * (Slice 2) rebuilds the CreateTripDto from the stored row and reuses TripsService.create().
 */
@Injectable()
export class TripRequestsService {
  constructor(
    private prisma: PrismaService,
    private trips: TripsService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Create a PENDING request from the CLIENT's trip form. The owner is ALWAYS the
   * authenticated client (JWT userId) — any clientId in the body is ignored. Customer +
   * vehicle ownership are validated up front with the SAME checks the trip module runs
   * (assertOwnedTripResources), so a request enforces ownership exactly like a direct
   * trip. No Trip is created — that happens only on admin approval.
   */
  async create(user: AuthUser, dto: CreateTripDto) {
    await this.trips.assertOwnedTripResources(user, {
      customerId: dto.customerId,
      vehicleId: dto.vehicleId,
    });

    const request = await this.prisma.tripRequest.create({
      data: {
        status: TripRequestStatus.PENDING,
        clientId: user.userId, // owner from the JWT — never from the request body
        reference: dto.reference ?? null,
        vehicleId: dto.vehicleId ?? null,
        driverId: dto.driverId ?? null,
        driverName: dto.driverName ?? null,
        customerId: dto.customerId ?? null,
        origin: dto.origin,
        destination: dto.destination,
        originLat: dto.originLat ?? null,
        originLng: dto.originLng ?? null,
        destinationLat: dto.destinationLat ?? null,
        destinationLng: dto.destinationLng ?? null,
        // Stops are a transient ordered snapshot (address + optional coords) → JSON.
        stops: dto.stops
          ? (dto.stops as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        distanceKm: dto.distanceKm ?? null,
        durationMins: dto.durationMins ?? null,
        notes: dto.notes ?? null,
        scheduledStart: new Date(dto.scheduledStart),
        scheduledEnd: new Date(dto.scheduledEnd),
      },
    });

    // Notify the ADMIN audience (clientId null → admins room). Non-fatal by design in
    // NotificationsService, so a notification hiccup never fails the request creation.
    await this.notifications.onTripRequested({
      id: request.id,
      clientId: request.clientId,
      origin: request.origin,
      destination: request.destination,
    });

    return { success: true, request };
  }

  /** CLIENT sees only its own requests; ADMIN sees all. Newest first. */
  async findAll(user: AuthUser) {
    const where: Prisma.TripRequestWhereInput =
      user.role === 'CLIENT' ? { clientId: user.userId } : {};

    const requests = await this.prisma.tripRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { client: { select: { id: true, name: true } } },
    });

    return { success: true, requests };
  }

  /** A request the CLIENT owns, or any request for an ADMIN; 404 if missing. */
  async findOne(user: AuthUser, id: string) {
    const request = await this.prisma.tripRequest.findUnique({
      where: { id },
      include: { client: { select: { id: true, name: true } } },
    });

    if (!request) throw new NotFoundException('Trip request not found');

    if (user.role === 'CLIENT' && request.clientId !== user.userId) {
      throw new ForbiddenException('Not your request');
    }

    return { success: true, request };
  }

  /* ---------------------------------------------------------------- */
  /* Admin review (Slice 2) — ADMIN only (enforced by @Roles at the    */
  /* controller). Approve atomically claims the request, then creates  */
  /* the real Trip through the reused TripsService.create().           */
  /* ---------------------------------------------------------------- */

  /**
   * Approve a PENDING request and create its Trip. The claim is atomic and the create is
   * NOT wrapped in a DB transaction (TripsService.create does external geocoding, which is
   * not transaction-safe). Sequence:
   *
   *  1. Load the request (404 if missing; fast 409 if already reviewed).
   *  2. Atomic claim PENDING → APPROVED via updateMany gated on `status: PENDING`. Exactly
   *     one caller can flip it, so two simultaneous approvals cannot both create a Trip —
   *     the loser sees count 0 and 409s without creating anything.
   *  3. Rebuild the CreateTripDto from the stored snapshot and call TripsService.create as
   *     the owning CLIENT — reusing its ownership + overlap revalidation, geocoding,
   *     reference generation, ASSIGNED status and CREATED event (no duplicated logic). This
   *     re-checks CURRENT state, so a vehicle/customer that changed hands or a newly-booked
   *     overlapping window is rejected at approval time.
   *  4. If create FAILS, roll the claim back APPROVED → PENDING (guarded on
   *     `status: APPROVED, tripId: null` so it reverts only THIS uncompleted claim) and
   *     rethrow — no Trip created, no APPROVED left behind.
   *  5. If create SUCCEEDS the Trip exists, and the request must NEVER return to PENDING —
   *     that would let a second approval create a DUPLICATE Trip. So the rollback boundary
   *     covers ONLY create(): the tripId/reviewer/timestamp write and the notification run
   *     OUTSIDE it. If that metadata write fails the request stays APPROVED (its tripId link
   *     may be missing, but the Trip is real and re-approval is blocked) and the error
   *     surfaces.
   */
  async approve(user: AuthUser, id: string) {
    const request = await this.prisma.tripRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Trip request not found');
    if (request.status !== TripRequestStatus.PENDING) {
      throw new ConflictException('REQUEST_NOT_PENDING');
    }

    // Atomic claim — only one approver flips PENDING → APPROVED.
    const claim = await this.prisma.tripRequest.updateMany({
      where: { id, status: TripRequestStatus.PENDING },
      data: { status: TripRequestStatus.APPROVED },
    });
    if (claim.count !== 1) {
      // Lost the race (another admin already reviewed it) — do NOT create a Trip.
      throw new ConflictException('REQUEST_NOT_PENDING');
    }

    // The rollback boundary covers ONLY Trip creation. Once a Trip exists the request must
    // never return to PENDING (duplicate-Trip guard), so nothing past this try rolls back.
    let result: Awaited<ReturnType<TripsService['create']>>;
    try {
      // Reuse the one canonical trip-creation path AS THE OWNING CLIENT. This revalidates
      // vehicle/customer ownership and vehicle/driver overlap against current state.
      result = await this.trips.create(
        { userId: request.clientId, role: 'CLIENT' },
        this.toCreateTripDto(request),
      );
    } catch (err) {
      // Trip creation failed → no Trip exists → revert our claim APPROVED → PENDING.
      // Guarded on `tripId: null` so it can only revert THIS uncompleted claim.
      await this.prisma.tripRequest.updateMany({
        where: { id, status: TripRequestStatus.APPROVED, tripId: null },
        data: { status: TripRequestStatus.PENDING },
      });
      throw err;
    }

    // Trip exists from here on. Persist the link + review metadata. If THIS write fails the
    // request stays APPROVED (NOT rolled back): a real Trip already exists, and leaving it
    // APPROVED blocks any second approval, so no duplicate Trip is possible — the error just
    // propagates to the caller.
    const tripId = result.trip.id;
    const updated = await this.prisma.tripRequest.update({
      where: { id },
      data: {
        tripId,
        reviewedById: user.userId,
        reviewedAt: new Date(),
      },
    });

    // Best-effort notification (NotificationsService never throws) — client-scoped, and
    // outside the rollback boundary so it can never revert a completed approval.
    await this.notifications.onTripRequestApproved(
      {
        id: updated.id,
        clientId: updated.clientId,
        origin: updated.origin,
        destination: updated.destination,
      },
      tripId,
    );

    return { success: true, request: updated, trip: result.trip };
  }

  /**
   * Reject a PENDING request with a mandatory reason. No Trip is ever created. The reason
   * is trimmed and a whitespace-only reason is refused (authoritative here, regardless of
   * the DTO). The transition is an atomic claim gated on `status: PENDING`, so an
   * already-reviewed request cannot be rejected (409) and two rejections cannot both win.
   */
  async reject(user: AuthUser, id: string, reason: string) {
    const trimmed = (reason ?? '').trim();
    if (!trimmed) throw new BadRequestException('REJECTION_REASON_REQUIRED');

    const request = await this.prisma.tripRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Trip request not found');
    if (request.status !== TripRequestStatus.PENDING) {
      throw new ConflictException('REQUEST_NOT_PENDING');
    }

    const claim = await this.prisma.tripRequest.updateMany({
      where: { id, status: TripRequestStatus.PENDING },
      data: {
        status: TripRequestStatus.REJECTED,
        rejectionReason: trimmed,
        reviewedById: user.userId,
        reviewedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      throw new ConflictException('REQUEST_NOT_PENDING');
    }

    const updated = await this.prisma.tripRequest.findUnique({ where: { id } });

    // Notify the requesting CLIENT only (client-scoped; no tripId — no Trip was created).
    await this.notifications.onTripRequestRejected({
      id: request.id,
      clientId: request.clientId,
      origin: request.origin,
      destination: request.destination,
      rejectionReason: trimmed,
    });

    return { success: true, request: updated };
  }

  /**
   * Rebuild the CreateTripDto from a stored request snapshot so approval reuses
   * TripsService.create() verbatim. `stops` was persisted as the same JSON array the
   * client submitted; dates are serialized back to ISO strings (create() re-parses them).
   */
  private toCreateTripDto(request: TripRequest): CreateTripDto {
    return {
      reference: request.reference ?? undefined,
      vehicleId: request.vehicleId ?? undefined,
      driverId: request.driverId ?? undefined,
      driverName: request.driverName ?? undefined,
      customerId: request.customerId ?? undefined,
      origin: request.origin,
      destination: request.destination,
      originLat: request.originLat ?? undefined,
      originLng: request.originLng ?? undefined,
      destinationLat: request.destinationLat ?? undefined,
      destinationLng: request.destinationLng ?? undefined,
      stops:
        (request.stops as unknown as CreateTripDto['stops']) ?? undefined,
      distanceKm: request.distanceKm ?? undefined,
      durationMins: request.durationMins ?? undefined,
      notes: request.notes ?? undefined,
      scheduledStart: request.scheduledStart.toISOString(),
      scheduledEnd: request.scheduledEnd.toISOString(),
    };
  }
}
