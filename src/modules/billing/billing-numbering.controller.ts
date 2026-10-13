import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { EmissionPointNumberingService } from './application/emission-point-numbering.service';
import { NumberingEmissionPointNotFoundError } from './domain/billing.errors';
import {
  VOUCHER_TYPES,
  type NumberingView,
  type VoucherType,
} from './domain/emission-point-numbering';
import {
  FixNumberingDto,
  NumberingDto,
  NumberingListDto,
  type NumberingResponse,
} from './dto/numbering.dto';

/**
 * B23 (BI-306 to BI-309, D-262). The «próximo número» of each emission point.
 *
 * `site:read` to read and `site:manage` to fix: the permissions with which the
 * emission points themselves are read and registered (OR-023). Caja does not
 * hold `site:manage`, and fixing where the numbering goes is administration's
 * (D-262 §2).
 */
@ApiTags('billing')
@Controller({ path: 'billing/sites/:siteId/numbering', version: '1' })
export class BillingNumberingController {
  constructor(
    private readonly numbering: EmissionPointNumberingService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** BI-309. */
  @Get()
  @RequirePermission('site:read', 'param:siteId')
  @ApiOperation({
    summary: 'Consultar la numeración de los puntos de emisión de una sede',
  })
  @ApiOkResponse({ type: NumberingListDto })
  async list(
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ): Promise<{ items: NumberingResponse[] }> {
    return { items: (await this.numbering.list(siteId)).map(toResponse) };
  }

  /** BI-306, BI-307. */
  @Put(':emissionPointId/:documentType')
  @RequirePermission('site:manage', 'param:siteId')
  @ApiOperation({
    summary: 'Fijar el próximo número de un punto de emisión',
  })
  @ApiOkResponse({ type: NumberingDto })
  async fix(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('emissionPointId', ParseUUIDPipe) emissionPointId: string,
    @Param('documentType') documentType: string,
    @Body() dto: FixNumberingDto,
  ): Promise<NumberingResponse> {
    // Only `01` and `04` are numbered here: any other path names nothing.
    if (!VOUCHER_TYPES.includes(documentType as VoucherType)) {
      throw new NumberingEmissionPointNotFoundError();
    }
    return toResponse(
      await this.numbering.fix(
        siteId,
        emissionPointId,
        documentType as VoucherType,
        {
          nextSequential: dto.nextSequential,
          previousSystemLast: dto.previousSystemLast,
          reason: dto.reason,
        },
        this.currentUser.requireUserId(),
      ),
    );
  }
}

function toResponse(view: NumberingView): NumberingResponse {
  return {
    emissionPointId: view.emissionPointId,
    emissionPointCode: view.emissionPointCode,
    emissionPointActive: view.emissionPointActive,
    documentType: view.documentType,
    usedUpTo: view.usedUpTo,
    nextSequential: view.nextSequential,
    previousSystemLast: view.previousSystemLast,
    nextToIssue: view.nextToIssue,
    belowPreviousSystem: view.belowPreviousSystem,
    lastChange:
      view.lastChange === null
        ? null
        : {
            at: view.lastChange.at.toISOString(),
            by: { id: view.lastChange.byId, name: view.lastChange.byName },
            reason: view.lastChange.reason,
          },
  };
}
