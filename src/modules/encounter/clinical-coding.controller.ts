import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { ClinicalCodingService } from './application/clinical-coding.service';
import type { Requester } from './application/encounter.service';
import type {
  DiagnosisView,
  ProcedureView,
  RetractedDiagnosisView,
} from './domain/clinical-coding.repository';
import {
  CareModalityDto,
  DiagnosisDto,
  DiagnosisListDto,
  ProcedureDto,
  ProcedureListDto,
  RecordDiagnosisDto,
  RecordProcedureDto,
  RetractDiagnosisDto,
  type DiagnosisListResponse,
  type DiagnosisResponse,
  type ProcedureListResponse,
  type ProcedureResponse,
} from './dto/clinical-coding.dto';

/**
 * Block K of the RDACAA: the diagnoses and the procedures of an attention.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `record:write`, AND THE ABSENCE OF `nursing:write` IS THE REQUIREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 198 of the Ley Orgánica de Salud reserves the diagnosis to the
 * professional whose title covers it. `nursing:write` — which is what lets
 * `ENFERMERIA` fill form 020, form 120 and form 022 — appears on NO route of
 * this file, and neither does `vitals:write`. That absence is EN-142 made into
 * a table of routes rather than a paragraph somebody has to remember: nursing
 * takes the weight, and nursing does not diagnose.
 *
 * ⚠️ AND IT IS NOT `record:sign` EITHER. Coding a diagnosis is writing in the
 * history; standing behind the consultation is signing the note, which is a
 * second act with its own route. Requiring the signature permission here would
 * make the resident who codes as they go unable to work.
 *
 * ⚠️ EVERY ROUTE DECLARES `'query'` SITE SCOPE, like the rest of the module: a
 * diagnosis is addressed through the attention it belongs to, the site is not
 * in the URL, and the guard cannot check what it cannot see. The HANDLER
 * narrows with the caller's own resolved scope (EN-121).
 *
 * A CONTROLLER OF ITS OWN and not more routes on `EncounterController`,
 * because it serves the third aggregate of this module — the one whose
 * questions are all about a CATALOGUE CONCEPT — and because keeping the
 * permission of each route readable in one screen is what makes the paragraph
 * above checkable at a glance.
 *
 * ⚠️ WHAT IS NOT HERE: `…/procedures/:procedureId/consent` and the two routes
 * of the refusal and the revocation (EN-152 to EN-154). Both halves are
 * missing from the schema — the risk classification on the service catalogue,
 * which is what decides whether a consent is needed at all, and the form 024
 * table — and a route that accepted a consent nothing could store would be
 * worse than none. EN-151 is satisfied by their ABSENCE: the A.M. 5316 §7.6.d
 * says no signed consent is required for a minimum-risk intervention, and a
 * barrier on the ordinary procedure trains everybody to click without reading.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId', version: '1' })
export class ClinicalCodingController {
  constructor(
    private readonly coding: ClinicalCodingService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-040 to EN-049. Registers one diagnosis.
   *
   * A `POST` AND NOT A `PUT`, unlike block D: an attention has at most one set
   * of vital signs and MANY diagnoses (EN-047), so the operation creates a row
   * rather than replacing one — and repeating it must create the second
   * diagnosis, not overwrite the first.
   *
   * 201, because what it leaves behind is a row that did not exist.
   */
  @Post('diagnoses')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un diagnóstico CIE-10 de la atención' })
  @ApiCreatedResponse({ type: DiagnosisDto })
  async recordDiagnosis(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordDiagnosisDto,
    @Req() req: Request,
  ): Promise<DiagnosisResponse> {
    const diagnosis = await this.coding.recordDiagnosis(
      {
        encounterId,
        conceptId: dto.conceptId,
        certainty: dto.certainty,
        occurrence: dto.occurrence,
        rank: dto.rank,
        notifiable: dto.notifiable,
        note: dto.note,
      },
      this.requester(req, 'record:write'),
    );
    return toDiagnosisResponse(diagnosis);
  }

  /**
   * EN-047. The diagnoses of one attention, principal first.
   *
   * `record:read` AND NOT `record:write`: reading what somebody has and
   * writing it down are two acts. AUDITED, unlike the listing of attentions
   * (EN-123), because what travels here IS the clinical content.
   */
  @Get('diagnoses')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar los diagnósticos de la atención' })
  @ApiOkResponse({ type: DiagnosisListDto })
  async diagnoses(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<DiagnosisListResponse> {
    const sheet = await this.coding.diagnosesOf(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return {
      items: sheet.items.map((item) => ({
        ...toDiagnosisResponse(item),
        printedOnCertificate: item.printedOnCertificate,
      })),
      retracted: sheet.retracted.map(toRetractedResponse),
    };
  }

  /**
   * EN-180 to EN-182. Takes a diagnosis off the attention, with a trace.
   *
   * A `POST` of an act and not a `DELETE`: nothing is deleted from the
   * history — the row moves to the archive with who, when and why — and the
   * reason travels in a body, which a `DELETE` does not reliably carry.
   */
  @Post('diagnoses/:diagnosisId/retract')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar un diagnóstico registrado por error' })
  @ApiNoContentResponse()
  async retractDiagnosis(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('diagnosisId', ParseUUIDPipe) diagnosisId: string,
    @Body() dto: RetractDiagnosisDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.coding.retractDiagnosis(
      { encounterId, diagnosisId, reason: dto.reason },
      this.requester(req, 'record:write'),
    );
  }

  /**
   * EN-187. Corrects the attention's modality while it is live. A `PUT`: the
   * attention has exactly one, and repeating the call changes nothing more.
   */
  @Put('care-modality')
  @RequirePermission('record:write', 'query')
  @ApiOperation({
    summary: 'Corregir si la atención es de morbilidad o de prevención',
  })
  @ApiOkResponse({ type: CareModalityDto })
  async correctCareModality(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: CareModalityDto,
    @Req() req: Request,
  ): Promise<CareModalityDto> {
    const careModality = await this.coding.correctCareModality(
      encounterId,
      dto.careModality,
      this.requester(req, 'record:write'),
    );
    return { careModality };
  }

  /** EN-183. Makes this diagnosis the principal; answers the new order. */
  @Post('diagnoses/:diagnosisId/primary')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar un diagnóstico como principal' })
  @ApiOkResponse({ type: DiagnosisDto, isArray: true })
  async makePrimary(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('diagnosisId', ParseUUIDPipe) diagnosisId: string,
    @Req() req: Request,
  ): Promise<DiagnosisResponse[]> {
    const diagnoses = await this.coding.makePrimary(
      encounterId,
      diagnosisId,
      this.requester(req, 'record:write'),
    );
    return diagnoses.map(toDiagnosisResponse);
  }

  /**
   * EN-050, EN-151. Registers one procedure with its quantity.
   *
   * ⚠️ NO CONSENT IS ASKED FOR, AND THAT IS EN-151 RATHER THAN AN OMISSION.
   * «No se requiere un consentimiento informado suscrito en las intervenciones
   * de riesgo mínimo» is textual in the A.M. 5316 §7.6.d, and the requirement
   * is written as a negative because the failure mode is building too much: a
   * barrier here is work that teaches everybody to click through, and then the
   * consent that matters — the major-risk one of EN-152 — gets signed with the
   * same automatism.
   */
  @Post('procedures')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Registrar un procedimiento realizado en la atención',
  })
  @ApiCreatedResponse({ type: ProcedureDto })
  async recordProcedure(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordProcedureDto,
    @Req() req: Request,
  ): Promise<ProcedureResponse> {
    const procedure = await this.coding.recordProcedure(
      {
        encounterId,
        conceptId: dto.conceptId,
        quantity: dto.quantity,
        performedAt:
          dto.performedAt === undefined ? undefined : new Date(dto.performedAt),
        note: dto.note,
      },
      this.requester(req, 'record:write'),
    );
    return toProcedureResponse(procedure);
  }

  /** EN-050. The procedures of one attention. AUDITED, like the diagnoses. */
  @Get('procedures')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar los procedimientos de la atención' })
  @ApiOkResponse({ type: ProcedureListDto })
  async procedures(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ProcedureListResponse> {
    const items = await this.coding.proceduresOf(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toProcedureResponse) };
  }

  /** Who is asking, for the access trail and for the site scope. */
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

