import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  ConsentService,
  type PatientConsentEntry,
} from './application/consent.service';
import {
  DataSubjectRequestsService,
  type DataRequestEntry,
} from './application/data-subject-requests.service';
import type {
  ConsentTextView,
  DataExportDocument,
  Requester,
} from './domain/privacy.repository';
import {
  // NO `import type` for parameter DTOs: Swagger would lose the parameters.
  AnswerDataRequestDto,
  ConsentTextDto,
  ConsentTextListDto,
  CurrentConsentTextDto,
  DataRequestDto,
  DataRequestListDto,
  PatientConsentDto,
  PatientConsentListDto,
  PublishConsentTextDto,
  RecordConsentDto,
  RegisterDataRequestDto,
  type ConsentTextResponse,
  type DataRequestResponse,
  type PatientConsentResponse,
} from './dto/privacy.dto';

/**
 * The consent and the data subject's rights (LOPDP), PD-001..PD-043.
 *
 * Every route is `global`: a chart is one in the whole system (PA-051), and a
 * consent text is the clinic's, not a site's.
 *
 * TWO PERMISSIONS OF ITS OWN, AND ONE BORROWED. Publishing the text
 * (`patient:consent-text`) and handling requests (`patient:data-requests`, which
 * includes exporting a whole chart) are new; recording a consent rides on
 * `patient:write`, because it is part of registering the patient at the desk
 * and reception already holds it. The shipped `ADMIN` role carries the new
 * two (D-083 §4).
 */
@ApiTags('privacy')
@Controller({ path: 'privacy', version: '1' })
export class PrivacyController {
  constructor(
    private readonly consent: ConsentService,
    private readonly requests: DataSubjectRequestsService,
    private readonly currentUser: CurrentUserService,
  ) {}

  // --- PD1 ----------------------------------------------------------------------

  /** PD-001. What the desk shows the patient before recording the consent. */
  @Get('consent-texts/current')
  @RequirePermission('patient:read', 'global')
  @ApiOperation({ summary: 'Texto de consentimiento vigente' })
  @ApiOkResponse({ type: CurrentConsentTextDto })
  async currentText(): Promise<{ current: ConsentTextResponse | null }> {
    const current = await this.consent.currentText();
    return { current: current && textResponse(current) };
  }

  /** PD-001. Every version, newest first. */
  @Get('consent-texts')
  @RequirePermission('patient:consent-text', 'global')
  @ApiOperation({ summary: 'Versiones del texto de consentimiento' })
  @ApiOkResponse({ type: ConsentTextListDto })
  async texts(): Promise<{ items: ConsentTextResponse[] }> {
    return { items: (await this.consent.texts()).map(textResponse) };
  }

  /** PD-002 to PD-006. */
  @Post('consent-texts')
  @RequirePermission('patient:consent-text', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publicar una versión nueva del texto' })
  @ApiCreatedResponse({ type: ConsentTextDto })
  async publish(
    @Body() dto: PublishConsentTextDto,
    @Req() req: Request,
  ): Promise<ConsentTextResponse> {
    return textResponse(
      await this.consent.publish(dto.body, this.requester(req)),
    );
  }

  // --- PD2 ----------------------------------------------------------------------

  /** PD-016. */
  @Get('patients/:patientId/consents')
  @RequirePermission('patient:read', 'global')
  @ApiOperation({ summary: 'Consentimientos de un paciente' })
  @ApiOkResponse({ type: PatientConsentListDto })
  async consents(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<{ items: PatientConsentResponse[] }> {
    const items = await this.consent.consentsOf(patientId);
    return { items: items.map(consentResponse) };
  }

  /** PD-010 to PD-015, PD-017. */
  @Post('patients/:patientId/consents')
  @RequirePermission('patient:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar el consentimiento de un paciente' })
  @ApiCreatedResponse({ type: PatientConsentDto })
  async recordConsent(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RecordConsentDto,
    @Req() req: Request,
  ): Promise<PatientConsentResponse> {
    const recorded = await this.consent.record(
      {
        patientId,
        textVersionId: dto.textVersionId,
        medium: dto.medium,
        grantedBy: dto.grantedBy,
      },
      this.requester(req),
    );
    return consentResponse(recorded);
  }

  // --- PD3 ----------------------------------------------------------------------

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

  /** PD-030 to PD-032, PD-037. */
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
  @ApiOkResponse({ type: DataRequestListDto })
  async open(): Promise<{ items: DataRequestResponse[] }> {
    return { items: (await this.requests.open()).map(requestResponse) };
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
      { outcome: dto.outcome, response: dto.response },
      this.requester(req),
    );
    return requestResponse(answered);
  }

  // --- PD4 ----------------------------------------------------------------------

  /**
   * PD-040 to PD-043. A download: the body is the document itself, named by the
   * request so two exports of the same chart are told apart.
   */
  @Get('requests/:requestId/export')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({ summary: 'Exportar los datos del paciente (JSON)' })
  @ApiOkResponse({ description: 'Documento JSON `clinica.privacy.export` v1' })
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
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

function textResponse(view: ConsentTextView): ConsentTextResponse {
  return { ...view, publishedAt: view.publishedAt.toISOString() };
}

function consentResponse(entry: PatientConsentEntry): PatientConsentResponse {
  return {
    ...entry,
    textVersion: textResponse(entry.textVersion),
    recordedAt: entry.recordedAt.toISOString(),
  };
}

function requestResponse(entry: DataRequestEntry): DataRequestResponse {
  return {
    ...entry,
    receivedAt: entry.receivedAt.toISOString(),
    registeredAt: entry.registeredAt.toISOString(),
    answer: entry.answer && {
      ...entry.answer,
      answeredAt: entry.answer.answeredAt.toISOString(),
    },
  };
}
