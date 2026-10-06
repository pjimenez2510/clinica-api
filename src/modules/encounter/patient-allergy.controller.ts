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

import { NoKnownAllergiesService } from './application/no-known-allergies.service';
import { PatientAllergyService } from './application/patient-allergy.service';
import type { Requester } from './application/encounter.service';
import type { AllergyView } from './domain/patient-allergy.repository';
import { toNoKnownAllergiesResponse } from './dto/active-allergy.mapper';
import {
  AllergyDto,
  AllergyListDto,
  AllergyVersionListDto,
  AssertRefutingDto,
  AssertRefutingResponseDto,
  EditAllergyDto,
  NoKnownAllergiesDto,
  RecordAllergyDto,
  RefuteAllergyDto,
  type AllergyListResponse,
  type AllergyResponse,
  type AllergyVersionListResponse,
  type AssertRefutingResponse,
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
 * and who; an edit (EN-225) or a reactivation (EN-224) keeps what it replaced
 * as a version. A route that removed the row would make «se descartó» and «se
 * escribió por error» the same event, and they are not: one is a clinical
 * finding and the other is a typo.
 */
@ApiTags('encounter')
@Controller({ path: 'patients/:patientId', version: '1' })
export class PatientAllergyController {
  constructor(
    private readonly allergies: PatientAllergyService,
    private readonly noKnownAllergies: NoKnownAllergiesService,
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
   * EN-080, EN-083, EN-086, EN-164. Records one allergy.
   *
   * `background:write` AND NOT `record:write` (EN-164). Recording what the
   * patient declares is anamnesis, and F-03 puts it in preparation: nursing
   * takes it without holding the permission that diagnoses and prescribes
   * (EN-142). What stays a clinical judgement — ruling an allergy OUT — keeps
   * `record:write` on the refutation route below. The author is the session's
   * account, written in the row (EN-086).
   *
   * 201, because what it leaves behind is a row that did not exist.
   */
  @Post('allergies')
  @RequirePermission('background:write', 'global')
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
   * IT IS NOT EDITED. What ends an assertion is recording an allergy — the
   * ordinary course of events: it was asked, there was none, and in October
   * one appeared — or, since EN-226, withdrawing it when it was a mistake
   * (`…/none-known/retract`), which keeps the row and says who and when.
   *
   * 201, because what it leaves behind is a row that did not exist.
   */
  @Post('allergies/none-known')
  @RequirePermission('background:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Afirmar que el paciente no tiene alergias conocidas',
  })
  @ApiCreatedResponse({ type: NoKnownAllergiesDto })
  async assertNoKnownAllergies(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<NoKnownAllergiesResponse> {
    const assertion = await this.noKnownAllergies.assertNoKnownAllergies(
      patientId,
      // The author is the SESSION and never a field in the body: a caller who
      // could name the clinician could put somebody else's name behind an
      // assertion that changes what gets prescribed.
      this.requester(req, 'record:write'),
    );

    return toNoKnownAllergiesResponse(assertion);
  }

  /**
   * EN-082, EN-224. Rules one out: the instant, who, and a reason if one was
   * chosen — never a deletion.
   *
   * A ROUTE OF ITS OWN AND NOT A `PATCH` OF `refutedAt`, for the same reason
   * `…/notes/:id/retract` and `…/merge/undo` are: it is an ACT with an author
   * and an instant, not the edit of a field. Undoing it is its own act too
   * (`…/reactivate`), which keeps the refutation as a version.
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
   * EN-225. Edits what the allergy says, in its row; the version it replaces
   * is kept. `record:write` like refuting: changing the substance changes
   * what the prescription check reads, which is the same clinical judgement
   * as ruling one out (EN-164).
   */
  @Patch('allergies/:allergyId')
  @RequirePermission('record:write', 'global')
  @ApiOperation({ summary: 'Corregir una alergia del paciente' })
  @ApiOkResponse({ type: AllergyDto })
  async edit(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('allergyId', ParseUUIDPipe) allergyId: string,
    @Body() dto: EditAllergyDto,
    @Req() req: Request,
  ): Promise<AllergyResponse> {
    const edited = await this.allergies.edit(
      {
        patientId,
        allergyId,
        changes: {
          // EN-225, EN-084. Each key only when it came: an absent concept is
          // KEPT, and only an explicit `null` clears it.
          ...(dto.substanceText === undefined
            ? {}
            : { substanceText: dto.substanceText }),
          ...(dto.substanceConceptId === undefined
            ? {}
            : { substanceConceptId: dto.substanceConceptId }),
          ...(dto.reaction === undefined ? {} : { reaction: dto.reaction }),
          ...(dto.criticality === undefined
            ? {}
            : { criticality: dto.criticality }),
        },
      },
      this.requester(req, 'record:write'),
    );
    return toAllergyResponse(edited);
  }

  /**
   * EN-224. Brings back an allergy refuted by mistake. `background:write`,
   * like recording one: it makes the allergy count again, the safe direction,
   * and nursing could record it anew anyway.
   */
  @Post('allergies/:allergyId/reactivate')
  @RequirePermission('background:write', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivar una alergia descartada por error' })
  @ApiOkResponse({ type: AllergyDto })
  async reactivate(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('allergyId', ParseUUIDPipe) allergyId: string,
    @Req() req: Request,
  ): Promise<AllergyResponse> {
    const reactivated = await this.allergies.reactivate(
      patientId,
      allergyId,
      this.requester(req, 'background:write'),
    );
    return toAllergyResponse(reactivated);
  }

  /** EN-225. The versions the changes replaced; `record:read`, audited. */
  @Get('allergies/:allergyId/versions')
  @RequirePermission('record:read', 'global')
  @ApiOperation({ summary: 'Versiones anteriores de una alergia' })
  @ApiOkResponse({ type: AllergyVersionListDto })
  async versions(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('allergyId', ParseUUIDPipe) allergyId: string,
    @Req() req: Request,
  ): Promise<AllergyVersionListResponse> {
    const versions = await this.allergies.versionsOf(
      patientId,
      allergyId,
      this.requester(req, 'record:read'),
    );
    return {
      items: versions.map((version) => ({
        version: version.version,
        replacedBy: version.replacedBy,
        replacedAt: version.replacedAt.toISOString(),
        allergy: toAllergyResponse(version.allergy),
      })),
    };
  }

  /**
   * EN-226. «Descartar estas y afirmar»: the active allergies the screen
   * listed are ruled out, with «Descartada al afirmar sin alergias
   * conocidas», and «sin alergias conocidas» is asserted, in one step.
   * `record:write`, because ruling out is. One of HIGH criticality refuses
   * it (`ALLERGY_REFUTED_ALONE`, D-140.3). The response names what this step
   * ruled out, which is what «Deshacer» reactivates.
   */
  @Post('allergies/none-known/refuting-active')
  @RequirePermission('record:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Descartar las alergias activas y afirmar que no hay ninguna',
  })
  @ApiCreatedResponse({ type: AssertRefutingResponseDto })
  async assertRefuting(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: AssertRefutingDto,
    @Req() req: Request,
  ): Promise<AssertRefutingResponse> {
    const { assertion, refutedAllergyIds } =
      await this.noKnownAllergies.assertRefuting(
        patientId,
        dto.allergyIds,
        this.requester(req, 'record:write'),
      );
    return { ...toNoKnownAllergiesResponse(assertion), refutedAllergyIds };
  }

  /**
   * EN-226. Withdraws the standing «sin alergias conocidas» asserted by
   * mistake. `background:write`, like asserting it: it moves the chart back
   * to «no se preguntó», never towards fewer allergies. 204: there is
   * nothing standing left to return.
   */
  @Post('allergies/none-known/retract')
  @RequirePermission('background:write', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar «Sin alergias conocidas»' })
  @ApiNoContentResponse()
  async retractNoKnownAllergies(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.noKnownAllergies.retract(
      patientId,
      this.requester(req, 'background:write'),
    );
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
    // EN-086. `null` only for rows older than the column.
    recordedBy: allergy.recordedBy,
    refutedBy: allergy.refutedBy,
    changedAt: allergy.changedAt?.toISOString() ?? null,
    changedBy: allergy.changedBy,
  };
}
