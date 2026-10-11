import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { parseClinicalDate } from '../../shared/domain/clinic-time';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { AuthorizationService } from './application/authorization.service';
import {
  DataSubjectRequestsService,
  type DataRequestEntry,
} from './application/data-subject-requests.service';
import { PrivacyNoticeService } from './application/privacy-notice.service';
import type {
  DataExportDocument,
  DataRequestAnswer,
  PatientAuthorizationView,
  PrivacyNoticeView,
  Requester,
} from './domain/privacy.repository';
import {
  // NO `import type` for parameter DTOs: Swagger would lose the parameters.
  AnswerDataRequestDto,
  AnswerProposalDto,
  DataRequestDto,
  DataRequestListDto,
  EditDataRequestDto,
  GrantAuthorizationDto,
  PatientAuthorizationDto,
  PatientAuthorizationListDto,
  PrivacyNoticeDto,
  PrivacyNoticeListDto,
  PublishPrivacyNoticeDto,
  OpenRequestsPageDto,
  OpenRequestsQueryDto,
  RegisterDataRequestDto,
  ReviewCopyDto,
  type AnswerProposalResponse,
  type DataRequestResponse,
  type PatientAuthorizationResponse,
  type PrivacyNoticeResponse,
} from './dto/privacy.dto';

/**
 * The privacy notice, the optional authorizations and the data subject's
 * rights (LOPDP), PD-001..PD-075.
 *
 * Every route is `global`: a chart is one in the whole system (PA-051), and
 * the notice is the clinic's, not a site's.
 *
 * TWO PERMISSIONS OF ITS OWN, AND ONE BORROWED. Publishing the notice
 * (`privacy:notice`) and handling requests (`patient:data-requests`, which
 * includes exporting a whole chart) are this module's; recording an optional
 * authorization rides on `patient:write`, because it is done on the chart at
 * the desk and reception already holds it. The shipped `ADMIN` role carries
 * the two (D-083 §4).
 */
