import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  ChartSummaryService,
  type ChartSummary,
} from './application/chart-summary.service';
import type { Requester } from './application/encounter.service';
import {
  toActiveAllergyResponse,
  toNoKnownAllergiesResponse,
} from './dto/active-allergy.mapper';
import {
  ChartSummaryDto,
  type ChartSummaryResponse,
} from './dto/chart-summary.dto';

/**
 * EN-159 to EN-161. The patient's history, without leaving the consultation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROUTE, AND THE REASON IT IS ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 4 of `FLUJO-DE-LA-ATENCION.md`: while attending, the doctor «tiene
 * delante la historia entera — atenciones anteriores, diagnósticos, alergias,
 * lo que se le recetó la última vez. Eso no es una pantalla aparte a la que
 * hay que ir: es parte de la consulta».
 *
 * A screen that has to remember to call five endpoints is a screen that one
 * day calls four, and the one it drops is the allergies. And §7 bis says the
 * documented problem is not missing data but FRAGMENTATION, so a client
 * stitching five responses together IS the problem, restated.
 *
 * ⚠️ ADDRESSED BY THE ATTENTION AND NOT BY THE CHART. The chart comes off the
 * attention's row, never off the request: a `patientId` a caller could name
 * would turn one site's `record:read` into a way to read the diagnoses of any
 * chart in the clinic. The site scope is declared `'query'` for the same
 * reason as the rest of the module — the site is not in the URL, so the
 * HANDLER narrows.
 *
 * ⚠️ AND IT IS AUDITED AS ONE READ, NOT FORTY (EN-161). What comes back
 * carries diagnoses, so opening it is the accountable act (EN-122). What it
 * must not do is write a row per listed attention: burying the accesses that
 * matter under forty that say nothing is the line EN-123, AG-072 and PA-023
 * already drew.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId', version: '1' })
export class ChartSummaryController {
  constructor(
    private readonly summaries: ChartSummaryService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * EN-159 to EN-161. The history behind this attention, compact.
   *
   * `record:read` because it is the chart being opened: nothing here is
   * written, and the permission that authorises writing the record is not the
   * one that authorises reading it.
   *
   * ⚠️ THAT INCLUDES `ENFERMERIA`, WHICH HOLDS `record:read` ON PURPOSE — «lee
   * la historia porque unos signos vitales sin contexto no sirven de nada»,
   * says `default-roles.ts`. Whoever weighs a child needs to know what the
   * child weighed in March, which is the very first thing §7 bis records
   * clinicians missing. What nursing does not hold is `record:write`, so it
   * reads this and records no allergy, no diagnosis and no prescription. The
   * line is drawn at writing, not at looking.
   *
   * ⚠️ WHAT DOES NOT REACH IT IS RECEPTION AND BILLING, which hold
   * `patient:read` and not `record:read`. They keep working and this payload —
   * diagnoses included — is simply not part of what they receive.
   */
  @Get('chart-summary')
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary: 'Consultar la historia del paciente durante la atención',
  })
  @ApiOkResponse({ type: ChartSummaryDto })
  async byEncounter(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ChartSummaryResponse> {
    const summary = await this.summaries.forEncounter(
      encounterId,
      this.requester(req),
    );
    return toChartSummaryResponse(summary);
  }

  /**
   * Who is asking, and over which sites.
   *
   * THE SCOPE IS RESOLVED FOR `record:read` SPECIFICALLY, like everywhere else
   * in this module: a caller can hold `record:read` at two sites and
   * `record:write` at one, and reading the wrong one would widen this.
   */
  private requester(req: Request): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor('record:read');

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
function toChartSummaryResponse(summary: ChartSummary): ChartSummaryResponse {
  return {
    encounterId: summary.encounterId,
    patientId: summary.patientId,
    allergies: summary.allergies.map(toActiveAllergyResponse),
    /**
     * EN-087. `null` is «no se preguntó» and never «no tiene». The screen has
     * three states to paint because this field is beside the list, and the
     * absent case is a state of its own rather than the list's silence.
     */
    noKnownAllergies:
      summary.noKnownAllergies === null
        ? null
        : toNoKnownAllergiesResponse(summary.noKnownAllergies),
    previousEncounters: summary.previousEncounters.map((encounter) => ({
      id: encounter.id,
      siteId: encounter.siteId,
      startedAt: encounter.startedAt.toISOString(),
      status: encounter.status,
      careModality: encounter.careModality,
      careSetting: encounter.careSetting,
      visitSequence: encounter.visitSequence,
      dischargeCondition: encounter.dischargeCondition,
      diagnoses: encounter.diagnoses.map((diagnosis) => ({
        // EN-041. The code as it was FROZEN, never as the catalogue reads it
        // today.
        cie10Code: diagnosis.cie10Code,
        cie10Display: diagnosis.cie10Display,
        certainty: diagnosis.certainty,
        rank: diagnosis.rank,
      })),
      vitals:
        encounter.vitals === null
          ? null
          : {
              weightKg: encounter.vitals.weightKg,
              heightCm: encounter.vitals.heightCm,
              bmi: encounter.vitals.bmi,
              systolicBp: encounter.vitals.systolicBp,
              diastolicBp: encounter.vitals.diastolicBp,
              temperatureC: encounter.vitals.temperatureC,
              measuredAt: encounter.vitals.measuredAt.toISOString(),
            },
    })),
    totalEncounters: summary.totalEncounters,
  };
}