/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
function toDiagnosisResponse(diagnosis: DiagnosisView): DiagnosisResponse {
  return {
    id: diagnosis.id,
    encounterId: diagnosis.encounterId,
    conceptId: diagnosis.conceptId,
    // EN-041. The snapshot, which is what the record says for ever.
    cie10Code: diagnosis.cie10Code,
    cie10Display: diagnosis.cie10Display,
    certainty: diagnosis.certainty,
    occurrence: diagnosis.occurrence,
    rank: diagnosis.rank,
    // EN-046. Derived from the frozen code, served so nobody derives it twice.
    careModality: diagnosis.careModality,
    notifiable: diagnosis.notifiable,
    note: diagnosis.note,
    recordedAt: diagnosis.recordedAt.toISOString(),
  };
}

/** EN-180. The archive row; who removed it travels as a name, never a cedula. */
function toRetractedResponse(
  retracted: RetractedDiagnosisView,
): DiagnosisListResponse['retracted'][number] {
  return {
    id: retracted.id,
    cie10Code: retracted.cie10Code,
    cie10Display: retracted.cie10Display,
    rank: retracted.rank,
    retractedAt: retracted.retractedAt.toISOString(),
    retractedBy: retracted.retractedBy,
    reason: retracted.reason,
  };
}

/** ⚠️ NO AMOUNT IS SERVED (EN-051): the charge belongs to `billing`. */
function toProcedureResponse(procedure: ProcedureView): ProcedureResponse {
  return {
    id: procedure.id,
    encounterId: procedure.encounterId,
    conceptId: procedure.conceptId,
    procedureCode: procedure.procedureCode,
    procedureDisplay: procedure.procedureDisplay,
    quantity: procedure.quantity,
    performedAt: procedure.performedAt.toISOString(),
    note: procedure.note,
  };
}
