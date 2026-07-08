import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TripEventAction, TripStatus } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripReportQueryDto } from './dto/trip-report-query.dto';
import { DriverReportQueryDto } from './dto/driver-report-query.dto';
import { VehicleReportQueryDto } from './dto/vehicle-report-query.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripStatusDto } from './dto/update-trip-status.dto';
import { OverlapQueryDto } from './dto/overlap-query.dto';
import {
  computeRouteProgress,
  routeTotalDistance,
  GeoPoint,
} from './trip-progress.util';
import { computeEta } from './trip-eta.util';
import { detectDelay, DEFAULT_DELAY_MARGIN_MINUTES } from './trip-delay.util';
import {
  buildDelayAlert,
  buildEtaShiftAlert,
  EtaAlert,
} from './trip-eta-alert.util';
import { EtaAlertsQueryDto } from './dto/eta-alerts-query.dto';
import { GeocodingService } from '../geocoding/geocoding.service';
import { NotificationsService } from '../notifications/notifications.service';

type AuthUser = { userId: string; role: string; accountType?: string };

/** In-memory per-driver tally used to build the driver performance report (RPT-02.1). */
interface DriverPerfAccumulator {
  driverId: string;
  driverName: string | null;
  totalTrips: number;
  completed: number;
  active: number;
  cancelled: number;
  onTime: number;
  delayed: number;
  totalDistanceKm: number;
  durationSum: number; // actual elapsed minutes over completed trips with both stamps
  durationCount: number;
}

/** In-memory per-vehicle tally used to build the vehicle utilization report (RPT-03.1). */
interface VehiclePerfAccumulator {
  vehicleId: string;
  vehicleNumber: string | null;
  vehicleName: string | null;
  totalTrips: number;
  completed: number;
  active: number;
  cancelled: number;
  onTime: number;
  delayed: number;
  totalDistanceKm: number;
  durationSum: number; // actual elapsed minutes over completed trips with both stamps
  durationCount: number;
  engagedMinutes: number; // busy time counted toward utilization
}

const ROUTE_DEVIATION_THRESHOLD_M = 2000;

const STATUS_NOTE: Record<TripStatus, string> = {
  PLANNED: 'Trip created',
  ASSIGNED: 'Vehicle & driver assigned',
  STARTED: 'Trip started',
  ONGOING: 'In transit',
  DELAYED: 'Trip delayed',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
};

