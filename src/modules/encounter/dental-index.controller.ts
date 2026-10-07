import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  DentalIndexService,
  type DentalIndexSheet,
} from './application/dental-index.service';
import type { Requester } from './application/encounter.service';
import {
  DentalIndexDto,
  RecordDentalIndexDto,
  type DentalIndexResponse,
} from './dto/dental-index.dto';

/**
 * EN-052. The CEO-D / CPO-D of an odontology attention — columns 101 to 104
 * of the RDACAA form.
 *
 * `'query'` site scope like the rest of the module: the attention is
 * addressed by its own id and the handler narrows with the caller's resolved
 * scope (EN-121). Reading is `record:read`; recording is `record:write`, as a
 * diagnosis: it is the odontologist's finding, not a measurement of nursing.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId', version: '1' })
export class DentalIndexController {
  constructor(
    private readonly dental: DentalIndexService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** EN-052. Which index the attention takes, and what was recorded. */
  @Get('dental-index')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar el índice CEO-D / CPO-D de la atención' })
  @ApiOkResponse({ type: DentalIndexDto })
  async dentalIndex(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<DentalIndexResponse> {
    return toResponse(
      await this.dental.dentalIndexOf(
        encounterId,
        this.requester(req, 'record:read'),
      ),
    );
  }

  /**
   * EN-052. Records or corrects the counts of the index that applies. A
   * `PUT`: one index per attention, and repeating it replaces the counts (the
   * previous ones are versioned, EN-210).
   */
  @Put('dental-index')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar el índice CEO-D / CPO-D de la atención' })
  @ApiOkResponse({ type: DentalIndexDto })
  async recordDentalIndex(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordDentalIndexDto,
    @Req() req: Request,
  ): Promise<DentalIndexResponse> {
    return toResponse(
      await this.dental.recordDentalIndex(
        encounterId,
        {
          index: dto.index,
          decayed: dto.decayed,
          filled: dto.filled,
          extracted: dto.extracted,
          missing: dto.missing,
        },
        this.requester(req, 'record:write'),
      ),
    );
  }

  private requester(req: Request, permission: Permission): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);
    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Instants leave as ISO 8601. */
function toResponse(sheet: DentalIndexSheet): DentalIndexResponse {
  return {
    index: sheet.index,
    reading: sheet.reading && {
      decayed: sheet.reading.decayed,
      extracted: sheet.reading.extracted,
      filled: sheet.reading.filled,
      missing: sheet.reading.missing,
      recordedAt: sheet.reading.recordedAt.toISOString(),
      editedAt: sheet.reading.editedAt?.toISOString() ?? null,
    },
  };
}
