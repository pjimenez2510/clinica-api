import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { DiagnosticReportService } from './application/diagnostic-report.service';
import type { Requester } from './application/service-order.service';
import type {
  CriticalNoticeView,
  DiagnosticReportView,
  FlaggedResultEntry,
} from './domain/diagnostic-report.repository';
import {
  CorrectReportDto,
  CriticalNoticeDto,
  DiagnosticReportDto,
  DiagnosticReportListDto,
  FlaggedResultListDto,
  MatchResultDto,
  RecordNoticeDto,
  RegisterReportDto,
  WorklistQueryDto,
  type CriticalNoticeResponse,
  type DiagnosticReportListResponse,
  type DiagnosticReportResponse,
  type FlaggedResultListResponse,
} from './dto/diagnostic-report.dto';

/**
 * The result: registering it, correcting it, and the two worklists that exist
 * so it cannot be lost.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `result:write`, AND WHY IT IS NOT `record:write` (ORD-094)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Whoever types a laboratory report into the system may be a technician or an
 * admissions clerk. `record:write` is what lets somebody DIAGNOSE, and art.
 * 198 of the Ley Orgánica de Salud requires each professional to «limitar sus
 * acciones al área que el título les asigne». Transcribing a number is not
 * diagnosing, so it gets its own key — the same argument that produced
 * `nursing:write` and `encounter:open`.
 *
 * ⚠️ AND READING IS `record:read`, WHICH IS NOT SYMMETRICAL ON PURPOSE. A
 * result is clinical content of the chart: every clinician who may open the
 * history may read it. Transcription is a narrower act than reading here, and
 * that asymmetry is exactly the one `patient:sexual-orientation` documents in
 * the other direction.
 *
 * ⚠️ THERE IS NO ROUTE THAT EDITS A VALUE (ORD-050). A correction is a NEW
 * report that supersedes the old one; the old one stays readable and says from
 * when it stopped being true. A value that changes in silence is a safety
 * incident, not an edit. The one `POST` that touches an existing row is
 * `results/:resultId/match` (ORD-043), and it writes the LINE a value answers
 * — never the value.
 *
 * ⚠️ AND THERE IS NO ROUTE THAT CREATES A PATIENT (ORD-080). Its absence is the
 * requirement: creating a chart from an incoming result is the main cause of
 * duplicate records in the systems that do it the other way round.
 */
