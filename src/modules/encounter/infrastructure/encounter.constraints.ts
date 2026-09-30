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
 * ⚠️ `clinical_note_one_current_per_chain` IS NOT HERE, and it is not an
 * oversight. It is still registered in `shared/http/pending-constraints.ts`,
 * which was written to hold the entries of a module that did not exist yet and
 * says «move them when it does». It is named here so the next person finds the
 * two halves together. The vitals ranges used to wait there too; they moved
 * here when D-058 split them into one constraint per measure.
 */

/**
 * EN-062, D-058. One `encounter_vitals_ranges_*` CHECK per measure, and one
 * entry here per CHECK, each pointing at the DTO field the nurse has to fix.
 *
 * ⚠️ WHY ONE CONSTRAINT PER MEASURE. PostgreSQL names the constraint that
 * failed and puts the offending VALUE in `detail`, which is the patient's row
 * and is never read (see `database-problem.ts`). With the single
 * `encounter_vitals_ranges` of before, the 422 could only say «alguno de los
 * signos vitales», and the SPEC asks for the field. The name is now the answer,
 * and the ranges still live only in the migration: the message restates them
 * for the reader, it does not enforce them.
 *
 * The figures below MUST match
 * `20260930124150_encounter_vitals_ranges_per_measure`; the integration tests
 * of EN-062 try every bound on both sides against the real database.
 */
function vitalsOutOfRange(field: string, message: string) {
  return { code: 'VITALS_OUT_OF_RANGE', field, message };
}

registerConstraintMeanings({
  encounter_vitals_ranges_weight_kg: vitalsOutOfRange(
    'weightKg',
    'El peso debe estar entre 0.3 y 400 kg: revise el valor ingresado',
  ),
  encounter_vitals_ranges_height_cm: vitalsOutOfRange(
    'heightCm',
    'La talla debe estar entre 20 y 260 cm: revise el valor ingresado',
  ),
  encounter_vitals_ranges_head_circumference_cm: vitalsOutOfRange(
    'headCircumferenceCm',
    'El perímetro cefálico debe estar entre 20 y 80 cm: revise el valor ingresado', // prettier-ignore
  ),
  encounter_vitals_ranges_abdominal_circumference_cm: vitalsOutOfRange(
    'abdominalCircumferenceCm',
    'El perímetro abdominal debe estar entre 20 y 250 cm: revise el valor ingresado', // prettier-ignore
  ),
  encounter_vitals_ranges_systolic_bp: vitalsOutOfRange(
    'systolicBp',
    'La tensión sistólica debe estar entre 40 y 300 mmHg: revise el valor ingresado', // prettier-ignore
  ),
  encounter_vitals_ranges_diastolic_bp: vitalsOutOfRange(
    'diastolicBp',
    'La tensión diastólica debe estar entre 20 y 200 mmHg: revise el valor ingresado', // prettier-ignore
  ),
  /**
   * The one pairing among the ranges. Pointed at the systolic because that is
   * the first of the two boxes; 80/120 is almost always both typed the wrong
   * way round, and the sentence says so.
   */
  encounter_vitals_ranges_systolic_above_diastolic: vitalsOutOfRange(
    'systolicBp',
    'La tensión sistólica debe ser mayor que la diastólica: revise si las ingresó al revés', // prettier-ignore
  ),
  encounter_vitals_ranges_heart_rate: vitalsOutOfRange(
    'heartRate',
    'La frecuencia cardiaca debe estar entre 20 y 300 lpm: revise el valor ingresado', // prettier-ignore
  ),
  encounter_vitals_ranges_respiratory_rate: vitalsOutOfRange(
    'respiratoryRate',
    'La frecuencia respiratoria debe estar entre 4 y 100 rpm: revise el valor ingresado', // prettier-ignore
  ),
  encounter_vitals_ranges_temperature_c: vitalsOutOfRange(
    'temperatureC',
    'La temperatura debe estar entre 25 y 45 °C: revise el valor ingresado',
  ),
  encounter_vitals_ranges_oxygen_saturation: vitalsOutOfRange(
    'oxygenSaturation',
    'La saturación de oxígeno debe estar entre 30 y 100 %: revise el valor ingresado', // prettier-ignore
  ),
  // EN-065, with D-058's criterion: wide, it catches 115 typed for 11,5.
  encounter_vitals_ranges_hemoglobin_g_dl: vitalsOutOfRange(
    'hemoglobinGDl',
    'La hemoglobina debe estar entre 1 y 25 g/dl: revise el valor ingresado',
  ),
  encounter_vitals_ranges_hemoglobin_corrected_g_dl: vitalsOutOfRange(
    'hemoglobinCorrectedGDl',
    'La hemoglobina corregida debe estar entre 1 y 25 g/dl: revise el valor ingresado', // prettier-ignore
  ),
});

registerConstraintMeanings({
  /**
   * EN-064. A height and its position go together: one without the other
   * mixes two scales at exactly the age a child changes from one to the other.
   */
  encounter_vitals_height_needs_position: {
    code: 'VITALS_HEIGHT_POSITION_REQUIRED',
    field: 'heightPosition',
    message: 'Indique si la talla se tomó de pie o acostado: son medidas distintas', // prettier-ignore
  },
  /**
   * EN-065. There is no corrected value without the value it corrects. Named
   * on the MEASURED box, which is the one to fill — the screen says the same.
   */
  encounter_vitals_corrected_needs_hemoglobin: {
    code: 'VALIDATION_FAILED',
    field: 'hemoglobinGDl',
    message: 'Registre la hemoglobina medida antes de la corregida por altitud',
  },
  /** EN-163. A blank reason is not a reason: it either says something or is absent. */
  encounter_vitals_presenting_complaint_not_blank: {
    code: 'VALIDATION_FAILED',
    field: 'presentingComplaint',
    message: 'Escriba el motivo o deje la casilla vacía',
  },
  /** EN-085. A family history says whose; a personal one names no relative. */
  patient_history_family_names_relative: {
    code: 'VALIDATION_FAILED',
    field: 'relative',
    message: 'Indique de qué familiar es el antecedente, y sólo en los familiares', // prettier-ignore
  },
  patient_history_description_not_blank: {
    code: 'VALIDATION_FAILED',
    field: 'description',
    message: 'Describa el antecedente',
  },
  /** EN-085. Refuting is a whole act: when, why and who, or nothing. */
  patient_history_refutation_is_whole: {
    code: 'REFUTATION_REASON_REQUIRED',
    field: 'notes',
    message: 'Indique por qué se descarta este antecedente',
  },
});

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
