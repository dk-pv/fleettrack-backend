import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GpsIntegration, GpsProviderName } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AiroTrackAdapter } from './airotrack.adapter';
import { TransightAdapter } from './transight.adapter';
import { GpsProvider } from './gps-provider.interface';
import { UpsertIntegrationDto } from './dto/upsert-integration.dto';

const MASK = '••••••••';

/**
 * Owns GPS provider configuration + credentials (backend only). Builds/caches the
 * provider adapters (so the Transight inventory cache survives across sync ticks),
 * and exposes a masked admin config API. Credentials NEVER leave this service in a
 * response — reads return `hasCredential` + a masked placeholder only.
 */
@Injectable()
export class GpsIntegrationService implements OnModuleInit {
  private readonly logger = new Logger(GpsIntegrationService.name);
  private readonly adapters = new Map<GpsProviderName, GpsProvider>();

  constructor(private prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedAiroTrackFromEnv();
  }

  /**
   * Transition helper: if no AiroTrack row exists yet, seed one from the working
   * AIROTRACK_API env token so the current sync keeps running under the new config.
   * Never overwrites an existing row; the token stays server-side.
   */
  private async seedAiroTrackFromEnv(): Promise<void> {
    try {
      const existing = await this.prisma.gpsIntegration.findUnique({
        where: { provider: 'AIROTRACK' },
      });
      if (existing) return;

      const raw = process.env.AIROTRACK_API;
      if (!raw) return;

      const [baseUrl, token] = GpsIntegrationService.splitAiroTrackEnv(raw);
      await this.prisma.gpsIntegration.create({
        data: {
          provider: 'AIROTRACK',
          active: true,
          baseUrl,
          credential: token,
          pollIntervalSec: 60,
        },
      });
      this.logger.log('Seeded AiroTrack GPS integration from AIROTRACK_API env.');
    } catch (e) {
      this.logger.warn(
        `AiroTrack env seed skipped: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Split "…/positionsByToken?token=XXX" into [baseUrl, token]. */
  static splitAiroTrackEnv(raw: string): [string, string] {
    const m = raw.match(/^(.*?)[?&]token=(.*)$/);
    if (m) return [m[1], decodeURIComponent(m[2])];
    return [raw, ''];
  }

  /** Active providers with a usable credential, as ready-to-poll adapters. */
  async getActiveProviders(): Promise<
    { config: GpsIntegration; provider: GpsProvider }[]
  > {
    const rows = await this.prisma.gpsIntegration.findMany({
      where: { active: true },
    });

    const out: { config: GpsIntegration; provider: GpsProvider }[] = [];
    for (const row of rows) {
      if (!row.credential) continue;
      const provider = this.buildAdapter(row);
      if (provider) out.push({ config: row, provider });
    }
    return out;
  }

  private buildAdapter(row: GpsIntegration): GpsProvider | null {
    const config = {
      baseUrl: row.baseUrl,
      credential: row.credential ?? '',
      system: row.system,
    };

    let adapter = this.adapters.get(row.provider);
    if (row.provider === 'AIROTRACK') {
      if (adapter instanceof AiroTrackAdapter) adapter.setConfig(config);
      else adapter = new AiroTrackAdapter(config);
    } else if (row.provider === 'TRANSIGHT') {
      if (adapter instanceof TransightAdapter) adapter.setConfig(config);
      else adapter = new TransightAdapter(config);
    } else {
      return null;
    }

    this.adapters.set(row.provider, adapter);
    return adapter;
  }

  async markSynced(
    provider: GpsProviderName,
    error?: string | null,
  ): Promise<void> {
    await this.prisma.gpsIntegration
      .update({
        where: { provider },
        data: { lastSyncedAt: new Date(), lastError: error ?? null },
      })
      .catch(() => undefined);
  }

  /* ---- Admin config API (masked reads) ---- */

  async list() {
    const rows = await this.prisma.gpsIntegration.findMany({
      orderBy: { provider: 'asc' },
    });
    return { success: true, integrations: rows.map((r) => this.mask(r)) };
  }

  async upsert(provider: GpsProviderName, dto: UpsertIntegrationDto) {
    const base = {
      baseUrl: dto.baseUrl,
      active: dto.active,
      system: dto.system ?? null,
      pollIntervalSec: dto.pollIntervalSec ?? 300,
    };

    const row = await this.prisma.gpsIntegration.upsert({
      where: { provider },
      // Only overwrite the credential when a new one is supplied.
      update: dto.credential ? { ...base, credential: dto.credential } : base,
      create: { provider, ...base, credential: dto.credential ?? null },
    });

    return { success: true, integration: this.mask(row) };
  }

  private mask(row: GpsIntegration) {
    const { credential, ...rest } = row;
    return { ...rest, hasCredential: !!credential, credential: credential ? MASK : null };
  }
}
