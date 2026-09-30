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
import { assertSiteInScope } from '../../shared/authorisation/site-scope';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import {
  EncounterService,
  type Requester,
} from './application/encounter.service';
import { PatientAllergyService } from './application/patient-allergy.service';
import { toActiveAllergyResponse } from './dto/active-allergy.mapper';
import { assertBmiNotSupplied } from './domain/vital-signs';
import type { EncounterView } from './domain/encounter.repository';
import type { VitalSignsView } from './domain/encounter.repository';
import {
  ChartHistoryQueryDto,
  CloseEncounterDto,
  EncounterDetailDto,
  EncounterDto,
  EncounterListDto,
  EncounterPageDto,
  OpenEncounterDto,
  OpenEncountersQueryDto,
  RecordVitalsDto,
  VitalSignsDto,
  type EncounterDetailResponse,
  type EncounterListResponse,
  type EncounterPageResponse,
  type EncounterResponse,
  type VitalSignsResponse,
} from './dto/encounter.dto';

/**
 * The attention: opening it, reading it, closing it, and block D.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY ROUTE DECLARES `'query'` AND NOT `param:siteId`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The agenda is rooted at `agenda/sites/:siteId` because everything under it
 * belongs to one site's calendar, and there the guard can settle the scope on
 * its own. An attention is different: it is addressed by its OWN identifier
 * for the rest of its life (`/encounters/:id`), and a URL that also carried
 * the site would make the same attention reachable at two addresses — with the
 * site in the path becoming a value a caller supplies rather than a fact of
 * the row, which is D-023's trap read backwards.
 *
 * So the HANDLER narrows: every call resolves the caller's own scope with
 * `sitesFor` and hands it down, and every query carries it into the `WHERE`
 * rather than filtering afterwards. `route-authorisation.spec.ts` refuses a
 * `'global'` route that takes a `siteId` in its body, which is what keeps this
 * from silently becoming a promise nobody keeps.
 *
 * ⚠️ `POST /encounters` ASKS FOR `encounter:open`, NOT `record:write`
 * (EN-141, D-A-003). It is not a relaxation: art. 11 of the A.M. 00115-2021
 * puts the opening of the history on «personal de Gestión de Admisiones», so
 * opening is an ADMINISTRATIVE act. Widening `record:write` instead would drag
 * diagnosing and prescribing along with it — and it is what made EN-066
 * impossible to satisfy, because block D hangs off an attention that must
 * exist first and only `MEDICO` could create one.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters', version: '1' })
export class EncounterController {
  constructor(
    private readonly encounters: EncounterService,
    /**
     * EN-081. Injected for ONE route — the opening — and read through the
     * shared port, so this controller never learns where an allergy is stored.
     */
    private readonly allergies: PatientAllergyService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-146, EN-145. The attentions nobody has closed.
   *
   * ⚠️ DECLARED BEFORE `:id`, AND THAT IS LOAD-BEARING. NestJS matches routes
   * in declaration order, so `GET /encounters/open` has to be registered
   * before `GET /encounters/:id` or the literal segment would be swallowed by
   * the parameter and answer a 400 about a malformed UUID.
   *
   * ⚠️ AND IT IS THE WHOLE OF WHAT REPLACES AN AUTOMATIC CLOSURE (D-A-010).
   * There is no scheduled process in this module: a closure has to state a
   * discharge condition (EN-009), and a nightly job would have to invent a
   * clinical fact. What is left is that somebody can SEE what is open, and
   * this is it. It is the sector's *Open Items* — work with no committed hour
   * does not fit in the day's list because it has no hour to order it by.
   */
  @Get('open')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar las atenciones sin cerrar' })
  @ApiOkResponse({ type: EncounterListDto })
  async stillOpen(
    @Query() query: OpenEncountersQueryDto,
    @Req() req: Request,
  ): Promise<EncounterListResponse> {
    const items = await this.encounters.listStillOpen(
      query.practitionerId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toEncounterResponse) };
  }

  /**
   * EN-015, EN-068, EN-123, EN-162. One PAGE of a chart's attentions.
   *
   * ⚠️ PAGINADA, Y NO PORQUE EL NAVEGADOR SE ATRAGANTE. La ficha del paciente
   * cortaba en el cliente: se traía las ciento treinta y siete atenciones y
   * pintaba veinte. Eso reduce lo que se dibuja, no lo que viaja.
   *
   * ⚠️ Y SIGUE SIN LLEVAR CONTENIDO CLÍNICO — ni diagnóstico, ni nota, ni
   * signos (EN-123, EN-124). Es la condición de que esta lectura no se audite:
   * un listado con contenido clínico convertiría cada apertura de la pantalla
   * en la lectura de cuarenta historias sin dejar rastro. Un campo que rompa
   * eso rompe las dos cosas a la vez.
   *
   * ⚠️ IT INCLUDES THE ATTENTIONS OF THE CHARTS THIS ONE ABSORBED, and the
   * adapter resolves that with `chartScope` (PA-055). A merge re-points
   * nothing (D-031), so a read by the bare identifier makes half a history
   * disappear the day admissions repairs a duplicate — which is exactly the
   * defect `patient-chart-scope.spec.ts` fails the build over.
   *
   * NOT AUDITED (EN-123, SC-017): a listing carries identifiers and no
   * clinical content, and one row per listed attention would bury the accesses
   * that matter. Opening one is the accountable act, and it is audited.
   */
  @Get()
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar las atenciones de una historia clínica' })
  @ApiOkResponse({ type: EncounterPageDto })
  async history(
    @Query() query: ChartHistoryQueryDto,
    @Req() req: Request,
  ): Promise<EncounterPageResponse> {
    const page = await this.encounters.historyOf(
      {
        patientId: query.patientId,
        page: query.page,
        pageSize: query.pageSize,
      },
      this.requester(req, 'record:read'),
    );

    return {
      items: page.items.map(toEncounterResponse),
      // EN-162. Cuántas hay de verdad, para poder decir «20 de 137» sin
      // traerlas. El eco de `page` y `pageSize` es lo que ya hacen el registro
      // de pacientes y el árbol de catálogos: el cliente no tiene que
      // recordar qué pidió para pintar el paginador.
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * EN-001 to EN-008, EN-017, EN-127, EN-141. Opens an attention.
   *
   * ⚠️ EN-006 IS AN ABSENCE HERE AND IT IS THE POINT. Nothing refuses a second
   * attention for the same patient on the same day: the A.M. 00115-2021 is
   * literal — «tantas consultas como atenciones médicas recibidas» — and the
   * uniqueness anybody would add by instinct is what makes the mother who sees
   * the gynaecologist in the morning and the paediatrician in the afternoon
   * lose one of the two.
   */
  @Post()
  @RequirePermission('encounter:open', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Abrir una atención' })
  @ApiCreatedResponse({ type: EncounterDto })
  async open(
    @Body() dto: OpenEncounterDto,
    @Req() req: Request,
  ): Promise<EncounterResponse> {
    const requester = this.requester(req, 'encounter:open');
    /**
     * EN-121, D-023. The site arrives in the BODY, where the guard cannot see
     * it — guards run before pipes — so the HANDLER is what narrows. Refused
     * before anything is read, so a site out of scope never becomes a query.
     *
     * `SITE_SCOPE_DENIED` names the permission and never the site, so the
     * refusal does not answer «esa sede existe» to whoever guesses
     * identifiers.
     */
    assertSiteInScope(
      this.currentUser.requirePrincipal(),
      'encounter:open',
      dto.siteId,
    );

    const encounter = await this.encounters.open(
      {
        siteId: dto.siteId,
        practitionerId: dto.practitionerId,
        patientId: dto.patientId,
        agendaEntryId: dto.agendaEntryId,
        // The schema refuses an instant with no offset, so `Date` reads it
        // without guessing a zone — which for EN-008 is a whole day of
        // `age_days` on a neonate.
        startedAt: new Date(dto.startedAt),
        careModality: dto.careModality,
        careSetting: dto.careSetting,
        visitSequence: dto.visitSequence,
      },
      requester,
    );

    return toEncounterResponse(encounter);
  }

  /**
   * EN-081, EN-122. Opens one attention. THIS is the act the trail records.
   *
   * ⚠️ AND THE ACTIVE ALLERGIES COME WITH IT, IN THE SAME RESPONSE (EN-081).
   * That is the literal half of REQ-008 — «de forma visible de manera
   * permanente durante la consulta» — and a screen that had to ask for them
   * separately is a screen that one day does not. They are read through the
   * SAME shared reader `prescription` uses to check what is being prescribed
   * (EN-084), so the doctor sees exactly the list the prescriber checks
   * against, resolved over the chart AND the charts it absorbed.
   *
   * NO SECOND AUDIT ROW FOR THEM. Opening the attention is the accountable act
   * and it is already recorded; a second entry for a payload that arrived as
   * part of the first would double every consultation's trail, which is the
   * burying EN-123 exists to prevent.
   */
  @Get(':id')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Abrir una atención' })
  @ApiOkResponse({ type: EncounterDetailDto })
  async byId(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<EncounterDetailResponse> {
    const requester = this.requester(req, 'record:read');
    const encounter = await this.encounters.byId(id, requester);
    // Asked for AFTER the attention resolves, never before: an attention
    // outside the caller's scope must not become a way to learn that a chart
    // has allergies recorded on it.
    const allergies = await this.allergies.activeFor(encounter.patientId);

    return {
      ...toEncounterResponse(encounter),
      allergies: allergies.map(toActiveAllergyResponse),
    };
  }

  /**
   * EN-009, EN-131, EN-132, EN-139, EN-144, EN-147. Closes the account.
   *
   * A ROUTE OF ITS OWN AND NOT A `PATCH` OF THE STATE, for the same reason
   * `POST …/merge/undo` is one in `patients`: it is an act with an author, an
   * instant and — when it is a substitution — a reason of its own, not the
   * edit of a field. And `PATCH /encounters/:id/status` would be exactly the
   * box EN-134 forbids, since every other state is produced by documenting
   * something.
   *
   * 200 WITH THE ATTENTION and not 204: the screen repaints it as closed
   * without a second call.
   */
  @Post(':id/close')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar la cuenta de una atención' })
  @ApiOkResponse({ type: EncounterDto })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseEncounterDto,
    @Req() req: Request,
  ): Promise<EncounterResponse> {
    const closed = await this.encounters.close(
      {
        encounterId: id,
        substituteReason: dto.substituteReason,
        /**
         * EN-147. Whether the caller may close somebody else's attention,
         * read from the SESSION and never from the body. The guard already
         * settled `record:write`; this is the second, narrower question, and
         * a client that could answer it for itself would be authorising its
         * own substitution.
         */
        canSignRecords: this.currentUser.requirePrincipal().can('record:sign'),
      },
      this.requester(req, 'record:write'),
    );

    return toEncounterResponse(closed);
  }

  /**
   * EN-135. Nursing opened the vital-signs form.
   *
   * ⚠️ IT WRITES NOTHING CLINICAL AND IT IS STILL A `POST`: what it records is
   * that a step BEGAN, which is a fact about the visit and not a read. Between
   * this and saving block D there is a real half hour of pre-consultation, and
   * the board exists for that gap — «la están preparando» told apart from
   * «lista para pasar» (EN-136).
   */
  @Post(':id/vitals/start')
  @RequirePermission('vitals:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abrir la toma de signos vitales' })
  @ApiOkResponse({ type: EncounterDto })
  async startVitals(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<EncounterResponse> {
    const encounter = await this.encounters.startVitals(
      id,
      this.requester(req, 'vitals:write'),
    );
    return toEncounterResponse(encounter);
  }

  /**
   * EN-060 to EN-063, EN-066, EN-067, EN-136. Records block D — form **020**.
   *
   * ⚠️ `vitals:write` AND NOT `record:write` (EN-066, D-A-003/D-A-004). This
   * is what lets `ENFERMERIA` work before the doctor walks in, and it was
   * impossible until the opening got a permission of its own: block D hangs
   * off an attention that has to exist first, and creating one required
   * `record:write`, which only `MEDICO` carries. Nothing about holding this
   * permission authorises a diagnosis, a procedure or a prescription — that
   * absence is the separation of functions of the LOS art. 198 made into a
   * table of routes.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠️ `vitals:write` Y NO `nursing:write`, Y LA TABLA DE RUTAS YA LO DICE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * EN-066 nombraba `nursing:write`, y de fábrica lo lleva
   * SÓLO `ENFERMERIA` (`default-roles.ts`). Con ese permiso, EL MÉDICO NO
   * PUEDE REGISTRAR LOS SIGNOS — y en una consulta sin enfermería presente, o
   * en la clínica pequeña donde el médico pesa al niño él mismo, el bloque D
   * quedaría imposible de llenar. Es el mismo fallo de forma que D-A-003 acaba
   * de reparar por el otro lado: un permiso que deja a la mitad del personal
   * sin poder trabajar.
   *
   * `vitals:write` existe ya en el catálogo, lo llevan `MEDICO` y
   * `ENFERMERIA`, y satisface lo que EN-066 exige de verdad —«sin
   * `record:write`»—, que es lo que hace posible el trabajo de preconsulta.
   * `nursing:write` sigue siendo el permiso de los formularios 120 y 022
   * (EN-142), que este entregable no construye.
   *
   * **Decidirlo del todo es del usuario, no de un agente**: si la clínica
   * quiere que sólo enfermería toque el bloque D, se cambia esta línea por
   * `nursing:write` y se corrige EN-066. Queda escrito aquí para que la
   * divergencia se lea en el diff y no se descubra dentro de un año.
   *
   * A `PUT` AND NOT A `POST`: there is at most one taking per attention
   * (EN-067), so the operation is idempotent and repeating it must not create
   * a second row.
   */
  @Put(':id/vitals')
  @RequirePermission('vitals:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar los signos vitales de la atención' })
  @ApiOkResponse({ type: VitalSignsDto })
  async recordVitals(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordVitalsDto,
    @Req() req: Request,
  ): Promise<VitalSignsResponse> {
    /**
     * EN-061. Refused and NOT dropped. The schema lets an unknown key through
     * on purpose so this refusal can carry the code the requirement names:
     * stripping it would make the request succeed with the caller believing
     * the figure they typed is the one in the record, and it never is —
     * `trg_encounter_vitals_bmi` overwrites it in the same statement.
     */
    assertBmiNotSupplied(dto as { bmi?: unknown });

    const vitals = await this.encounters.recordVitals(
      id,
      {
        weightKg: dto.weightKg,
        heightCm: dto.heightCm,
        headCircumferenceCm: dto.headCircumferenceCm,
        abdominalCircumferenceCm: dto.abdominalCircumferenceCm,
        systolicBp: dto.systolicBp,
        diastolicBp: dto.diastolicBp,
        heartRate: dto.heartRate,
        respiratoryRate: dto.respiratoryRate,
        temperatureC: dto.temperatureC,
        oxygenSaturation: dto.oxygenSaturation,
        heightPosition: dto.heightPosition,
        hemoglobinGDl: dto.hemoglobinGDl,
        hemoglobinCorrectedGDl: dto.hemoglobinCorrectedGDl,
        presentingComplaint: dto.presentingComplaint,
        measuredAt:
          dto.measuredAt === undefined ? undefined : new Date(dto.measuredAt),
      },
      this.requester(req, 'vitals:write'),
    );

    return toVitalsResponse(vitals);
  }

  /**
   * EN-060, EN-068. Block D of one attention.
   *
   * `record:read` AND NOT `vitals:write`: reading a measurement is opening
   * clinical content, and the permission that authorises writing block D is
   * not the one that authorises reading the chart. A 200 with `null` when
   * nobody took the signs — an absence is itself an answer, and a 404 would
   * make «no se tomaron» indistinguishable from «esa atención no existe».
   */
  @Get(':id/vitals')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar los signos vitales de la atención' })
  @ApiOkResponse({ type: VitalSignsDto })
  async vitals(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<VitalSignsResponse | null> {
    const vitals = await this.encounters.vitalsOf(
      id,
      this.requester(req, 'record:read'),
    );
    return vitals === null ? null : toVitalsResponse(vitals);
  }

  /**
   * Who is asking, for the access trail and for the site scope.
   *
   * `req.ip` is only the real client because `trust proxy` is configured with
   * a COUNT of hops. Without it the trail the LOPDP expects us to follow when
   * investigating improper access would point at our own infrastructure.
   *
   * THE SCOPE IS RESOLVED PER PERMISSION and not once per request: a caller
   * can hold `record:read` at two sites and `record:write` at one, and reading
   * the wrong one would either widen a write or narrow a read.
   */
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
function toEncounterResponse(encounter: EncounterView): EncounterResponse {
  return {
    id: encounter.id,
    siteId: encounter.siteId,
    practitionerId: encounter.practitionerId,
    patientId: encounter.patientId,
    agendaEntryId: encounter.agendaEntryId,
    startedAt: encounter.startedAt.toISOString(),
    endedAt: encounter.endedAt?.toISOString() ?? null,
    status: encounter.status,
    careModality: encounter.careModality,
    careSetting: encounter.careSetting,
    visitSequence: encounter.visitSequence,
    // EN-008. The three units the RDACAA classifies by, as they were frozen.
    ageYears: encounter.ageYears,
    ageMonths: encounter.ageMonths,
    ageDays: encounter.ageDays,
    dischargeCondition: encounter.dischargeCondition,
    closedById: encounter.closedById,
    closedAt: encounter.closedAt?.toISOString() ?? null,
    closedBySubstituteReason: encounter.closedBySubstituteReason,
  };
}

/** `undefined` becomes `null`: an absent measurement is an answer, not a gap. */
function toVitalsResponse(vitals: VitalSignsView): VitalSignsResponse {
  return {
    encounterId: vitals.encounterId,
    weightKg: vitals.weightKg ?? null,
    heightCm: vitals.heightCm ?? null,
    headCircumferenceCm: vitals.headCircumferenceCm ?? null,
    abdominalCircumferenceCm: vitals.abdominalCircumferenceCm ?? null,
    // EN-061. The number the DATABASE computed, never one derived here.
    bmi: vitals.bmi,
    systolicBp: vitals.systolicBp ?? null,
    diastolicBp: vitals.diastolicBp ?? null,
    heartRate: vitals.heartRate ?? null,
    respiratoryRate: vitals.respiratoryRate ?? null,
    temperatureC: vitals.temperatureC ?? null,
    oxygenSaturation: vitals.oxygenSaturation ?? null,
    heightPosition: vitals.heightPosition ?? null,
    hemoglobinGDl: vitals.hemoglobinGDl ?? null,
    hemoglobinCorrectedGDl: vitals.hemoglobinCorrectedGDl ?? null,
    presentingComplaint: vitals.presentingComplaint ?? null,
    measuredAt: vitals.measuredAt.toISOString(),
    recordedBy: vitals.recordedBy,
    correctedBy: vitals.correctedBy,
    correctedAt: vitals.correctedAt?.toISOString() ?? null,
  };
}
