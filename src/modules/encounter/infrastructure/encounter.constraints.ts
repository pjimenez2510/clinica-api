import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of the clinical core means to the person who hit it.
 *
 * Lives HERE, beside the repository and two directories from the migrations
 * that create these constraints, so adding one is a change inside the module
 * that owns it — never an edit to a shared file. Imported for its side effect
 * by `encounter.module.ts`.
 *
 * ⚠️ THE NAME OF A CONSTRAINT IS PART OF THE PUBLISHED CONTRACT. It travels to
 * the client through the PostgreSQL error mapping, which is why
 * `20260820055257_emergency_assessment_and_names` renamed
 * `encounter_discharged_states_state_a_condition` — «states_state» — to the
 * name used below. A rename here is a rename of the contract.
 *
 * These codes are deliberately NOT in `error-catalogue.ts`: they are produced
 * by PostgreSQL constraints, and this registration is their enumeration.
 *
 * ⚠️ `encounter_vitals_ranges` AND `clinical_note_one_current_per_chain` ARE
 * NOT HERE, and it is not an oversight. They are still registered in
 * `shared/http/pending-constraints.ts`, which was written to hold the entries
 * of a module that did not exist yet and says «move them when it does».
 * Moving them means editing `database-problem.ts` and the integration test
 * that imports the shared file, both outside this delivery's boundary. They
 * are named here so the next person finds the two halves together.
 */
registerConstraintMeanings({
  /**
   * EN-126. The column and the instant cannot disagree, in either direction.
   *
   * NOBODY SHOULD EVER SEE THIS THROUGH THE API: `planStateChange` composes
   * the pair, so every write from this module already satisfies it. It is
   * registered because the CHECK also guards an import, a `psql` and a use
   * case somebody writes in two years — and for those the honest answer is a
   * sentence rather than a constraint name.
   */
  encounter_status_matches_ended_at: {
    code: 'ENCOUNTER_STATE_INCONSISTENT',
    field: 'status',
    message: 'El estado de la atención no concuerda con su instante de cierre: una atención en curso no puede tener hora de fin, y una terminada no puede quedarse sin ella', // prettier-ignore
  },
  /**
   * EN-009. `DISCHARGED` and `COMPLETED` state HOW the attention ended.
   *
   * The service refuses it first with `DISCHARGE_CONDITION_REQUIRED` and its
   * field error, which is what a form can act on; this is the same rule for
   * the writer that did not come through the service.
   */
  encounter_discharge_states_a_condition: {
    code: 'DISCHARGE_CONDITION_REQUIRED',
    field: 'dischargeCondition',
    message: 'Indique cómo termina la atención: el paciente sale por su cuenta, se lo refiere, falleció o abandonó', // prettier-ignore
  },
  /**
   * EN-147, D-A-010. Either the closer is the practitioner who gave the
   * attention, or there is a written reason.
   *
   * THE THIRD COMBINATION IS THE ONE THAT MATTERS: a substitute closure with
   * no constancia reads, twelve months later, as though the attending doctor
   * had done it.
   */
  encounter_substitute_closure_states_reason: {
    code: 'SUBSTITUTE_CLOSURE_REASON_REQUIRED',
    field: 'substituteReason',
    message: 'Indique por qué cierra esta atención otra persona: queda registrado junto a la atención', // prettier-ignore
  },
  /** EN-010. `encounter_time_order`: the end never precedes the beginning. */
  encounter_time_order: {
    code: 'INVALID_TIME_RANGE',
    field: 'endedAt',
    message: 'La atención no puede terminar antes de la hora en que empieza',
  },
  /**
   * EN-027. `clinical_note_signature_coherence` ties the three columns of the
   * signature: `DRAFT` if and only if there is no instant, and no instant if
   * and only if there is neither signer nor hash. There is no «firmada a
   * medias».
   */
  clinical_note_signature_coherence: {
    code: 'NOTE_SIGNATURE_INCOMPLETE',
    field: 'signedAt',
    message: 'Una nota firmada tiene que decir quién la firmó y cuándo: no se puede firmar a medias', // prettier-ignore
  },
  /**
   * EN-025. `clinical_note_amendment_reason`: a version that replaces another
   * states why.
   *
   * Demanded three times on purpose — the DTO per field, the service for the
   * caller that does not come through it, and here for the writer that comes
   * through neither.
   */
  clinical_note_amendment_reason: {
    code: 'AMENDMENT_REASON_REQUIRED',
    field: 'amendmentReason',
    message: 'Indique el motivo de la enmienda: queda escrito junto a la versión nueva', // prettier-ignore
  },
  /** EN-024. `clinical_note_chain_version_unique`: versions never repeat. */
  clinical_note_chain_version_unique: {
    code: 'NOTE_VERSION_TAKEN',
    field: 'version',
    message: 'Otra persona enmendó esta nota mientras usted la editaba. Actualice la pantalla y vuelva a intentarlo', // prettier-ignore
  },
  /**
   * EN-043. `encounter_diagnosis_one_primary`, a partial unique index `ON
   * encounter_diagnosis (encounter_id) WHERE rank = 1`.
   *
   * THE SERVICE GETS THERE FIRST in the ordinary case — it reads the ranks in
   * use inside the write's own transaction and refuses with the same code —
   * and this entry is what answers the RACE it cannot close: two practitioners
   * who both read «libre» in the same millisecond, and the writer that comes
   * through neither. Same code from both paths, so a client branches once.
   *
   * Two principals make the monthly report count one consultation twice, in
   * two different causes of morbidity.
   */
  encounter_diagnosis_one_primary: {
    code: 'DIAGNOSIS_PRIMARY_TAKEN',
    field: 'rank',
    message: 'Esta atención ya tiene un diagnóstico principal. Registre éste como secundario, o cambie primero cuál es el principal', // prettier-ignore
  },
});

