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

import { PatientAllergyService } from './application/patient-allergy.service';
import type { Requester } from './application/encounter.service';
import type { AllergyView } from './domain/patient-allergy.repository';
import { toNoKnownAllergiesResponse } from './dto/active-allergy.mapper';
import {
  AllergyDto,
  AllergyListDto,
  NoKnownAllergiesDto,
  RecordAllergyDto,
  RefuteAllergyDto,
  type AllergyListResponse,
  type AllergyResponse,
  type NoKnownAllergiesResponse,
} from './dto/patient-allergy.dto';

/**
 * REQ-008 — allergies: recorded, listed, and ruled out but never deleted.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ IT LIVES UNDER `/patients/:patientId` AND IN `encounter`. BOTH ARE RIGHT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The URL is rooted at the chart because an allergy belongs to a PERSON and
 * outlives every consultation it is ever read in: addressing it through an
 * attention would make the same allergy reachable at as many URLs as the
 * patient has visits, and unreachable at all before the first one.
 *
 * The CODE is in this module because REQ-008's rule is «visible de manera
 * permanente durante la consulta», and the consultation is here. `patients`
 * left it explicitly out of its own scope — «sólo se puede comprobar cuando
 * exista la consulta» — and `patient_allergy` has gone since the first
 * migration without a single line of code. The SPEC says so in its scope
 * section: «la tabla vive en `patients` y la regla es de aquí».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `record:read` / `record:write`, AND `'global'` SITE SCOPE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `record:*` AND NOT `patient:*`: an allergy is clinical content, not the
 * administrative chart. Reception holds `patient:read` and keeps working
 * without ever receiving this — the same split PA-040 and PA-042 make for the
 * reason behind a priority group.
 *
 * `'global'` because an allergy HAS NO SITE. It is not the module's usual
 * `'query'`: an attention happens somewhere and a person's immune system does
 * not, so there is nothing for a handler to narrow. Stating it is the point —
 * «no site check» has to be a decision somebody wrote down. What still bounds
 * the caller is the permission itself, and the fact that `record:read` is not
 * granted to reception or billing.
 *
 * ⚠️ AND THERE IS NO `DELETE` ROUTE, WHICH IS EN-082 AS A TABLE OF ROUTES. The
 * only way an allergy stops counting is `…/refute`, which writes an instant
 * and a reason. A route that removed the row would make «se descartó» and «se
 * escribió por error» the same event, and they are not: one is a clinical
 * finding and the other is a typo.
 */
@ApiTags('encounter')
@Controller({ path: 'patients/:patientId', version: '1' })
export class PatientAllergyController {
  constructor(
    private readonly allergies: PatientAllergyService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-080 to EN-083, EN-087. Every allergy of the chart, ruled-out ones
   * included — AND the standing «sin alergias conocidas».
   *
   * ⚠️ SON TRES ESTADOS Y NO DOS, y sin el segundo campo esta respuesta sólo
   * podía expresar dos. Una lista vacía no significa «sin alergias»: significa
   * «no lo sabemos». Lo que distingue «sin alergias conocidas, afirmado por la
   * Dra. X el 14-03-2026» de «nadie lo preguntó» es que la afirmación viaje
   * CON SU AUTOR Y SU INSTANTE, que es lo que `chart-summary` ya hacía y esta
   * ruta no.
   *
   * ⚠️ THE REFUTED ONES TRAVEL HERE AND NOWHERE ELSE, and that is the whole
   * difference from the active list a consultation sees. «Saber que una
   * alergia se descartó es información clínica por derecho propio»: the
   * patient told they were allergic to penicillin who turned out not to be
   * needs that on the record, or in two years somebody writes it again.
   *
   * ⚠️ AUDITED, unlike every other listing in this module (EN-123). An allergy
   * IS clinical content, so this read discloses something about an
   * identifiable person — one entry per read, never one per row.
   */
  @Get('allergies')
  @RequirePermission('record:read', 'global')
  @ApiOperation({ summary: 'Listar las alergias del paciente' })
  @ApiOkResponse({ type: AllergyListDto })
  async list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<AllergyListResponse> {
    const chart = await this.allergies.listFor(
      patientId,
      this.requester(req, 'record:read'),
    );

    return {
      items: chart.allergies.map(toAllergyResponse),
      /**
       * EN-087. `null` es «no se preguntó» y nunca «no tiene». Es el mismo
       * presentador que sirve `chart-summary`, no un segundo: la frase de la
       * banda —«Sin alergias conocidas (Dra. X, 14-03-2026)»— tiene que decir
       * lo mismo se lea donde se lea.
       */
      noKnownAllergies:
        chart.noKnownAllergies === null
          ? null
          : toNoKnownAllergiesResponse(chart.noKnownAllergies),
    };
  }

  /**
   * EN-080, EN-083, EN-086. Records one allergy.
   *
   * `record:write` AND NOT `nursing:write` OR `vitals:write`. Nursing takes
   * the weight; deciding that a patient is allergic to something, with a
   * criticality attached, is a clinical judgement that goes on the record
   * permanently and drives what may be prescribed. Neither of the two nursing
   * permissions appears on any route of this file, and that absence is EN-142
   * as a table of routes rather than a paragraph somebody has to remember.
   *
   * 201, because what it leaves behind is a row that did not exist.
   */
  @Post('allergies')
  @RequirePermission('record:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar una alergia del paciente' })
  @ApiCreatedResponse({ type: AllergyDto })
  async record(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RecordAllergyDto,
    @Req() req: Request,
  ): Promise<AllergyResponse> {
    const allergy = await this.allergies.record(
      {
        patientId,
        substanceConceptId: dto.substanceConceptId,
        substanceText: dto.substanceText,
        reaction: dto.reaction,
        // EN-083. Whatever the caller answered, and never a value this layer
        // invented on their behalf.
        criticality: dto.criticality,
      },
      this.requester(req, 'record:write'),
    );

    return toAllergyResponse(allergy);
  }