/** Lifecycle state machine — allowed next statuses per current status. */
const TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  PLANNED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['STARTED', 'CANCELLED'],
  STARTED: ['ONGOING', 'DELAYED', 'CANCELLED'],
  ONGOING: ['DELAYED', 'COMPLETED', 'CANCELLED'],
  DELAYED: ['ONGOING', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Stops may only be added / removed / reordered before a trip starts (TM-05). */
const STOP_EDITABLE_STATUSES: TripStatus[] = [
  TripStatus.PLANNED,
  TripStatus.ASSIGNED,
];

/** Statuses for which a destination ETA is meaningful (trip in transit — ETA-01). */
const ETA_ACTIVE_STATUSES: TripStatus[] = [
  TripStatus.STARTED,
  TripStatus.ONGOING,
  TripStatus.DELAYED,
];

const tripInclude = {
  client: { select: { id: true, name: true } },
  vehicle: { select: { id: true, vehicleNumber: true, vehicleName: true } },
  customer: { select: { id: true, name: true } },
  stops: { orderBy: { sequence: 'asc' as const } },
};

@Injectable()
export class TripsService {
  constructor(
    private prisma: PrismaService,
    private geocoding: GeocodingService,
    private notifications: NotificationsService,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Reads                                                            */
  /* ---------------------------------------------------------------- */

  async findAll(user: AuthUser, selectedClientId?: string) {
    const where: Prisma.TripWhereInput = {};

    // ADMIN may narrow by a selected client; a CLIENT is pinned to its own trips.
    if (user.role === 'ADMIN' && selectedClientId) {
      where.clientId = selectedClientId;
    }
    if (user.role === 'CLIENT') {
      where.clientId = user.userId;
    }

    const trips = await this.prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, trips: trips.map((t) => this.mapTrip(t)) };
  }

  async findOne(user: AuthUser, id: string) {
    const trip = await this.getReadable(user, id);
    return { success: true, trip: this.mapTrip(trip) };
  }

  async getTimeline(user: AuthUser, id: string) {
    await this.getReadable(user, id);

    const events = await this.prisma.tripEvent.findMany({
      where: { tripId: id },
      orderBy: { createdAt: 'asc' },
    });

    return { success: true, events: events.map((e) => this.mapEvent(e)) };
  }

  /**
   * GPS breadcrumb history (TM-21) — the trip's actual travelled path, recorded by
   * the tracking service while the trip was active. Ordered oldest→newest and
   * mapped to the frontend's TrailPoint shape for playback.
   */
  async getBreadcrumbs(user: AuthUser, id: string) {
    await this.getReadable(user, id);

    const crumbs = await this.prisma.tripBreadcrumb.findMany({
      where: { tripId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      success: true,
      breadcrumbs: crumbs.map((c) => ({
        lat: c.latitude,
        lng: c.longitude,
        timestamp: c.createdAt.getTime(),
        heading: c.heading,
        speed: c.speed,
      })),
    };
  }

  async getProgress(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true } },
        vehicle: {
          select: {
            id: true,
            vehicleNumber: true,
            vehicleName: true,
            latitude: true,
            longitude: true,
          },
        },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    return {
      success: true,
      progress: {
        ...progress,
        hasVehiclePosition,
        isDeviating:
          hasVehiclePosition &&
          progress.deviationMeters > ROUTE_DEVIATION_THRESHOLD_M,
      },
      vehiclePosition: position,
    };
  }

  /**
   * Destination ETA (ETA-01.1 / ETA-01.2). Fully derived: reuses the route-progress
   * `remainingMeters` and the assigned vehicle's live speed (falling back to an
   * average) — no Maps travel time, no external calls. ETA is null unless the trip
   * is in transit, has a live position, and has distance remaining.
   */
  async getEta(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { select: { latitude: true, longitude: true, speed: true } },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    const canEstimate =
      ETA_ACTIVE_STATUSES.includes(trip.status) &&
      hasVehiclePosition &&
      progress.remainingMeters > 0;

    const eta = canEstimate
      ? computeEta(progress.remainingMeters, trip.vehicle?.speed, new Date())
      : null;

    return {
      success: true,
      eta: eta
        ? {
            etaTimestamp: eta.etaTimestamp,
            etaSeconds: eta.etaSeconds,
            basisSpeedKmh: eta.basisSpeedKmh,
            remainingMeters: progress.remainingMeters,
            hasVehiclePosition,
          }
        : null,
    };
  }

  /**
   * Per-stop arrival prediction (ETA-03.1). Reuses the destination-ETA machinery:
   * the route-progress `coveredMeters` and the same `computeEta` engine, applying
   * the identical ETA_ACTIVE_STATUSES + live-position guards as getEta. For each
   * remaining stop it derives distance-still-to-cover along the same route polyline
   * (cumulative-to-stop − covered) and predicts an ETA. Passed/completed stops
   * (covered ≥ cumulative) are skipped; order follows the stop sequence.
   */
  async getStopEtas(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { select: { latitude: true, longitude: true, speed: true } },
        stops: { orderBy: { sequence: 'asc' } },
      },
    });

    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const position = this.vehiclePosition(trip.vehicle);
    const progress = computeRouteProgress(this.routePoints(trip), position);
    const hasVehiclePosition = position !== null;

    const canEstimate =
      ETA_ACTIVE_STATUSES.includes(trip.status) && hasVehiclePosition;

    if (!canEstimate) {
      return { success: true, stops: [] };
    }

    const now = new Date();
    const covered = progress.coveredMeters;

    // Walk the same origin → stops polyline routePoints() builds (coordless nodes
    // skipped), accumulating cumulative distance so each stop's remaining distance
    // is measured consistently with `covered`.
    const prefix: GeoPoint[] =
      trip.originLat != null && trip.originLng != null
        ? [{ lat: trip.originLat, lng: trip.originLng }]
        : [];

    const stops: Array<{
      stopId: string;
      sequence: number;
      address: string;
      remainingMeters: number;
      etaTimestamp: string;
      etaSeconds: number;
      basisSpeedKmh: number;
    }> = [];

    for (const stop of trip.stops) {
      if (stop.lat == null || stop.lng == null) continue; // no coords → can't predict

      prefix.push({ lat: stop.lat, lng: stop.lng });
      const remainingToStop = routeTotalDistance(prefix) - covered;
      if (remainingToStop <= 0) continue; // passed / completed stop

      const eta = computeEta(remainingToStop, trip.vehicle?.speed, now);
      stops.push({
        stopId: stop.id,
        sequence: stop.sequence,
        address: stop.address,
        remainingMeters: remainingToStop,
        etaTimestamp: eta.etaTimestamp,
        etaSeconds: eta.etaSeconds,
        basisSpeedKmh: eta.basisSpeedKmh,
      });
    }

    return { success: true, stops };
  }

  /**
   * Delay detection (ETA-05.1) — read-only. A trip is flagged delayed when its
   * reference arrival runs past `scheduledEnd` by more than the margin:
   *  - active trip  → predicted ETA (reuses getEta; falls back to now when no live
   *                   position is available);
   *  - not active but not terminal → the current time;
   *  - COMPLETED / CANCELLED       → never flagged.
   * No status change, no events, no notifications.
   */
  async getDelay(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);

    const marginMinutes = DEFAULT_DELAY_MARGIN_MINUTES;

    // Terminal trips are never flagged.
    if (
      trip.status === TripStatus.COMPLETED ||
      trip.status === TripStatus.CANCELLED
    ) {
      const scheduledEnd = trip.scheduledEnd.toISOString();
      return {
        success: true,
        delay: {
          isDelayed: false,
          delayMinutes: 0,
          marginMinutes,
          scheduledEnd,
          referenceArrival: scheduledEnd,
        },
      };
    }

    let referenceArrival: Date;
    if (ETA_ACTIVE_STATUSES.includes(trip.status)) {
      // Reuse the ETA endpoint's prediction (no duplicated ETA logic).
      const { eta } = await this.getEta(user, id);
      referenceArrival = eta ? new Date(eta.etaTimestamp) : new Date();
    } else {
      // Not active, not terminal (PLANNED / ASSIGNED) → compare current time.
      referenceArrival = new Date();
    }

    return {
      success: true,
      delay: detectDelay(trip.scheduledEnd, referenceArrival, marginMinutes),
    };
  }

  /**
   * ETA alerts (ETA-06.1) — read-only detection foundation. Composes the existing
   * ETA-05.1 delay signal and the ETA engine into raisable alerts: a DELAY alert
   * when the trip runs past schedule, and (when a `baselineEtaTimestamp` is given)
   * an ETA_SHIFT alert when the live ETA has drifted significantly from it. No
   * status change, no persistence, no notification dispatch — delivering these to
   * users is the Notification module's job (not yet built). Access is enforced by
   * the reused getDelay/getEta.
   */
  async getEtaAlerts(user: AuthUser, id: string, query: EtaAlertsQueryDto) {
    const alerts: EtaAlert[] = [];

    // DELAY — reuse ETA-05.1 delay detection verbatim (also enforces read access).
    const { delay } = await this.getDelay(user, id);
    const delayAlert = buildDelayAlert(delay);
    if (delayAlert) alerts.push(delayAlert);

    // ETA_SHIFT — only when the caller supplies a baseline to compare against.
    let baselineEtaTimestamp: string | null = null;
    if (query.baselineEtaTimestamp) {
      baselineEtaTimestamp = query.baselineEtaTimestamp;
      const { eta } = await this.getEta(user, id);
      if (eta) {
        const shiftAlert = buildEtaShiftAlert(
          new Date(query.baselineEtaTimestamp),
          new Date(eta.etaTimestamp),
        );
        if (shiftAlert) alerts.push(shiftAlert);
      }
    }

    return {
      success: true,
      isDelayed: delay.isDelayed,
      baselineEtaTimestamp,
      alerts,
    };
  }

  /**
   * Trip summary report data (RPT-01.1) — counts by status + per-trip rows over a
   * date range, scoped like findAll (CLIENT own trips, ADMIN all or by clientId).
   * One narrow findMany; the status breakdown is derived in memory (no extra query).
   * Shared by the JSON view and the PDF export.
   */
  private async buildTripSummary(user: AuthUser, query: TripReportQueryDto) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = new Date(query.from);
    if (query.to) scheduledStart.lte = new Date(query.to);

    const where: Prisma.TripWhereInput = {
      ...(user.role === 'CLIENT'
        ? { clientId: user.userId }
        : query.clientId
          ? { clientId: query.clientId }
          : {}),
      ...(query.from || query.to ? { scheduledStart } : {}),
    };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        id: true,
        reference: true,
        origin: true,
        destination: true,
        status: true,
        scheduledStart: true,
        driverName: true,
        vehicle: { select: { vehicleNumber: true } },
      },
      orderBy: { scheduledStart: 'desc' },
    });

    const statuses: TripStatus[] = [
      TripStatus.PLANNED,
      TripStatus.ASSIGNED,
      TripStatus.STARTED,
      TripStatus.ONGOING,
      TripStatus.DELAYED,
      TripStatus.COMPLETED,
      TripStatus.CANCELLED,
    ];
    const byStatus = statuses.map((status) => ({
      status,
      count: trips.filter((trip) => trip.status === status).length,
    }));

    const rows = trips.map((trip) => ({
      tripId: trip.id,
      reference: trip.reference,
      origin: trip.origin,
      destination: trip.destination,
      status: trip.status,
      scheduledStart: trip.scheduledStart.toISOString(),
      vehicleNumber: trip.vehicle?.vehicleNumber ?? null,
      driverName: trip.driverName ?? null,
    }));

    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      total: trips.length,
      byStatus,
      rows,
    };
  }

  /** Trip summary report as JSON for the report view (RPT-01.1). */
  async getSummaryReport(user: AuthUser, query: TripReportQueryDto) {
    const report = await this.buildTripSummary(user, query);
    return { success: true, ...report };
  }

  /**
   * Trip summary report as a PDF (RPT-01.2 export). Reuses buildTripSummary for the
   * data and the same pdfkit-to-Buffer approach as the vehicle/cost reports — no
   * duplicated report query, no duplicated PDF generation.
   */
  async generateSummaryPdf(
    user: AuthUser,
    query: TripReportQueryDto,
  ): Promise<Buffer> {
    const { range, total, byStatus, rows } = await this.buildTripSummary(
      user,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Trip Summary Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(`Total trips: ${total}`);
      doc.moveDown();

      doc.fontSize(13).text('By status');
      for (const entry of byStatus) {
        doc.fontSize(10).text(`${entry.status}: ${entry.count}`);
      }
      doc.moveDown();

      doc.fontSize(13).text('Trips');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.reference}  ${row.origin} -> ${row.destination}  [${row.status}]  ${row.vehicleNumber ?? '-'} / ${row.driverName ?? '-'}`,
          );
      }

      doc.end();
    });
  }

  /**
   * Driver performance report data (RPT-02.1) — per-driver trip statistics over a
   * date range, scoped like findAll (CLIENT own trips, ADMIN all or by clientId).
   * One narrow findMany; every metric is derived in memory (no extra query, no N+1).
   *
   * Reuses the app-wide delay rule (ETA-05.1 detectDelay + DEFAULT_DELAY_MARGIN_
   * MINUTES) for on-time vs late deliveries — the exact definition DSH-04 uses — and
   * the same "active" bucket (STARTED/ONGOING/DELAYED) as the dashboard trip summary.
   * Trips with no assigned driver are excluded from the per-driver breakdown.
   */
  private async buildDriverPerformance(
    user: AuthUser,
    query: DriverReportQueryDto,
  ) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = new Date(query.from);
    if (query.to) scheduledStart.lte = new Date(query.to);

    const where: Prisma.TripWhereInput = {
      driverId: { not: null },
      ...(user.role === 'CLIENT'
        ? { clientId: user.userId }
        : query.clientId
          ? { clientId: query.clientId }
          : {}),
      ...(query.from || query.to ? { scheduledStart } : {}),
    };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        driverId: true,
        driverName: true,
        status: true,
        distanceKm: true,
        scheduledEnd: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: { scheduledStart: 'desc' },
    });

    const activeStatuses: TripStatus[] = [
      TripStatus.STARTED,
      TripStatus.ONGOING,
      TripStatus.DELAYED,
    ];

    // Aggregate per driver (keyed by driverId; the where filter guarantees non-null).
    const byDriver = new Map<string, DriverPerfAccumulator>();
    for (const trip of trips) {
      if (!trip.driverId) continue;
      let acc = byDriver.get(trip.driverId);
      if (!acc) {
        acc = {
          driverId: trip.driverId,
          driverName: trip.driverName ?? null,
          totalTrips: 0,
          completed: 0,
          active: 0,
          cancelled: 0,
          onTime: 0,
          delayed: 0,
          totalDistanceKm: 0,
          durationSum: 0,
          durationCount: 0,
        };
        byDriver.set(trip.driverId, acc);
      }
      if (!acc.driverName && trip.driverName) acc.driverName = trip.driverName;

      acc.totalTrips += 1;
      acc.totalDistanceKm += trip.distanceKm;

      if (trip.status === TripStatus.COMPLETED) {
        acc.completed += 1;
        // completedAt is stamped on the COMPLETED transition; fall back defensively.
        const arrival = trip.completedAt ?? trip.scheduledEnd;
        if (
          detectDelay(trip.scheduledEnd, arrival, DEFAULT_DELAY_MARGIN_MINUTES)
            .isDelayed
        ) {
          acc.delayed += 1;
        } else {
          acc.onTime += 1;
        }
        if (trip.startedAt && trip.completedAt) {
          const mins = Math.round(
            (trip.completedAt.getTime() - trip.startedAt.getTime()) / 60000,
          );
          if (mins >= 0) {
            acc.durationSum += mins;
            acc.durationCount += 1;
          }
        }
      } else if (activeStatuses.includes(trip.status)) {
        acc.active += 1;
      } else if (trip.status === TripStatus.CANCELLED) {
        acc.cancelled += 1;
      }
    }

    const pct = (part: number, whole: number) =>
      whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const rows = [...byDriver.values()]
      .map((a) => ({
        driverId: a.driverId,
        driverName: a.driverName,
        totalTrips: a.totalTrips,
        completed: a.completed,
        active: a.active,
        cancelled: a.cancelled,
        onTime: a.onTime,
        delayed: a.delayed,
        completionRate: pct(a.completed, a.totalTrips),
        onTimeRate: pct(a.onTime, a.completed),
        totalDistanceKm: round1(a.totalDistanceKm),
        avgDurationMins:
          a.durationCount === 0
            ? 0
            : Math.round(a.durationSum / a.durationCount),
      }))
      .sort((x, y) => y.totalTrips - x.totalTrips);

    const totals = rows.reduce(
      (t, r) => ({
        drivers: t.drivers + 1,
        trips: t.trips + r.totalTrips,
        completed: t.completed + r.completed,
        active: t.active + r.active,
        cancelled: t.cancelled + r.cancelled,
        onTime: t.onTime + r.onTime,
        delayed: t.delayed + r.delayed,
        totalDistanceKm: round1(t.totalDistanceKm + r.totalDistanceKm),
      }),
      {
        drivers: 0,
        trips: 0,
        completed: 0,
        active: 0,
        cancelled: 0,
        onTime: 0,
        delayed: 0,
        totalDistanceKm: 0,
      },
    );

    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      totals,
      rows,
    };
  }

  /** Driver performance report as JSON for the report view (RPT-02.1). */
  async getDriverReport(user: AuthUser, query: DriverReportQueryDto) {
    const report = await this.buildDriverPerformance(user, query);
    return { success: true, ...report };
  }

  /**
   * Driver performance report as a PDF (RPT-02.3 export). Reuses buildDriverPerformance
   * for the data and the same pdfkit-to-Buffer approach as the trip/cost reports — no
   * duplicated report query, no duplicated PDF generation.
   */
  async generateDriverPdf(
    user: AuthUser,
    query: DriverReportQueryDto,
  ): Promise<Buffer> {
    const { range, totals, rows } = await this.buildDriverPerformance(
      user,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Driver Performance Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(
        `Drivers: ${totals.drivers}  Trips: ${totals.trips}  Completed: ${totals.completed}  On-time: ${totals.onTime}  Late: ${totals.delayed}`,
      );
      doc.moveDown();

      doc.fontSize(13).text('By driver');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.driverName ?? row.driverId}: ${row.totalTrips} trips, ${row.completed} completed (${row.completionRate}%), ${row.onTime} on-time (${row.onTimeRate}%), ${row.delayed} late, ${row.totalDistanceKm} km, avg ${row.avgDurationMins} min`,
          );
      }

      doc.end();
    });
  }

  /**
   * Vehicle utilization report data (RPT-03.1) — per-vehicle trip statistics over a
   * date range, scoped like findAll (CLIENT own trips, ADMIN all or by clientId). One
   * narrow findMany; every metric is derived in memory (no extra query, no N+1). Reuses
   * the driver-report aggregation pattern (RPT-02) and the same delay/active definitions
   * (ETA-05.1 detectDelay, DSH-04 on-time rule, DSH "active" bucket).
   *
   * Utilization is time-based: each vehicle's busy time (completed → actual elapsed
   * completedAt−startedAt, falling back to the scheduled window; active → scheduled
   * window; cancelled/upcoming → none) as a share of the reporting window. The window
   * is the requested from→to, or the observed scheduledStart→scheduledEnd span across
   * all in-scope trips when a bound is omitted — one shared denominator so vehicles are
   * comparable. Unlike driverName, vehicleNumber/vehicleName live on the Vehicle
   * relation (not the Trip), so they are included for the label. Trips with no assigned
   * vehicle are excluded.
   */
  private async buildVehicleUtilization(
    user: AuthUser,
    query: VehicleReportQueryDto,
  ) {
    const scheduledStart: Prisma.DateTimeFilter = {};
    if (query.from) scheduledStart.gte = new Date(query.from);
    if (query.to) scheduledStart.lte = new Date(query.to);

    const where: Prisma.TripWhereInput = {
      vehicleId: { not: null },
      ...(user.role === 'CLIENT'
        ? { clientId: user.userId }
        : query.clientId
          ? { clientId: query.clientId }
          : {}),
      ...(query.from || query.to ? { scheduledStart } : {}),
    };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        vehicleId: true,
        vehicle: { select: { vehicleNumber: true, vehicleName: true } },
        status: true,
        distanceKm: true,
        scheduledStart: true,
        scheduledEnd: true,
        startedAt: true,
        completedAt: true,
      },
      orderBy: { scheduledStart: 'desc' },
    });

    const activeStatuses: TripStatus[] = [
      TripStatus.STARTED,
      TripStatus.ONGOING,
      TripStatus.DELAYED,
    ];

    // Shared utilization window: requested bounds, else the observed trip span.
    let observedStart = Number.POSITIVE_INFINITY;
    let observedEnd = Number.NEGATIVE_INFINITY;
    for (const trip of trips) {
      observedStart = Math.min(observedStart, trip.scheduledStart.getTime());
      observedEnd = Math.max(observedEnd, trip.scheduledEnd.getTime());
    }
    const windowStart = query.from
      ? new Date(query.from).getTime()
      : observedStart;
    const windowEnd = query.to ? new Date(query.to).getTime() : observedEnd;
    const windowMinutes =
      Number.isFinite(windowStart) && Number.isFinite(windowEnd)
        ? Math.max(0, Math.round((windowEnd - windowStart) / 60000))
        : 0;

    // Aggregate per vehicle (keyed by vehicleId; the where filter guarantees non-null).
    const byVehicle = new Map<string, VehiclePerfAccumulator>();
    for (const trip of trips) {
      if (!trip.vehicleId) continue;
      let acc = byVehicle.get(trip.vehicleId);
      if (!acc) {
        acc = {
          vehicleId: trip.vehicleId,
          vehicleNumber: trip.vehicle?.vehicleNumber ?? null,
          vehicleName: trip.vehicle?.vehicleName ?? null,
          totalTrips: 0,
          completed: 0,
          active: 0,
          cancelled: 0,
          onTime: 0,
          delayed: 0,
          totalDistanceKm: 0,
          durationSum: 0,
          durationCount: 0,
          engagedMinutes: 0,
        };
        byVehicle.set(trip.vehicleId, acc);
      }

      acc.totalTrips += 1;
      acc.totalDistanceKm += trip.distanceKm;

      const scheduledMinutes = Math.max(
        0,
        Math.round(
          (trip.scheduledEnd.getTime() - trip.scheduledStart.getTime()) / 60000,
        ),
      );

      if (trip.status === TripStatus.COMPLETED) {
        acc.completed += 1;
        // completedAt is stamped on the COMPLETED transition; fall back defensively.
        const arrival = trip.completedAt ?? trip.scheduledEnd;
        if (
          detectDelay(trip.scheduledEnd, arrival, DEFAULT_DELAY_MARGIN_MINUTES)
            .isDelayed
        ) {
          acc.delayed += 1;
        } else {
          acc.onTime += 1;
        }
        if (trip.startedAt && trip.completedAt) {
          const mins = Math.round(
            (trip.completedAt.getTime() - trip.startedAt.getTime()) / 60000,
          );
          if (mins >= 0) {
            acc.durationSum += mins;
            acc.durationCount += 1;
            acc.engagedMinutes += mins;
          } else {
            acc.engagedMinutes += scheduledMinutes;
          }
        } else {
          acc.engagedMinutes += scheduledMinutes;
        }
      } else if (activeStatuses.includes(trip.status)) {
        acc.active += 1;
        acc.engagedMinutes += scheduledMinutes;
      } else if (trip.status === TripStatus.CANCELLED) {
        acc.cancelled += 1;
      }
    }

    const pct = (part: number, whole: number) =>
      whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const rows = [...byVehicle.values()]
      .map((a) => ({
        vehicleId: a.vehicleId,
        vehicleNumber: a.vehicleNumber,
        vehicleName: a.vehicleName,
        totalTrips: a.totalTrips,
        completed: a.completed,
        active: a.active,
        cancelled: a.cancelled,
        onTime: a.onTime,
        delayed: a.delayed,
        completionRate: pct(a.completed, a.totalTrips),
        onTimeRate: pct(a.onTime, a.completed),
        utilizationPct:
          windowMinutes === 0
            ? 0
            : Math.min(100, round1((a.engagedMinutes / windowMinutes) * 100)),
        totalDistanceKm: round1(a.totalDistanceKm),
        avgDurationMins:
          a.durationCount === 0
            ? 0
            : Math.round(a.durationSum / a.durationCount),
      }))
      .sort((x, y) => y.utilizationPct - x.utilizationPct);

    const totals = rows.reduce(
      (t, r) => ({
        vehicles: t.vehicles + 1,
        trips: t.trips + r.totalTrips,
        completed: t.completed + r.completed,
        active: t.active + r.active,
        cancelled: t.cancelled + r.cancelled,
        onTime: t.onTime + r.onTime,
        delayed: t.delayed + r.delayed,
        totalDistanceKm: round1(t.totalDistanceKm + r.totalDistanceKm),
      }),
      {
        vehicles: 0,
        trips: 0,
        completed: 0,
        active: 0,
        cancelled: 0,
        onTime: 0,
        delayed: 0,
        totalDistanceKm: 0,
      },
    );

    const avgUtilizationPct =
      rows.length === 0
        ? 0
        : round1(rows.reduce((s, r) => s + r.utilizationPct, 0) / rows.length);

    return {
      range: { from: query.from ?? null, to: query.to ?? null },
      totals: { ...totals, avgUtilizationPct },
      rows,
    };
  }

  /** Vehicle utilization report as JSON for the report view (RPT-03.1). */
  async getVehicleReport(user: AuthUser, query: VehicleReportQueryDto) {
    const report = await this.buildVehicleUtilization(user, query);
    return { success: true, ...report };
  }

  /**
   * Vehicle utilization report as a PDF (RPT-03.3 export). Reuses buildVehicleUtilization
   * for the data and the same pdfkit-to-Buffer approach as the trip/driver/cost reports —
   * no duplicated report query, no duplicated PDF generation.
   */
  async generateVehiclePdf(
    user: AuthUser,
    query: VehicleReportQueryDto,
  ): Promise<Buffer> {
    const { range, totals, rows } = await this.buildVehicleUtilization(
      user,
      query,
    );

    const doc = new PDFDocument({ margin: 50 });
    const buffers: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));

    return new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      doc.fontSize(20).text('Vehicle Utilization Report', { align: 'center' });
      doc.moveDown();

      const period =
        range.from || range.to
          ? `${range.from ?? '…'} to ${range.to ?? '…'}`
          : 'All time';
      doc.fontSize(10).text(`Period: ${period}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(
        `Vehicles: ${totals.vehicles}  Trips: ${totals.trips}  Completed: ${totals.completed}  Avg utilization: ${totals.avgUtilizationPct}%`,
      );
      doc.moveDown();

      doc.fontSize(13).text('By vehicle');
      for (const row of rows) {
        doc
          .fontSize(9)
          .text(
            `${row.vehicleNumber ?? row.vehicleId}: ${row.totalTrips} trips, ${row.completed} completed, ${row.onTime} on-time (${row.onTimeRate}%), ${row.delayed} late, ${row.utilizationPct}% util, ${row.totalDistanceKm} km, avg ${row.avgDurationMins} min`,
          );
      }

      doc.end();
    });
  }

  /**
   * Resource availability check (TM-09 / TM-10). Returns the active trips that
   * double-book a candidate vehicle OR driver for the given window. A CLIENT is
   * scoped to its own trips; an ADMIN checks across all trips.
   */
  async checkOverlap(user: AuthUser, query: OverlapQueryDto) {
    const resourceCount = [query.vehicleId, query.driverId].filter(
      Boolean,
    ).length;
    if (resourceCount !== 1) {
      throw new BadRequestException(
        'Provide exactly one of vehicleId or driverId',
      );
    }

    const start = new Date(query.start);
    const end = new Date(query.end);
    // An empty/invalid window can't clash with anything.
    if (!(end > start)) {
      return { success: true, hasOverlap: false, conflicts: [] };
    }

    const conflicts = await this.findOverlapConflicts({
      clientId: user.role === 'CLIENT' ? user.userId : undefined,
      vehicleId: query.vehicleId,
      driverId: query.driverId,
      start,
      end,
      excludeTripId: query.excludeTripId,
    });

    return { success: true, hasOverlap: conflicts.length > 0, conflicts };
  }

  /* ---------------------------------------------------------------- */
  /* Writes (CLIENT only — enforced by @Roles + ownership below)       */
  /* ---------------------------------------------------------------- */

  async create(user: AuthUser, dto: CreateTripDto) {
    // A linked customer must belong to this client (CUS-07.1) — the server-side
    // guarantee behind the form only listing the client's own customers.
    await this.assertOwnedCustomer(user.userId, dto.customerId);

    // Reject double-booking of the vehicle/driver (409 VEHICLE_OVERLAP /
    // DRIVER_OVERLAP) — the server-side guarantee behind the client pre-check.
    await this.assertNoResourceOverlap(user.userId, {
      vehicleId: dto.vehicleId,
      driverId: dto.driverId,
      start: new Date(dto.scheduledStart),
      end: new Date(dto.scheduledEnd),
    });

    const actor = await this.resolveActor(user);

    // Geocode addresses server-side (single source of truth) unless the caller
    // already supplied coordinates — this makes stored coords, and therefore
    // route/progress/deviation, real.
    const origin = await this.resolveCoords(
      dto.origin,
      dto.originLat,
      dto.originLng,
    );
    const destination = await this.resolveCoords(
      dto.destination,
      dto.destinationLat,
      dto.destinationLng,
    );
    const stops = await this.resolveStopCoords(dto.stops ?? []);

    // TM-01.2: a trip created with both a vehicle and a driver is already
    // assigned, so it persists as ASSIGNED; it only rests in PLANNED when
    // created without an assignment.
    const initialStatus =
      dto.vehicleId && dto.driverId ? TripStatus.ASSIGNED : TripStatus.PLANNED;

    const trip = await this.prisma.trip.create({
      data: {
        reference: dto.reference ?? this.generateReference(),
        status: initialStatus,
        clientId: user.userId, // owner is always the authenticated client
        vehicleId: dto.vehicleId ?? null,
        driverId: dto.driverId ?? null,
        driverName: dto.driverName ?? null,
        customerId: dto.customerId ?? null,
        origin: dto.origin,
        originLat: origin.lat,
        originLng: origin.lng,
        destination: dto.destination,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
        distanceKm: dto.distanceKm ?? 0,
        durationMins: dto.durationMins ?? 0,
        notes: dto.notes ?? null,
        scheduledStart: new Date(dto.scheduledStart),
        scheduledEnd: new Date(dto.scheduledEnd),
        stops: {
          create: stops,
        },
        events: {
          create: {
            action: TripEventAction.CREATED,
            status: initialStatus,
            note: STATUS_NOTE[initialStatus],
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async update(user: AuthUser, id: string, dto: UpdateTripDto) {
    const existing = await this.getOwned(user, id);

    // A (re)linked customer must belong to this client (CUS-07.1).
    await this.assertOwnedCustomer(user.userId, dto.customerId);

    // TM-05.1: stops may only be edited before the trip starts.
    if (
      dto.stops !== undefined &&
      !STOP_EDITABLE_STATUSES.includes(existing.status)
    ) {
      throw new BadRequestException('STOPS_LOCKED');
    }

    // Re-check availability against the effective resource + window after the
    // patch, excluding this trip from its own check.
    await this.assertNoResourceOverlap(user.userId, {
      vehicleId: dto.vehicleId ?? existing.vehicleId,
      driverId: dto.driverId ?? existing.driverId,
      start: dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : existing.scheduledStart,
      end: dto.scheduledEnd ? new Date(dto.scheduledEnd) : existing.scheduledEnd,
      excludeTripId: id,
    });

    const actor = await this.resolveActor(user);

    const data: Prisma.TripUncheckedUpdateInput = {
      reference: dto.reference,
      vehicleId: dto.vehicleId,
      driverId: dto.driverId,
      driverName: dto.driverName,
      customerId: dto.customerId,
      distanceKm: dto.distanceKm,
      durationMins: dto.durationMins,
      notes: dto.notes,
      scheduledStart: dto.scheduledStart
        ? new Date(dto.scheduledStart)
        : undefined,
      scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
      events: {
        create: {
          action: TripEventAction.UPDATED,
          note: 'Trip details updated',
          actorRole: actor.role,
          actorName: actor.name,
        },
      },
    };

    // Re-geocode origin/destination whenever they change (unless coords supplied).
    if (dto.origin !== undefined) {
      const origin = await this.resolveCoords(
        dto.origin,
        dto.originLat,
        dto.originLng,
      );
      data.origin = dto.origin;
      data.originLat = origin.lat;
      data.originLng = origin.lng;
    }
    if (dto.destination !== undefined) {
      const destination = await this.resolveCoords(
        dto.destination,
        dto.destinationLat,
        dto.destinationLng,
      );
      data.destination = dto.destination;
      data.destinationLat = destination.lat;
      data.destinationLng = destination.lng;
    }

    // TM-05.1: replace the whole stop list — delete existing stops and recreate
    // them in the new order with a fresh 1-based sequence + geocoded coords. One
    // atomic write covers add / remove / reorder.
    if (dto.stops !== undefined) {
      const stops = await this.resolveStopCoords(dto.stops);
      data.stops = {
        deleteMany: {},
        create: stops,
      };
    }

    const trip = await this.prisma.trip.update({
      where: { id },
      data,
      include: tripInclude,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async updateStatus(user: AuthUser, id: string, dto: UpdateTripStatusDto) {
    const existing = await this.getOwned(user, id);

    if (!TRANSITIONS[existing.status].includes(dto.status)) {
      throw new BadRequestException(
        `Cannot change status from ${existing.status} to ${dto.status}`,
      );
    }

    const actor = await this.resolveActor(user);
    const now = new Date();
    const startsNow =
      dto.status === TripStatus.STARTED || dto.status === TripStatus.ONGOING;

    const trip = await this.prisma.trip.update({
      where: { id },
      data: {
        status: dto.status,
        startedAt: startsNow && !existing.startedAt ? now : undefined,
        completedAt: dto.status === TripStatus.COMPLETED ? now : undefined,
        events: {
          create: {
            action: TripEventAction.STATUS_CHANGED,
            status: dto.status,
            note: STATUS_NOTE[dto.status],
            actorRole: actor.role,
            actorName: actor.name,
          },
        },
      },
      include: tripInclude,
    });

    // NOT-01.2 / NOT-02.1 / NOT-03.1: raise an in-portal notification for the meaningful
    // transitions (started / delayed / completed). Reuses the same transition that already
    // writes the STATUS_CHANGED event; the notifications service decides which statuses
    // actually notify, so this call stays a single line and adds no logic to the trip flow.
    await this.notifications.onTripStatusChanged({
      id: trip.id,
      reference: trip.reference,
      clientId: trip.clientId,
      status: trip.status,
    });

    return { success: true, trip: this.mapTrip(trip) };
  }

  async remove(user: AuthUser, id: string) {
    await this.getOwned(user, id);
    await this.prisma.trip.delete({ where: { id } });
    return { success: true };
  }

  /* ---------------------------------------------------------------- */
  /* Access helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** A trip a CLIENT owns or an ADMIN may read; throws otherwise. */
  private async getReadable(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: tripInclude,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    this.assertReadable(user, trip.clientId);
    return trip;
  }

  /** A trip the authenticated CLIENT owns; throws otherwise. */
  private async getOwned(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.clientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
    return trip;
  }

  private assertReadable(user: AuthUser, ownerClientId: string) {
    if (user.role === 'CLIENT' && ownerClientId !== user.userId) {
      throw new ForbiddenException('Not your trip');
    }
  }

  /**
   * A trip may only be linked to a customer the client owns (CUS-07.1). No-op when
   * no customer is being set; throws 400 INVALID_CUSTOMER otherwise.
   */
  private async assertOwnedCustomer(
    clientId: string,
    customerId?: string | null,
  ) {
    if (!customerId) return;
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, clientId },
    });
    if (!customer) throw new BadRequestException('INVALID_CUSTOMER');
  }

  private async resolveActor(
    user: AuthUser,
  ): Promise<{ role: string; name: string | null }> {
    if (user.role === 'CLIENT') {
      const client = await this.prisma.client.findUnique({
        where: { id: user.userId },
        select: { name: true },
      });
      return { role: 'CLIENT', name: client?.name ?? null };
    }
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true },
    });
    return { role: user.role, name: account?.name ?? null };
  }

  private generateReference(): string {
    const year = new Date().getFullYear();
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `TRIP-${year}-${rand}`;
  }

  /* ---------------------------------------------------------------- */
  /* Geocoding (server-side, via GeocodingService — single source)     */
  /* ---------------------------------------------------------------- */

  /** Use caller-supplied coordinates when present, else geocode the address. */
  private async resolveCoords(
    address: string,
    lat?: number | null,
    lng?: number | null,
  ): Promise<{ lat: number | null; lng: number | null }> {
    if (typeof lat === 'number' && typeof lng === 'number') {
      return { lat, lng };
    }
    const point = await this.geocoding.geocode(address);
    return { lat: point?.lat ?? null, lng: point?.lng ?? null };
  }

  /** Resolve coordinates for each stop (sequential; assigns a 1-based sequence). */
  private async resolveStopCoords(stops: NonNullable<CreateTripDto['stops']>) {
    const out: {
      address: string;
      sequence: number;
      lat: number | null;
      lng: number | null;
    }[] = [];
    for (let i = 0; i < stops.length; i++) {
      const coords = await this.resolveCoords(
        stops[i].address,
        stops[i].lat,
        stops[i].lng,
      );
      out.push({
        address: stops[i].address,
        sequence: i + 1,
        lat: coords.lat,
        lng: coords.lng,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Overlap (double-booking) — one canonical query for check + guard  */
  /* ---------------------------------------------------------------- */

  /**
   * Active trips that book the same vehicle or driver during [start, end).
   * Half-open interval — touching edges (one ends exactly as the next begins) do
   * NOT clash — matching the client-side check. COMPLETED and CANCELLED trips have
   * released the resource, so they never block. When `clientId` is given the scan
   * is scoped to that client's trips.
   */
  private async findOverlapConflicts(params: {
    clientId?: string;
    vehicleId?: string | null;
    driverId?: string | null;
    start: Date;
    end: Date;
    excludeTripId?: string;
  }) {
    const where: Prisma.TripWhereInput = {
      status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] },
      scheduledStart: { lt: params.end },
      scheduledEnd: { gt: params.start },
    };

    if (params.clientId) where.clientId = params.clientId;
    if (params.vehicleId) where.vehicleId = params.vehicleId;
    if (params.driverId) where.driverId = params.driverId;
    if (params.excludeTripId) where.id = { not: params.excludeTripId };

    const trips = await this.prisma.trip.findMany({
      where,
      select: {
        id: true,
        reference: true,
        scheduledStart: true,
        scheduledEnd: true,
        status: true,
      },
      orderBy: { scheduledStart: 'asc' },
    });

    return trips.map((t) => ({
      tripId: t.id,
      reference: t.reference,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      status: t.status,
    }));
  }

  /**
   * Throws 409 VEHICLE_OVERLAP / DRIVER_OVERLAP if the vehicle or driver is already
   * booked for an overlapping window. Reuses findOverlapConflicts so the create /
   * update guard and the check endpoint share one algorithm.
   */
  private async assertNoResourceOverlap(
    clientId: string,
    params: {
      vehicleId?: string | null;
      driverId?: string | null;
      start: Date;
      end: Date;
      excludeTripId?: string;
    },
  ) {
    if (params.vehicleId) {
      const conflicts = await this.findOverlapConflicts({
        clientId,
        vehicleId: params.vehicleId,
        start: params.start,
        end: params.end,
        excludeTripId: params.excludeTripId,
      });
      if (conflicts.length > 0) {
        throw new ConflictException('VEHICLE_OVERLAP');
      }
    }

    if (params.driverId) {
      const conflicts = await this.findOverlapConflicts({
        clientId,
        driverId: params.driverId,
        start: params.start,
        end: params.end,
        excludeTripId: params.excludeTripId,
      });
      if (conflicts.length > 0) {
        throw new ConflictException('DRIVER_OVERLAP');
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Shaping helpers (Prisma row -> API shape the frontend consumes)   */
  /* ---------------------------------------------------------------- */

  private routePoints(trip: {
    originLat: number | null;
    originLng: number | null;
    destinationLat: number | null;
    destinationLng: number | null;
    stops: { lat: number | null; lng: number | null }[];
  }): GeoPoint[] {
    const points: GeoPoint[] = [];
    if (trip.originLat != null && trip.originLng != null) {
      points.push({ lat: trip.originLat, lng: trip.originLng });
    }
    for (const s of trip.stops) {
      if (s.lat != null && s.lng != null) {
        points.push({ lat: s.lat, lng: s.lng });
      }
    }
    if (trip.destinationLat != null && trip.destinationLng != null) {
      points.push({ lat: trip.destinationLat, lng: trip.destinationLng });
    }
    return points;
  }

  private vehiclePosition(
    vehicle: { latitude: number; longitude: number } | null,
  ): GeoPoint | null {
    if (!vehicle) return null;
    const { latitude, longitude } = vehicle;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return null;
    }
    if (latitude === 0 && longitude === 0) return null;
    return { lat: latitude, lng: longitude };
  }

  private mapTrip(t: any) {
    return {
      id: t.id,
      reference: t.reference,
      status: t.status,
      clientId: t.clientId,
      client: t.client
        ? { id: t.client.id, name: t.client.name }
        : { id: t.clientId, name: '' },
      vehicleId: t.vehicleId,
      vehicle: t.vehicle
        ? {
            id: t.vehicle.id,
            vehicleNumber: t.vehicle.vehicleNumber,
            vehicleName: t.vehicle.vehicleName,
          }
        : null,
      driverId: t.driverId,
      driverName: t.driverName,
      customerId: t.customerId,
      customer: t.customer
        ? { id: t.customer.id, name: t.customer.name }
        : null,
      origin: t.origin,
      originCoords:
        t.originLat != null && t.originLng != null
          ? { lat: t.originLat, lng: t.originLng }
          : undefined,
      destination: t.destination,
      destinationCoords:
        t.destinationLat != null && t.destinationLng != null
          ? { lat: t.destinationLat, lng: t.destinationLng }
          : undefined,
      stops: (t.stops ?? []).map((s: any) => ({
        id: s.id,
        address: s.address,
        sequence: s.sequence,
        coords:
          s.lat != null && s.lng != null
            ? { lat: s.lat, lng: s.lng }
            : undefined,
      })),
      distanceKm: t.distanceKm,
      durationMins: t.durationMins,
      notes: t.notes,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private mapEvent(e: any) {
    return {
      id: e.id,
      tripId: e.tripId,
      action: e.action,
      status: e.status ?? null,
      note: e.note ?? null,
      actor: { role: e.actorRole, name: e.actorName ?? null },
      timestamp: e.createdAt,
    };
  }
}