/**
 * ⚠️ LOS TRES DISPARADORES DEL NÚCLEO CLÍNICO NO ESTÁN AQUÍ, Y NO ES UN
 * OLVIDO.
 *
 * `trg_encounter_freeze_age`, `trg_encounter_matches_appointment` y
 * `trg_clinical_note_immutable` lanzan desde PL/pgSQL, así que PostgreSQL no
 * emite ninguna cláusula «violates check constraint "…"» y el nombre no viaja:
 * llegan sólo por SQLSTATE —`23000` los dos primeros, `42501` el tercero—, que
 * este registro no puede leer. `database-problem.ts` los mapea por su clase:
 *
 * Tampoco está `trg_diagnosis_snapshot` ni `trg_diagnosis_concept_in_force`,
 * por lo mismo que los tres de arriba: levantan
 * `integrity_constraint_violation` desde PL/pgSQL y el nombre no viaja. El
 * segundo lo adelanta el adaptador con `DIAGNOSIS_CONCEPT_NOT_IN_FORCE`
 * (EN-042); el primero no hace falta adelantarlo, porque la instantánea la
 * copia el propio adaptador del concepto que acaba de leer, así que sólo puede
 * dispararse contra quien escribe por otra vía — y para ése el 422 de clase es
 * la respuesta honesta.
 *
 *   - `23000` → `INTEGRITY_RULE_FAILED` (422). Es lo que sale cuando la
 *     atención empieza antes de que el paciente naciera, y cuando la cita
 *     nombrada es de otro paciente (EN-004). El servicio no puede adelantarse
 *     al primero —la fecha de nacimiento no viaja en la petición— y sí se
 *     adelanta al segundo, con `ENCOUNTER_APPOINTMENT_MISMATCH`.
 *   - `42501` → `IMMUTABLE_RECORD` (409). Es la nota firmada. El servicio se
 *     adelanta con `NOTE_ALREADY_SIGNED`, que es lo que EN-023 pide: un 403
 *     genérico le diría al médico que no tiene permisos cuando lo que pasa es
 *     que la nota está firmada.
 *
 * Tampoco está `clinical_note_one_current_per_chain`: es un índice único
 * PARCIAL, y Prisma resuelve la violación de unicidad ella misma (P2002)
 * devolviendo la COLUMNA y no el nombre del índice, así que este registro
 * nunca lo encontraría. Sigue en `pending-constraints.ts`.
 */