  /**
   * EN-087. «Sin alergias conocidas», afirmado por quien está en la sesión.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * UNA RUTA, PORQUE ES UN ACTO — y ahí está toda la decisión
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The alternative anybody reaches for is a flag on the chart, set from the
   * patient form. That is the thing HL7's International Patient Summary
   * forbids by name: `nilknown` is «una afirmación positiva por parte de un
   * usuario clínico, y no una posición por defecto afirmada por un sistema
   * informático a falta de otra información». A route with a permission, an
   * author taken from the session and an audit entry is what makes the record
   * say WHO — and «Sin alergias conocidas (Dra. X, 14-03-2026)» is a different
   * sentence from «Alergias: no registradas».
   *
   * `record:write` AND NOT `nursing:write`, like recording one: asserting that
   * a patient has no known allergies drives what may be prescribed, and it is
   * the same clinical judgement seen from the other side.
   *
   * ⚠️ THERE IS NO ROUTE TO UNDO IT AND NONE TO EDIT IT, and the table refuses
   * both anyway. What ends an assertion is recording an allergy — the ordinary
   * course of events: it was asked, there was none, and in October one
   * appeared. Nothing about that makes the March assertion false; it makes it
   * no longer the last word, which is a question the read answers.
   *
   * 201, because what it leaves behind is a row that did not exist.
   */
  @Post('allergies/none-known')
  @RequirePermission('record:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Afirmar que el paciente no tiene alergias conocidas',
  })
  @ApiCreatedResponse({ type: NoKnownAllergiesDto })
  async assertNoKnownAllergies(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<NoKnownAllergiesResponse> {
    const assertion = await this.allergies.assertNoKnownAllergies(
      patientId,
      // The author is the SESSION and never a field in the body: a caller who
      // could name the clinician could put somebody else's name behind an
      // assertion that changes what gets prescribed.
      this.requester(req, 'record:write'),
    );

    return toNoKnownAllergiesResponse(assertion);
  }

  /**
   * EN-082. Rules one out: the instant and the reason, never a deletion.
   *
   * A ROUTE OF ITS OWN AND NOT A `PATCH` OF `refutedAt`, for the same reason
   * `…/notes/:id/retract` and `…/merge/undo` are: it is an ACT with an author,
   * an instant and a mandatory reason of its own, not the edit of a field. A
   * `PATCH` would also make «descartada» something a client could set back to
   * `null`, and un-refuting is not an operation this system has.
   *
   * 200 WITH THE ALLERGY and not 204: the screen repaints it as ruled out
   * without a second call.
   */
  @Post('allergies/:allergyId/refute')
  @RequirePermission('record:write', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar una alergia del paciente' })
  @ApiOkResponse({ type: AllergyDto })
  async refute(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('allergyId', ParseUUIDPipe) allergyId: string,
    @Body() dto: RefuteAllergyDto,
    @Req() req: Request,
  ): Promise<AllergyResponse> {
    const refuted = await this.allergies.refute(
      { patientId, allergyId, notes: dto.notes },
      this.requester(req, 'record:write'),
    );
    return toAllergyResponse(refuted);
  }

  /**
   * Who is asking, for the access trail.
   *
   * The site scope is resolved anyway and travels unused: `Requester` is the
   * module's one shape, and a second one that omitted the field would be a
   * shape somebody eventually passes to a method that needs it. What makes
   * these routes `'global'` is the declaration on each of them, which is what
   * `route-authorisation.spec.ts` reads.
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
function toAllergyResponse(allergy: AllergyView): AllergyResponse {
  return {
    id: allergy.id,
    patientId: allergy.patientId,
    substanceConceptId: allergy.substanceConceptId,
    substanceText: allergy.substanceText,
    reaction: allergy.reaction,
    criticality: allergy.criticality,
    recordedAt: allergy.recordedAt.toISOString(),
    // EN-082. `null` means «sigue contando»; a date means somebody ruled it
    // out and wrote why. The row is never absent.
    refutedAt: allergy.refutedAt?.toISOString() ?? null,
    refutedNotes: allergy.refutedNotes,
  };
}