@ApiTags('orders')
@Controller({ path: 'orders', version: '1' })
export class DiagnosticReportController {
  constructor(
    private readonly reports: DiagnosticReportService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * ORD-040, ORD-041. Results that answer no ordered line.
   *
   * ⚠️ NOTHING HERE MATCHES THEM AUTOMATICALLY. A value that arrived unasked is
   * usually a panel the laboratory widened and sometimes somebody else's
   * report, and a system that guesses between those two files a stranger's
   * result in a chart. It stays on this list until a person resolves it.
   *
   * ⚠️ DECLARED BEFORE THE PARAMETERISED ROUTES: Express matches in
   * registration order.
   */
  @Get('results/unmatched')
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary: 'Listar los resultados que no corresponden a ninguna orden',
  })
  @ApiOkResponse({ type: FlaggedResultListDto })
  async unmatched(
    @Query() query: WorklistQueryDto,
    @Req() req: Request,
  ): Promise<FlaggedResultListResponse> {
    const items = await this.reports.unmatched(
      this.requester(req, 'record:read'),
      query.limit,
    );
    return { items: items.map(toFlaggedResponse) };
  }

  /**
   * ORD-041, ORD-043. Takes one result OFF the unmatched queue.
   *
   * ⚠️ IT IS A PERSON DOING IT, WHICH IS THE WHOLE REQUIREMENT. ORD-041 forbids
   * matching automatically and still does: this route is the human resolution
   * the requirement assumed and that did not exist. A queue that only grows
   * stops being read, and a safety net nobody reads is a list.
   *
   * ⚠️ `result:write` AND NOT `record:read`. Reading the queue is a read;
   * pairing a value with an ordered line WRITES the record and can close a line
   * on the pending worklist. It is the transcriber's key, by ORD-094's own
   * argument, and never `record:write` — pairing is not diagnosing.
   *
   * ⚠️ AND THERE IS NO ROUTE THAT DISCARDS A RESULT (⚠️ **Falta esquema**,
   * ORD-041, ORD-043). The value that belongs to nobody's order cannot be
   * resolved today: `observation_result` has no column saying a person looked
   * at it and it is not from here, nor who decided so. It stays on the queue,
   * which is the honest state rather than a button that hides the row.
   *
   * ⚠️ DECLARED BEFORE THE PARAMETERISED ROUTES: Express matches in
   * registration order.
   */
  @Post('results/:resultId/match')
  @RequirePermission('result:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Emparejar un resultado sin orden con una línea de su orden',
  })
  @ApiOkResponse({ type: DiagnosticReportDto })
  async match(
    /**
     * NOT `ParseUUIDPipe`: `observation_result.id` is a `bigint` autoincrement,
     * the one clinical table with genuinely high row counts. It travels as a
     * string end to end so no JSON parser has to keep 19 digits, and what is
     * not a whole number is answered `RESULT_NOT_FOUND` — «no es un número» and
     * «no existe» are the same situation to whoever asked.
     */
    @Param('resultId') resultId: string,
    @Body() dto: MatchResultDto,
    @Req() req: Request,
  ): Promise<DiagnosticReportResponse> {
    const report = await this.reports.match(
      { resultId, orderItemId: dto.orderItemId },
      this.requester(req, 'result:write'),
    );
    return toReportResponse(report);
  }

  /**
   * ORD-060, ORD-061. The values that have to reach a human today.
   *
   * Built on the flag THIS system computed from its own `CRITICAL` ranges, not
   * on anything the laboratory sent: many send only «alto/bajo», some send
   * nothing, and the A.M. 00002393 art. 39 obligation is ours either way.
   *
   * ⚠️ WHAT IS MISSING IS THE OTHER HALF (ORD-062). There is no route to record
   * that the call was made, because there is no table for it — and the phone
   * call is a CLINICAL ACT, not an errand. Until it exists, this list cannot
   * be emptied, and that is the honest state rather than a button that hides
   * the row.
   */
  @Get('results/critical')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar los valores críticos pendientes de avisar' })
  @ApiOkResponse({ type: FlaggedResultListDto })
  async critical(
    @Query() query: WorklistQueryDto,
    @Req() req: Request,
  ): Promise<FlaggedResultListResponse> {
    const items = await this.reports.critical(
      this.requester(req, 'record:read'),
      query.limit,
    );
    return { items: items.map(toFlaggedResponse) };
  }

  /**
   * ORD-062. Records that somebody was told of a critical value, which takes
   * it off the list above.
   *
   * ⚠️ `result:write` (D-111 §6, provisional). The nurse who makes the call is
   * the ordinary case, and `record:write` — diagnosing — would leave out
   * whoever phones. Who gave the notice is the session's account, never the
   * body; WHEN is declared, because the 03:00 call is written down at 08:00.
   *
   * ⚠️ DECLARED BEFORE THE PARAMETERISED ROUTES: Express matches in
   * registration order.
   */
  @Post('results/:resultId/notices')
  @RequirePermission('result:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar el aviso de un valor crítico' })
  @ApiCreatedResponse({ type: CriticalNoticeDto })
  async notify(
    // NOT `ParseUUIDPipe`: a `bigint` id, as on `match` above.
    @Param('resultId') resultId: string,
    @Body() dto: RecordNoticeDto,
    @Req() req: Request,
  ): Promise<CriticalNoticeResponse> {
    const notice = await this.reports.notify(
      {
        resultId,
        recipientKind: dto.recipientKind,
        recipientName: dto.recipientName,
        channel: dto.channel,
        notifiedAt: dto.notifiedAt === undefined ? undefined : new Date(dto.notifiedAt), // prettier-ignore
        note: dto.note,
      },
      this.requester(req, 'result:write'),
      new Date(),
    );
    return toNoticeResponse(notice);
  }

  /**
   * ORD-050 to ORD-054. Corrects a report by REPLACING it.
   *
   * 201: a correction is a new report, not an edit of an old one, and the
   * status code says so before anybody reads the documentation.
   */
  @Post('reports/:reportId/correct')
  @RequirePermission('result:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Corregir un informe emitiendo uno nuevo que lo sustituye',
  })
  @ApiCreatedResponse({ type: DiagnosticReportDto })
  async correct(
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: CorrectReportDto,
    @Req() req: Request,
  ): Promise<DiagnosticReportResponse> {
    const report = await this.reports.correct(
      {
        reportId,
        performedById: null,
        conclusion: dto.conclusion,
        issuedAt: dto.issuedAt === undefined ? new Date() : new Date(dto.issuedAt), // prettier-ignore
        results: dto.results,
      },
      this.requester(req, 'result:write'),
    );
    return toReportResponse(report);
  }

  /** ORD-030 to ORD-042. Registers what came back against an order. */
  @Post(':orderId/reports')
  @RequirePermission('result:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar el informe de laboratorio de una orden' })
  @ApiCreatedResponse({ type: DiagnosticReportDto })
  async register(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: RegisterReportDto,
    @Req() req: Request,
  ): Promise<DiagnosticReportResponse> {
    const report = await this.reports.register(
      {
        orderId,
        performedById: null,
        conclusion: dto.conclusion,
        issuedAt: dto.issuedAt === undefined ? new Date() : new Date(dto.issuedAt), // prettier-ignore
        results: dto.results,
      },
      this.requester(req, 'result:write'),
    );
    return toReportResponse(report);
  }

  /**
   * ORD-051, ORD-091. The reports of one order, corrections included.
   *
   * AUDITED, unlike the two worklists above (ORD-092), and the difference is
   * what travels: a worklist carries what was asked for, this carries what the
   * person's blood said.
   */
  @Get(':orderId/reports')
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary: 'Listar los informes de una orden, incluidas las correcciones',
  })
  @ApiOkResponse({ type: DiagnosticReportListDto })
  async ofOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() req: Request,
  ): Promise<DiagnosticReportListResponse> {
    const items = await this.reports.ofOrder(
      orderId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toReportResponse) };
  }

  /** Who is asking, for the site scope and for the access trail. */
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
function toReportResponse(
  report: DiagnosticReportView,
): DiagnosticReportResponse {
  return {
    id: report.id,
    serviceOrderId: report.serviceOrderId,
    status: report.status,
    conclusion: report.conclusion,
    issuedAt: report.issuedAt?.toISOString() ?? null,
    supersedesId: report.supersedesId,
    supersededById: report.supersededById,
    supersededAt: report.supersededAt?.toISOString() ?? null,
    results: report.results.map((result) => ({
      id: result.id,
      orderItemId: result.orderItemId,
      analyteDisplay: result.analyteDisplay,
      valueNumeric: result.valueNumeric,
      valueText: result.valueText,
      valueCode: result.valueCode,
      unit: result.unit,
      referenceLow: result.referenceLow,
      referenceHigh: result.referenceHigh,
      referenceText: result.referenceText,
      abnormalFlag: result.abnormalFlag,
      observedAt: result.observedAt.toISOString(),
      notices: result.notices.map(toNoticeResponse),
    })),
  };
}

/** ORD-062. The notice, instants as ISO 8601. */
function toNoticeResponse(notice: CriticalNoticeView): CriticalNoticeResponse {
  return {
    id: notice.id,
    resultId: notice.resultId,
    recipientKind: notice.recipientKind,
    recipientName: notice.recipientName,
    channel: notice.channel,
    notifiedAt: notice.notifiedAt.toISOString(),
    notifiedBy: notice.notifiedBy,
    note: notice.note,
  };
}

/** ORD-024. One worklist entry. The value travels; nothing else about the person does. */
function toFlaggedResponse(
  entry: FlaggedResultEntry,
): FlaggedResultListResponse['items'][number] {
  return {
    resultId: entry.resultId,
    reportId: entry.reportId,
    orderId: entry.orderId,
    siteId: entry.siteId,
    patientId: entry.patientId,
    analyteDisplay: entry.analyteDisplay,
    valueNumeric: entry.valueNumeric,
    valueCode: entry.valueCode,
    unit: entry.unit,
    abnormalFlag: entry.abnormalFlag,
    observedAt: entry.observedAt.toISOString(),
  };
}
