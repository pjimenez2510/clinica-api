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
  AddIdentifierDto,
  CorrectPatientDto,
  CreatePatientDto,
  PatientDetailDto,
  PatientPageDto,
  SearchPatientsDto,
  type PatientDetailResponse,
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
      // PA-009. Un filtro más, no una búsqueda aparte: al recién nacido se le
      // encuentra por su madre porque no hay otra cosa que teclear.
      motherId: dto.motherId,
      sortBy: dto.sortBy,
      sortDirection: dto.sortDirection,
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
  ): Promise<PatientDetailResponse> {
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
  ): Promise<PatientDetailResponse> {
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
        // D-028: los cuatro del RDACAA son opcionales al dar de alta. La ficha
        // se marca incompleta mientras tanto (PA-032), y lo que obliga a
        // completarlos es el cierre de la primera atención, que es de
        // `encounter`.
        ethnicityConceptId: dto.ethnicityConceptId,
        nationalityConceptId: dto.nationalityConceptId,
        // PA-056, PA-057. Las columnas 14 y 7 del formulario. Sus condiciones
        // —nacionalidad «Kichwa», y diez años cumplidos— las hace cumplir el
        // servicio sobre la ficha RESULTANTE, no el DTO.
        peopleConceptId: dto.peopleConceptId,
        sexualOrientationConceptId: dto.sexualOrientationConceptId,
        residenceParishConceptId: dto.residenceParishConceptId,
        genderIdentityConceptId: dto.genderIdentityConceptId,
        // PA-053. De qué país es, que no es la nacionalidad indígena de
        // arriba: se guarda el código alpha-3 y la ficha lo devuelve con su
        // nombre. No cuenta para `rdacaaMissingFields` (REQ-022 no lo pide).
        countryOfNationalityCode: dto.countryOfNationalityCode,
        motherPatientId: dto.motherPatientId,
        identifier: dto.identifier,
      },
      this.requester(req),
    );

    return toDetailResponse(created);
  }

  /**
   * Corrige una ficha (PA-008, PA-009, PA-026 a PA-029, PA-031).
   *
   * UNA SOLA RUTA Y NO UNA POR CAMPO. En el mostrador se corrige lo que se
   * acaba de ver mal —una letra de un apellido—, y una ruta por campo
   * multiplicaría por seis las superficies que hay que declarar, autorizar y
   * auditar. Acepta el subconjunto que se envíe y no toca lo demás.
   *
   * EL MRN NO ESTÁ ENTRE LOS CAMPOS (PA-002). Ni aquí, ni en el esquema, ni en
   * el CHECK de la base: es el ancla de identidad, no un dato de la ficha.
   */
  @Patch(':id')
  @RequirePermission('patient:write', 'global')
  @ApiOperation({ summary: 'Correct a patient record' })
  @ApiOkResponse({ type: PatientDetailDto })
  async correct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectPatientDto,
    @Req() req: Request,
  ): Promise<PatientDetailResponse> {
    /**
     * El cuerpo se pasa TAL CUAL, sin reconstruirlo campo a campo.
     *
     * Reconstruirlo aquí sería la cuarta copia de la lista de campos
     * corregibles —dominio, base, esquema y esta— y la que convierte «se me
     * olvidó añadirlo» en un campo que se valida, se documenta y no se guarda.
     * El esquema ya rechazó cualquier clave que no esté en la lista.
     */
    const corrected = await this.patients.correct(id, dto, this.requester(req));

    return toDetailResponse(corrected);
  }

  /**
   * PA-015. El documento de una ficha provisional.
   *
   * NO CREA FICHA. Es la ruta que evita el duplicado: hasta que existió, la
   * única forma de que el recién nacido tuviera su cédula era registrarlo otra
   * vez, que es precisamente lo que REQ-010 tiene luego que fusionar.
   */
  @Post(':id/identifiers')
  @RequirePermission('patient:write', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add an identity document to an existing record' })
  @ApiOkResponse({ type: PatientDetailDto })
  async addIdentifier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddIdentifierDto,
    @Req() req: Request,
  ): Promise<PatientDetailResponse> {
    const updated = await this.patients.addIdentifier(
      id,
      { type: dto.type, issuingCountry: dto.issuingCountry, value: dto.value },
      this.requester(req),
    );

    return toDetailResponse(updated);
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
    /**
     * PA-041 y PA-042. El ORDEN viaja; el motivo no, en ningún listado.
     *
     * Es lo que permite a la lista de espera ordenar con sólo `patient:read`
     * (AG-061), y a recepción trabajar sin ver «enfermedad catastrófica». El
     * motivo tiene su propia ruta, su propio permiso y su propia fila de
     * bitácora.
     */
    priority: patient.priority,
    mrn: patient.mrn,
    familyName: patient.familyName,
    secondFamilyName: patient.secondFamilyName,
    givenName: patient.givenName,
    secondGivenName: patient.secondGivenName,
    sex: patient.sex,
    birthDate: patient.birthDate.toISOString().slice(0, 10),
    birthDateEstimated: patient.birthDateEstimated,
    deceasedAt: patient.deceasedAt?.toISOString() ?? null,
    /**
     * PA-030 y PA-032, y son lo ÚNICO que el resumen gana.
     *
     * La edad porque el listado la enseña en cada fila y calcularla en el
     * navegador la resolvería en el huso del portátil (`age_days` de un neonato
     * cambia con eso). Qué falta porque admisión trabaja desde la lista. Los
     * cuatro conceptos de catálogo NO están: PA-021 dice que el listado se
     * dispara con cada letra tecleada.
     */
    age: patient.age,
    rdacaaMissingFields: patient.rdacaaMissingFields,
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
    ethnicity: patient.ethnicity,
    nationality: patient.nationality,
    /**
     * PA-056. El pueblo, tercer escalón de la cadena.
     *
     * ⚠️ Y LA ORIENTACIÓN SEXUAL NO ESTÁ, que es la mitad visible de PA-058:
     * es dato de categoría especial y sale por `PatientSexualOrientation
     * Controller`, con su permiso propio y su fila de bitácora. Añadirla aquí
     * la pondría en la respuesta que recibe todo el que tenga `patient:read`.
     */
    people: patient.people,
    genderIdentity: patient.genderIdentity,
    countryOfNationality: patient.countryOfNationality,
    residenceParish: patient.residenceParish,
    motherPatientId: patient.motherPatientId,
    isProvisional: patient.isProvisional,
    identifiers: patient.identifiers,
    mergedIntoMrn: patient.mergedIntoMrn,
    /**
     * PA-054. Qué fichas absorbió ésta, que es el enlace de PA-043 leído en el
     * sentido que faltaba.
     *
     * SÓLO EN LA FICHA (PA-021): el resumen de arriba no lo lleva, porque el
     * listado se dispara con cada letra tecleada y ninguna fila lo necesita.
     * Y es un aviso, no la lectura: quién lee la historia por el enlace lo
     * decide D-038.
     */
    absorbedCharts: patient.absorbedCharts,
    createdAt: patient.createdAt.toISOString(),
  };
}