@ApiTags('privacy')
@Controller({ path: 'privacy', version: '1' })
export class PrivacyController {
  constructor(
    private readonly notices: PrivacyNoticeService,
    private readonly authorizations: AuthorizationService,
    private readonly requests: DataSubjectRequestsService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- D1 ----------------------------------------------------------------------

  /** PD-001. Every version, newest first. */
  @Get('notices')
  @RequirePermission('privacy:notice', 'global')
  @ApiOperation({ summary: 'Versiones del aviso de privacidad' })
  @ApiOkResponse({ type: PrivacyNoticeListDto })
  async noticeVersions(): Promise<{ items: PrivacyNoticeResponse[] }> {
    return { items: (await this.notices.versions()).map(noticeResponse) };
  }

  /** PD-002 to PD-006. */
  @Post('notices')
  @RequirePermission('privacy:notice', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publicar una versión nueva del aviso' })
  @ApiCreatedResponse({ type: PrivacyNoticeDto })
  async publishNotice(
    @Body() dto: PublishPrivacyNoticeDto,
    @Req() req: Request,
  ): Promise<PrivacyNoticeResponse> {
    return noticeResponse(
      await this.notices.publish(dto.body, this.requester(req)),
    );
  }

  // --- D8 ----------------------------------------------------------------------

  /** PD-073, PD-075. */
  @Get('patients/:patientId/authorizations')
  @RequirePermission('patient:read', 'global')
  @ApiOperation({ summary: 'Autorizaciones opcionales de un paciente' })
  @ApiOkResponse({ type: PatientAuthorizationListDto })
  async authorizationsOf(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<{ items: PatientAuthorizationResponse[] }> {
    const items = await this.authorizations.authorizationsOf(patientId);
    return { items: items.map(authorizationResponse) };
  }

  /** PD-068 to PD-071, PD-074, PD-075. */
  @Post('patients/:patientId/authorizations')
  @RequirePermission('patient:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar una autorización opcional' })
  @ApiCreatedResponse({ type: PatientAuthorizationDto })
  async grantAuthorization(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: GrantAuthorizationDto,
    @Req() req: Request,
  ): Promise<PatientAuthorizationResponse> {
    const granted = await this.authorizations.grant(
      { patientId, purpose: dto.purpose, channel: dto.channel },
      this.requester(req),
      new Date(),
    );
    return authorizationResponse(granted);
  }

  /** PD-069, PD-072, PD-074, PD-075. */
  @Post('patients/:patientId/authorizations/:authorizationId/revocation')
  @RequirePermission('patient:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Revocar una autorización opcional' })
  @ApiCreatedResponse({ type: PatientAuthorizationDto })
  async revokeAuthorization(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('authorizationId', ParseUUIDPipe) authorizationId: string,
    @Req() req: Request,
  ): Promise<PatientAuthorizationResponse> {
    const revoked = await this.authorizations.revoke(
      patientId,
      authorizationId,
      this.requester(req),
      new Date(),
    );
    return authorizationResponse(revoked);
  }

  // --- D3 ----------------------------------------------------------------------

  /** PD-036. */
  @Get('patients/:patientId/requests')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({ summary: 'Solicitudes del titular sobre una ficha' })
  @ApiOkResponse({ type: DataRequestListDto })
  async requestsOf(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<{ items: DataRequestResponse[] }> {
    const items = await this.requests.requestsOf(
      patientId,
      this.requester(req),
    );
    return { items: items.map(requestResponse) };
  }

  /** PD-030 to PD-032, PD-037, PD-052 to PD-054. */
  @Post('patients/:patientId/requests')
  @RequirePermission('patient:data-requests', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar una solicitud del titular' })
  @ApiCreatedResponse({ type: DataRequestDto })
  async register(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RegisterDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequestResponse> {
    const created = await this.requests.register(
      {
        patientId,
        right: dto.right,
        requestedBy: dto.requestedBy,
        requesterName: dto.requesterName,
        requesterDocument: dto.requesterDocument,
        requesterRelationship: dto.requesterRelationship,
        clinicalRecordCopy: dto.clinicalRecordCopy,
        documentsChecked: dto.documentsChecked,
        description: dto.description,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined,
      },
      this.requester(req),
    );
    return requestResponse(created);
  }

  /** PD-035. */
  @Get('requests')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({ summary: 'Solicitudes abiertas, por vencimiento' })
  @ApiOkResponse({ type: OpenRequestsPageDto })
  async open(
    @Query() query: OpenRequestsQueryDto,
    @Req() req: Request,
  ): Promise<{
    items: DataRequestResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    // WITHOUT THE FREE TEXT. What a patient asked, and what was answered, can
    // carry health data; reading it is a READ of that chart (see `requestsOf`).
    // This list is for ordering the work by due date across the clinic
    // (REQ-111), so it says who, what right and when — and nothing written.
    const { page, pageSize } = query;
    const { items, total } = await this.requests.open(
      {
        ...(query.right ? { right: query.right } : {}),
        overdueOnly: query.overdue,
      },
      { page, pageSize },
      this.requester(req),
    );
    return {
      items: items.map((entry) => ({
        ...requestResponse(entry),
        description: null,
        answer: null,
        previousAnswers: [],
      })),
      total,
      page,
      pageSize,
    };
  }

  /** PD-046. Edits an unanswered request; the due date follows. */
  @Patch('requests/:requestId')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({ summary: 'Corregir una solicitud sin responder' })
  @ApiOkResponse({ type: DataRequestDto })
  async edit(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: EditDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequestResponse> {
    const edited = await this.requests.edit(
      requestId,
      {
        right: dto.right,
        description: dto.description,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined,
      },
      this.requester(req),
    );
    return requestResponse(edited);
  }

  /** PD-047. «Corregir respuesta»: a rectified answer, linked. */
  @Post('requests/:requestId/response/correction')
  @RequirePermission('patient:data-requests', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rectificar la respuesta de una solicitud' })
  @ApiOkResponse({ type: DataRequestDto })
  async correctAnswer(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: AnswerDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequestResponse> {
    const corrected = await this.requests.correctAnswer(
      requestId,
      {
        outcome: dto.outcome,
        response: dto.response,
        copyPeriod: dto.copyPeriod
          ? {
              from: parseClinicalDate(dto.copyPeriod.from),
              to: parseClinicalDate(dto.copyPeriod.to),
            }
          : null,
      },
      this.requester(req),
    );
    return requestResponse(corrected);
  }

  /** PD-033, PD-034, PD-037, PD-038. */
  @Post('requests/:requestId/response')
  @RequirePermission('patient:data-requests', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Responder una solicitud del titular' })
  @ApiOkResponse({ type: DataRequestDto })
  async answer(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: AnswerDataRequestDto,
    @Req() req: Request,
  ): Promise<DataRequestResponse> {
    const answered = await this.requests.answer(
      requestId,
      {
        outcome: dto.outcome,
        response: dto.response,
        copyPeriod: dto.copyPeriod
          ? {
              from: parseClinicalDate(dto.copyPeriod.from),
              to: parseClinicalDate(dto.copyPeriod.to),
            }
          : null,
      },
      this.requester(req),
    );
    return requestResponse(answered);
  }

  /**
   * PD-061 (D-203 §5, §6). The professional's review of a copy. The guard
   * asks for `record:protected`; the site is checked against the person's
   * attentions in the service, with the shared rule of the key.
   */
  @Post('requests/:requestId/clinical-review')
  @RequirePermission('record:protected', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dar el visto bueno a una copia de la historia clínica' }) // prettier-ignore
  @ApiOkResponse({ type: DataRequestDto })
  async reviewCopy(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ReviewCopyDto,
    @Req() req: Request,
  ): Promise<DataRequestResponse> {
    return requestResponse(
      await this.requests.reviewCopy(
        requestId,
        { reviewed: dto.reviewed, includesScreening: dto.includesScreening },
        this.requester(req),
      ),
    );
  }

  /** PD-061, PD-062. The copies of a chart waiting for a professional. */
  @Get('patients/:patientId/copy-reviews')
  @RequirePermission('record:protected', 'global')
  @ApiOperation({ summary: 'Copias de la historia clínica sin autorizar, para el visto bueno' }) // prettier-ignore
  @ApiOkResponse({ type: DataRequestListDto })
  async pendingCopies(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<{ items: DataRequestResponse[] }> {
    const items = await this.requests.pendingCopiesOf(
      patientId,
      this.requester(req),
    );
    return { items: items.map(requestResponse) };
  }

  // --- D4 ----------------------------------------------------------------------

  /** PD-049 (D-164.2). What the export leaves out, as a proposed answer. */
  @Get('requests/:requestId/answer-proposal')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({
    summary: 'Respuesta propuesta: lo que la exportación no incluye',
  })
  @ApiOkResponse({ type: AnswerProposalDto })
  async answerProposal(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: Request,
  ): Promise<AnswerProposalResponse> {
    return {
      response: await this.requests.answerProposal(
        requestId,
        this.requester(req),
      ),
    };
  }

  /**
   * PD-040 to PD-043. A download: the body is the document itself, named by the
   * request so two exports of the same chart are told apart.
   */
  @Get('requests/:requestId/export')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({ summary: 'Exportar los datos del paciente (JSON)' })
  @ApiOkResponse({ description: 'Documento JSON `clinica.privacy.export` v2' })
  async export(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DataExportDocument> {
    const document = await this.requests.export(requestId, this.requester(req));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="datos-${requestId}.json"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return document;
  }

  private requester(req: Request): Requester {
    // D-203 §1. The key of the record travels with every request; only the
    // copy of the clinical record asks for it.
    const principal = this.currentUser.requirePrincipal();
    const scope = principal.sitesFor('record:read');
    const protectedScope = principal.sitesFor('record:protected');
    return {
      userId: this.currentUser.requireUserId(),
      recordScope: scope === ALL_SITES ? 'all' : scope,
      // PD-061. The key of the professional's review.
      protectedScope: protectedScope === ALL_SITES ? 'all' : protectedScope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

function noticeResponse(view: PrivacyNoticeView): PrivacyNoticeResponse {
  return { ...view, publishedAt: view.publishedAt.toISOString() };
}

function authorizationResponse(
  view: PatientAuthorizationView,
): PatientAuthorizationResponse {
  return {
    ...view,
    recordedAt: view.recordedAt.toISOString(),
    revokedAt: view.revokedAt?.toISOString() ?? null,
  };
}

function requestResponse(entry: DataRequestEntry): DataRequestResponse {
  const answer = (given: DataRequestAnswer) => ({
    ...given,
    answeredAt: given.answeredAt.toISOString(),
  });
  return {
    ...entry,
    review: entry.review && {
      ...entry.review,
      reviewedAt: entry.review.reviewedAt.toISOString(),
    },
    receivedAt: entry.receivedAt.toISOString(),
    dueAt: entry.dueAt.toISOString(),
    registeredAt: entry.registeredAt.toISOString(),
    answer: entry.answer && answer(entry.answer),
    previousAnswers: entry.previousAnswers.map(answer),
    changedAt: entry.changedAt?.toISOString() ?? null,
  };
}
