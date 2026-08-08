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

import { RequirePermission } from '../../shared/http/auth.decorators';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import {
  PatientsService,
  type Requester,
} from './application/patients.service';
import type {
  PatientDetail,
  PatientSummary,
} from './domain/patient.repository';
import {
  CreatePatientDto,
  PatientDetailDto,
  PatientPageDto,
  SearchPatientsDto,
} from './dto/patient.dto';

/**
 * The patient register.
 *
 * EVERY ROUTE DECLARES ITS PERMISSION. The guard refuses an unannotated route
 * at runtime and a test refuses it in CI, because the known weakness of
 * guard-based authorisation is a route that forgets to ask for one.
 *
 * `siteScope: 'global'` throughout, and that is a decision rather than an
 * omission: a patient is not attached to a branch. The person registered at
 * the northern site is the same person who walks into the southern one, and
 * scoping the register by site would create a second chart for them — which is
 * precisely the duplicate the MRN exists to prevent. What IS site-scoped is
 * what happens to them: appointments, encounters, invoices.
 */
@ApiTags('patients')
@Controller({ path: 'patients', version: '1' })
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  @RequirePermission('patient:read', 'global')
  @ApiOperation({ summary: 'Search the patient register' })
  @ApiOkResponse({ type: PatientPageDto })
  async search(@Query() dto: SearchPatientsDto): Promise<{
    items: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const result = await this.patients.search({
      query: dto.q,
      page: dto.page,
      pageSize: dto.pageSize,
      includeMerged: dto.includeMerged,
    });

    return {
      items: result.items.map(toSummaryResponse),
      total: result.total,
      // Echoed back so the client never has to remember what it asked for to
      // render "página 2 de 7".
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  /**
   * Opens one record. THIS IS AUDITED.
   *
   * `ParseUUIDPipe` rejects a malformed id before it reaches the database, so
   * a typo comes back as a 400 that says so rather than as a Postgres error.
   */
  @Get(':id')
  @RequirePermission('patient:read', 'global')
  @ApiOperation({ summary: 'Open a patient record' })
  @ApiOkResponse({ type: PatientDetailDto })
  async byId(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const patient = await this.patients.getById(id, this.requester(req));
    return toDetailResponse(patient);
  }

  @Post()
  @RequirePermission('patient:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new patient' })
  @ApiCreatedResponse({ type: PatientDetailDto })
  async create(
    @Body() dto: CreatePatientDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const created = await this.patients.create(
      {
        familyName: dto.familyName,
        secondFamilyName: dto.secondFamilyName,
        givenName: dto.givenName,
        secondGivenName: dto.secondGivenName,
        sex: dto.sex,
        // `birthDate` arrives as YYYY-MM-DD. Parsed as UTC midnight on purpose:
        // the column is a DATE, and letting the server's zone decide would move
        // a birthday by a day for anyone west of Greenwich — which is everyone
        // here.
        birthDate: new Date(`${dto.birthDate}T00:00:00Z`),
        birthDateEstimated: dto.birthDateEstimated,
        phone: dto.phone,
        email: dto.email,
        residenceAddressLine: dto.residenceAddressLine,
        bloodType: dto.bloodType,
        identifier: dto.identifier,
      },
      this.requester(req),
    );

    return toDetailResponse(created);
  }

  /**
   * Who is asking, for the access trail.
   *
   * `req.ip` is only the real client because `trust proxy` is configured with a
   * COUNT of hops. Without that it would be the proxy's address on every row,
   * and the trail the LOPDP expects us to follow when investigating improper
   * access would point at our own infrastructure.
   */
  private requester(req: Request): Requester {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/**
 * Dates leave as `YYYY-MM-DD`, instants as ISO 8601.
 *
 * A birth date is a CALENDAR DATE, not a moment: serialising it as an instant
 * makes it shift by a day depending on who reads it, which is how a patient
 * ends up a day younger in a report than on their chart.
 */
function toSummaryResponse(patient: PatientSummary) {
  return {
    id: patient.id,
    mrn: patient.mrn,
    familyName: patient.familyName,
    secondFamilyName: patient.secondFamilyName,
    givenName: patient.givenName,
    secondGivenName: patient.secondGivenName,
    sex: patient.sex,
    birthDate: patient.birthDate.toISOString().slice(0, 10),
    birthDateEstimated: patient.birthDateEstimated,
    deceasedAt: patient.deceasedAt?.toISOString() ?? null,
    primaryIdentifier: patient.primaryIdentifier,
  };
}

function toDetailResponse(patient: PatientDetail) {
  return {
    ...toSummaryResponse(patient),
    phone: patient.phone,
    email: patient.email,
    bloodType: patient.bloodType,
    residenceAddressLine: patient.residenceAddressLine,
    isProvisional: patient.isProvisional,
    identifiers: patient.identifiers,
    mergedIntoMrn: patient.mergedIntoMrn,
    createdAt: patient.createdAt.toISOString(),
  };
}
