import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { assertClinicWideScope } from '../../shared/authorisation/site-scope';
import { Public, RequirePermission } from '../../shared/http/auth.decorators';
import { AllowHttpCache } from '../../shared/http/interceptors/no-store.interceptor';

import { TariffPublicationService } from './application/tariff-publication.service';
import type { TariffDifference, TariffLine } from './domain/tariff-publication';
import type {
  TariffPublicationSummary,
  TariffPublicationView,
} from './domain/tariff-publication.repository';
import {
  PublicTariffDto,
  TariffPublicationDto,
  TariffPublicationOverviewDto,
  type PublicTariffResponse,
  type TariffPublicationOverviewResponse,
  type TariffPublicationResponse,
} from './dto/tariff-publication.dto';

/**
 * BI-113, BI-115. Publishing the tariff, and reading what was published.
 *
 * `global`, like the rest of the tariff: what the clinic charges is the
 * clinic's, not a site's (D-023), and publishing is backed by
 * `assertClinicWideScope` for the same reason as changing a price.
 */
@ApiTags('billing')
@Controller({ path: 'billing/tariff-publications', version: '1' })
export class TariffPublicationController {
  constructor(
    private readonly publications: TariffPublicationService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** BI-113, BI-115. Every version, and whether the newest still holds. */
  @Get()
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar las publicaciones del tarifario' })
  @ApiOkResponse({ type: TariffPublicationOverviewDto })
  async overview(): Promise<TariffPublicationOverviewResponse> {
    const overview = await this.publications.overview();
    return {
      items: overview.items.map(toSummaryResponse),
      latest:
        overview.latest === null
          ? null
          : {
              id: overview.latest.id,
              version: overview.latest.version,
              differences: overview.latest.differences.map(toDifference),
            },
    };
  }

  /** BI-111, BI-113. Copies today's self-pay list to the next version. */
  @Post()
  @RequirePermission('tariff:publish', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publicar el tarifario que se exhibe al público' })
  @ApiCreatedResponse({ type: TariffPublicationDto })
  async publish(@Req() req: Request): Promise<TariffPublicationResponse> {
    assertClinicWideScope(this.currentUser.requirePrincipal(), 'tariff:publish'); // prettier-ignore
    // D-118: who, and from where — `req.ip` is the client because `trust
    // proxy` counts hops.
    return toPublicationResponse(
      await this.publications.publish({
        userId: this.currentUser.requireUserId(),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      }),
    );
  }

  /** BI-113. «¿Qué decía el cartel?»: one version as it was copied. */
  @Get(':publicationId')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar una publicación del tarifario' })
  @ApiOkResponse({ type: TariffPublicationDto })
  async find(
    @Param('publicationId', ParseUUIDPipe) publicationId: string,
  ): Promise<TariffPublicationResponse> {
    return toPublicationResponse(await this.publications.find(publicationId));
  }
}

/**
 * BI-110, BI-112, BI-114. THE TARIFF ON THE WALL, WITHOUT CREDENTIALS.
 *
 * ⚠️ `@Public()` — THE ONLY PUBLIC ROUTE OF `billing`, ON PURPOSE (LOS art.
 * 184 obliges the clinic to show the public what it charges, and a screen in
 * the waiting room has no account). What keeps it narrow:
 *
 *   · it takes NO parameter at all — no payer, no list, no version — so there
 *     is nothing to steer it to an agreement's prices (BI-111);
 *   · it reads the PUBLICATION, never `price` (BI-112): the projection below
 *     copies only category, name, price and tax of each line, plus version,
 *     validity and the clinic's name; no id, no code, no author;
 *   · 30 requests a minute per IP, like the document verification: a lobby
 *     screen behind the clinic's single address reloads now and then, and
 *     nothing here can be guessed.
 */
@ApiTags('billing')
@Controller({ path: 'public/tariff', version: '1' })
export class PublicTariffController {
  constructor(private readonly publications: TariffPublicationService) {}

  @Get()
  @Public()
  // AU-061: nobody's data and meant for anyone — the one route a cache may
  // keep, revalidating each time (`no-cache`): never a price no longer in force.
  @AllowHttpCache()
  @Throttle({ short: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Consultar el tarifario publicado (sin sesión)' })
  @ApiOkResponse({ type: PublicTariffDto })
  async onTheWall(): Promise<PublicTariffResponse> {
    const publication = await this.publications.onTheWall();
    return {
      version: publication.version,
      effectiveFrom: publication.effectiveFrom,
      establishmentName: publication.establishmentName,
      items: publication.lines.map((line) => ({
        categoryName: line.categoryName,
        name: line.name,
        ...publishedPrice(line),
      })),
    };
  }
}

function toSummaryResponse(summary: TariffPublicationSummary) {
  return {
    id: summary.id,
    version: summary.version,
    effectiveFrom: summary.effectiveFrom,
    publishedAt: summary.publishedAt.toISOString(),
    publishedBy: { ...summary.publishedBy },
    establishmentName: summary.establishmentName,
    lineCount: summary.lineCount,
  };
}

function toPublicationResponse(
  publication: TariffPublicationView,
): TariffPublicationResponse {
  return {
    ...toSummaryResponse(publication),
    items: publication.lines.map((line) => ({
      serviceId: line.serviceId,
      code: line.code,
      name: line.name,
      categoryName: line.categoryName,
      ...publishedPrice(line),
    })),
  };
}

function toDifference(difference: TariffDifference) {
  const base = {
    kind: difference.kind,
    serviceId: difference.serviceId,
    name: difference.name,
  };
  return difference.kind === 'PRICE_CHANGED'
    ? {
        ...base,
        published: shownPrice(difference.published),
        current: shownPrice(difference.current),
      }
    : { ...base, published: null, current: null };
}

/** Strings, never numbers (BI-001). */
function shownPrice(price: Pick<TariffLine, 'amount' | 'taxPercentage'>) {
  return {
    amount: price.amount.toString(),
    taxPercentage: price.taxPercentage?.toString() ?? null,
  };
}

/** BI-110, BI-113. As published: with the final price the wall shows. */
function publishedPrice(line: TariffLine) {
  return { ...shownPrice(line), finalAmount: line.finalAmount.toString() };
}
