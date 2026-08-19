import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type { Principal } from '../../../shared/authorisation/principal';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  PatientMergedError,
  PatientNotFoundError,
  PriorityGroupNotFoundError,
  RestrictedPriorityGroupError,
} from '../domain/patient.errors';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
  type PriorityGroupRecord,
} from '../domain/patient.repository';
import {
  assertPriorityPeriodOrder,
  assertRecordablePriorityGroup,
  clinicalDateToday,
  isPeriodInForce,
  isRestrictedPriorityGroup,
  type PriorityGroupOrigin,
} from '../domain/priority-groups';
import type { Requester } from './patients.service';

/**
 * The REASON a patient is prioritised: reading it, recording it, closing it
 * (PA-033 to PA-042, REQ-024, D-026, D-027).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, AND NOT SYMMETRY WITH THE MODULE NEXT DOOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PatientsService` reads and writes an ADMINISTRATIVE record; this reads and
 * writes SPECIAL-CATEGORY HEALTH DATA under the LOPDP. Two different reasons
 * to change, which is one of the three limits ADR-008 §2 sets for splitting —
 * and it shows in the dependencies: only this one needs the `Principal`, to
 * enforce the second reading level of D-027 that no route decorator can
 * express, and only this one writes an audit entry for a read that opens no
 * chart.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SERVICE NEVER DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It never logs a group code. PA-042 and SC-010 say the reason must not appear
 * in a listing, an error message or a log line, and «no interpolar variables en
 * una llamada de log» is what keeps that true — the logger prunes by allowlist
 * and interpolation walks straight past it. The calculated LEVEL is served by
 * `PatientsService` instead, with `patient:read`, because the order is not the
 * reason.
 */
@Injectable()
export class PatientPriorityService {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * The reasons, as of today in Ecuador.
   *
   * ⚠️ THE RESTRICTED ROWS ARE OMITTED, NOT REFUSED (D-027).
   *
   * A 403 on a read would itself confirm that such a row exists for this
   * person — the very oracle PA-024 refuses to be for the register as a whole,
   * and here the datum is «víctima de violencia doméstica», where the
   * consequence is the safety of a person and not only their privacy. Somebody
   * without `patient:priority:protected` sees the ordinary groups and cannot
   * tell whether there is anything else. What they DO see, always, is the
   * calculated priority — which already counted those rows.
   *
   * AUDITED. It is an access to health data (PA-040, REQ-110), and it is a
   * DIFFERENT act from opening the chart, so it carries its own resource type:
   * «quién abrió la ficha» and «quién leyó por qué es prioritaria» are two
   * questions an investigation asks separately.
   */
  async list(
    patientId: string,
    requester: Requester,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<{
    asOf: ClinicalDate;
    records: readonly AssessedPriorityGroup[];
  }> {
    await this.assertLiveChart(patientId);

    const asOf = clinicalDateToday(now);
    const visible = (await this.patients.listPriorityGroups(patientId)).filter(
      (record) => this.mayHandle(record.group, principal),
    );

    /**
     * ⚠️ EL RASTRO NOMBRA LAS FICHAS QUE DE VERDAD SE LEYERON, y por eso se
     * escribe DESPUÉS de leer y no antes.
     *
     * Con PA-055 esta consulta trae los grupos de la ficha pedida Y los de las
     * que absorbió, que conservan su `patient_id` (D-031). Una sola fila de
     * bitácora con el id de la URL decía que se había leído la SUPERVIVIENTE
     * mientras se revelaba un dato de salud escrito en la ABSORBIDA, así que
     * «¿quién leyó por qué era prioritaria la ficha A?» no tenía ninguna fila
     * que nombrara a `A` — que es justo lo que REQ-110 y PA-040 existen para
     * poder contestar.
     *
     * LA FICHA PEDIDA VA SIEMPRE, aunque no tenga ni una valoración propia: el
     * acceso ocurrió por ella y una lectura que devuelve la lista vacía sigue
     * siendo una lectura que alguien hizo.
     *
     * Y SÓLO LAS FILAS VISIBLES. Si la absorbida sólo guarda un grupo
     * restringido y quien lee no tiene `patient:priority:protected`, no vio
     * nada de esa ficha y el rastro no debe decir que sí (D-027).
     */
    await this.recordChartAccess(
      [patientId, ...visible.map((record) => record.chartId)],
      'READ',
      requester,
    );

    return { asOf, records: visible.map((record) => assess(record, asOf)) };
  }

  /**
   * Records one assessment (PA-033, PA-036, PA-038, PA-039).
   *
   * The refusal for a restricted group IS an error here and not an omission,
   * unlike the read: the caller named the group themselves, so saying no
   * reveals nothing they did not already type.
   */
  async record(
    input: {
      patientId: string;
      group: string;
      startsOn: ClinicalDate;
      endsOn: ClinicalDate | null;
      origin: PriorityGroupOrigin;
      evidenceDocument: string | null;
    },
    requester: Requester,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<AssessedPriorityGroup> {
    await this.assertLiveChart(input.patientId);

    const group = assertRecordablePriorityGroup(input);
    if (isRestrictedPriorityGroup(group) && !this.mayHandle(group, principal)) {
      throw new RestrictedPriorityGroupError(group);
    }

    const created = await this.patients.addPriorityGroup({
      patientId: input.patientId,
      group,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      origin: input.origin,
      evidenceDocument: input.evidenceDocument,
      // PA-039. Not a parameter of the request: who recorded it is who is
      // signed in, or the trail could be written to say somebody else did.
      recordedById: requester.userId,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PRIORITY_RESOURCE_TYPE,
      resourceId: input.patientId,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
      // `before`/`after` are deliberately absent: the whitelist of
      // `access_audit_payload_only_for_declared_resources` is exactly
      // `'configuration'`, and a health datum in an append-only table that is
      // never purged could not be rectified afterwards (REQ-113, D-032).
    });

    // NOT `inForce: true`. A back-dated assessment whose end has already
    // passed is created and does not count, and saying otherwise on the
    // response would be the screen's only source for a fact the next GET
    // contradicts.
    return assess(created, clinicalDateToday(now));
  }

  /**
   * Closes a record by setting its end date. NEVER deletes it (PA-037).
   *
   * A record the caller may not see answers `PRIORITY_GROUP_NOT_FOUND` rather
   * than a refusal, for the same reason the listing omits it.
   */
  async close(
    input: { patientId: string; recordId: string; endsOn: ClinicalDate },
    requester: Requester,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<AssessedPriorityGroup> {
    await this.assertLiveChart(input.patientId);

    const existing = (
      await this.patients.listPriorityGroups(input.patientId)
    ).find((record) => record.id === input.recordId);

    if (!existing || !this.mayHandle(existing.group, principal)) {
      throw new PriorityGroupNotFoundError();
    }

    /**
     * LA MISMA REGLA QUE AL REGISTRAR, Y POR EL MISMO SITIO.
     *
     * Sin esto, cerrar con una fecha anterior a la de inicio llegaba hasta
     * `patient_priority_group_period_valid` y volvía como `422 CHECK_FAILED`:
     * un código genérico, sin campo bajo el que poner la frase, sobre un
     * formulario donde lo que está mal es exactamente una casilla. El `SPEC.md`
     * fija `PRIORITY_GROUP_PERIOD_INVALID` para esto, y la regla tiene que
     * valer en los dos caminos o no vale.
     *
     * DESPUÉS de comprobar que la fila existe y que quien llama puede verla:
     * un error de validación sobre una fila restringida confirmaría que la fila
     * está ahí, que es justo lo que `PRIORITY_GROUP_NOT_FOUND` evita (D-027).
     */
    assertPriorityPeriodOrder(existing.startsOn, input.endsOn);

    const closed = await this.patients.closePriorityGroup({
      patientId: input.patientId,
      recordId: input.recordId,
      endsOn: input.endsOn,
      closedById: requester.userId,
    });
    if (!closed) throw new PriorityGroupNotFoundError();

    // La misma razón que en `list`, sobre una escritura: la fila que se acaba
    // de fechar vive en `closed.chartId`, que tras una fusión no es la ficha de
    // la URL. Las dos se nombran — se modificó una valoración DE `chartId`, y
    // se hizo entrando POR `patientId`.
    await this.recordChartAccess(
      [input.patientId, closed.chartId],
      'UPDATE',
      requester,
    );

    // Closing «hoy» leaves it in force TODAY: the period is inclusive at both
    // ends, so a disability closed on the 15th still counted on the 15th.
    return assess(closed, clinicalDateToday(now));
  }

  /**
   * One audit row per chart actually touched, and never two for the same one.
   *
   * IN ONE PLACE, so «la bitácora nombra la ficha en la que está la fila» stops
   * being a rule each new route has to remember — and forgetting it does not
   * fail loudly, it writes the wrong chart's id for ever into a table that is
   * append-only and never purged.
   *
   * THE SHAPE OF THE ROW DOES NOT CHANGE: one entry still means one
   * (quién, qué recurso, qué acto). What changes is how many of them one
   * request produces, which is exactly the number of charts it opened.
   */
  private async recordChartAccess(
    chartIds: readonly string[],
    action: 'READ' | 'UPDATE',
    requester: Requester,
  ): Promise<void> {
    for (const chartId of new Set(chartIds)) {
      await this.audit.record({
        userId: requester.userId,
        resourceType: PRIORITY_RESOURCE_TYPE,
        resourceId: chartId,
        action,
        ip: requester.ip,
        userAgent: requester.userAgent,
        // `before`/`after` deliberately absent, as everywhere in this module:
        // `access_audit_payload_only_for_declared_resources` refuses a payload
        // outside `'configuration'`, and recording does not throw — the entry
        // would simply be lost (REQ-113, D-032).
      });
    }
  }

  /**
   * PA-045. The chart exists AND was not absorbed by a merge.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ALL THREE ROUTES, AND NOT ONLY THE TWO THAT WRITE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * «Toda operación que la nombre» is the requirement, and the reason is the
   * same on the read as on the writes: with D-031 not a single row is
   * re-pointed by a merge, so the groups recorded on an absorbed chart still
   * live there and the live chart's are somewhere else. Answering the absorbed
   * chart's list without saying so would show one half of a person's priority
   * as if it were all of it — and recording a new group on it would file a
   * health datum where nobody will look for it again.
   *
   * ⚠️ IT DOES NOT OPEN THE CHART. `findMergeState` reads identity and the
   * merge link, which is what makes it usable here: opening one is the
   * accountable act that writes an audit row (PA-022), and «is this merged?»
   * opens nothing. The audit entry these routes DO write is a different act —
   * «quién leyó por qué es prioritaria» — and it is written after this check,
   * so a refusal accounts for no access.
   */
  private async assertLiveChart(patientId: string): Promise<void> {
    const state = await this.patients.findMergeState(patientId);
    if (!state) throw new PatientNotFoundError();
    if (state.mergedIntoMrn !== null) {
      throw new PatientMergedError(state.mergedIntoMrn);
    }
  }

  /**
   * Whether this caller may see or write this group.
   *
   * The permission is NAMED HERE, in one place, rather than resolved into a
   * boolean by each controller. A boolean computed at the edge is a boolean
   * somebody eventually computes wrong, and the route decorator cannot express
   * it: a route declares ONE permission, and the second level depends on the
   * row, not on the endpoint.
   */
  private mayHandle(group: string, principal: Principal): boolean {
    if (!isRestrictedPriorityGroup(group)) return true;
    return principal.can('patient:priority:protected');
  }
}

/** A stored assessment plus the answer to «¿cuenta hoy?» (PA-036). */
export interface AssessedPriorityGroup extends PriorityGroupRecord {
  inForce: boolean;
}

/**
 * Computed on every read and never stored.
 *
 * The period is the FACT; «vigente» is a question about a day, and a column
 * holding the answer is a column that is wrong every morning until something
 * runs.
 */
function assess(
  record: PriorityGroupRecord,
  asOf: ClinicalDate,
): AssessedPriorityGroup {
  return { ...record, inForce: isPeriodInForce(record, asOf) };
}

/**
 * The resource type of the trail, distinct from `'patient'` ON PURPOSE.
 *
 * «¿Quién abrió la ficha de esta persona?» and «¿quién leyó por qué es
 * prioritaria?» are two questions, and answering the second by filtering
 * `'patient'` rows by hand is how an investigation gets the wrong answer.
 * `access_audit.resource_type` is a `varchar(64)` with no CHECK, so this is
 * the whole change.
 */
const PRIORITY_RESOURCE_TYPE = 'patient_priority_group';
