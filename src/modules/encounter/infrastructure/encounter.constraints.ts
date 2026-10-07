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
  /**
   * EN-165, D-062. The altitude correction only ever subtracts, so a corrected
   * value above the measured one is the pair typed the wrong way round. Named
   * on the CORRECTED box, the one that cannot be what it says it is.
   */
  encounter_vitals_corrected_not_above_measured: vitalsOutOfRange(
    'hemoglobinCorrectedGDl',
    'La hemoglobina corregida por altitud no puede ser mayor que la medida: revise si las ingresó al revés', // prettier-ignore
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
  /**
   * EN-085, EN-224. Refuting is when and who together; the reason is
   * optional, but never blank. The API trims a blank one to none, so only a
   * direct write reaches this.
   */
  patient_history_refutation_is_whole: {
    code: 'VALIDATION_FAILED',
    field: 'notes',
    message: 'El motivo, si se indica, no puede quedar en blanco',
  },
  /** EN-224. The same for an allergy: a reason only on a refuted one. */
  patient_allergy_refutation_is_coherent: {
    code: 'VALIDATION_FAILED',
    field: 'notes',
    message: 'El motivo, si se indica, no puede quedar en blanco',
  },
});

registerConstraintMeanings({
  // EN-229 (D-139.5). Only reached past the adapter, which counts under the
  // attention's lock: the same code and sentence it gives.
  clinical_note_one_002_chain_per_encounter: {
    code: 'CLINICAL_NOTE_ALREADY_OPEN',
    field: 'formCode',
    message:
      'Esta atención ya tiene su nota de consulta. Ábrala para seguir escribiendo o enmendarla',
  },
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
  /**
   * EN-166, EN-218. An annulled attention states who and when —the reason is
   * optional, and not blank if given— and a live one states none of them.
   * The service always writes both; this answers a writer that went around
   * it.
   */
  encounter_entered_in_error_states_who_when: {
    code: 'ENCOUNTER_ANNULMENT_INCOMPLETE',
    field: 'reason',
    message: 'Una atención anulada dice quién la anuló y cuándo, y un motivo escrito no puede quedar en blanco', // prettier-ignore
  },
  /** EN-167. The same for an interruption, with its origin. */
  encounter_discontinued_states_who_why_when: {
    code: 'ENCOUNTER_INTERRUPTION_REASON_REQUIRED',
    field: 'reason',
    message: 'Indique por qué se interrumpe la atención y si vino del paciente o del establecimiento', // prettier-ignore
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
  /**
   * EN-020. The deferred trigger: the consultation note signed and the
   * attention discharged with no diagnosis. The service refuses it first,
   * under the attention's lock; this is the sentence for whatever reaches the
   * commit anyway.
   */
  clinical_note_sign_needs_diagnosis: {
    code: 'NOTE_CONTENT_INCOMPLETE',
    field: 'diagnoses',
    message: 'Registre al menos un diagnóstico antes de firmar',
  },
  /**
   * EN-236. The same deferred trigger: diagnoses on the attention and none of
   * them the principal. The service refuses it first; this is the sentence
   * for whatever reaches the commit anyway.
   */
  clinical_note_sign_needs_principal_diagnosis: {
    code: 'NOTE_CONTENT_INCOMPLETE',
    field: 'principalDiagnosis',
    message: 'Registre la enfermedad o la lesión como diagnóstico principal antes de firmar', // prettier-ignore
  },
  /**
   * EN-217 (D-132 B). The deferred trigger: the consultation note signed and
   * the attention discharged with the mandatory anthropometry missing. The
   * service refuses it first naming each measure; this is the sentence for
   * whatever reaches the commit anyway.
   */
  clinical_note_sign_needs_anthropometry: {
    code: 'ANTHROPOMETRY_PENDING',
    field: 'weightKg',
    message: 'Falta peso/talla: obligatorio para firmar la nota',
  },
  /**
   * EN-217, D-134.3. A correction of the taking of a discharged attention
   * left the mandatory anthropometry missing. The adapter refuses it first,
   * under the attention's lock, naming each measure; this is the sentence for
   * whatever reaches the table another way.
   */
  encounter_vitals_anthropometry_after_discharge: {
    code: 'ANTHROPOMETRY_PENDING',
    field: 'weightKg',
    message: 'La atención ya tiene el alta: la corrección no puede dejar sin peso/talla obligatorios', // prettier-ignore
  },
  /**
   * EN-183, EN-188. The deferred trigger: a discharged attention lost its
   * principal at COMMIT. The adapter refuses it first, under the attention's
   * lock; this is the sentence for whatever reaches the table another way.
   */
  encounter_diagnosis_primary_after_discharge: {
    code: 'DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE',
    field: 'rank',
    message: 'La atención ya tiene el alta y necesita un diagnóstico principal: marque otro como principal antes de quitar o desmarcar éste', // prettier-ignore
  },
  /** EN-024. `clinical_note_chain_version_unique`: versions never repeat. */
  clinical_note_chain_version_unique: {
    code: 'NOTE_VERSION_TAKEN',
    field: 'version',
    message: 'Otra persona enmendó esta nota mientras usted la editaba. Actualice la pantalla y vuelva a intentarlo', // prettier-ignore
  },
  /**
   * EN-235 (D-147.3). `trg_encounter_diagnosis_principal_use`: an asterisk or
   * an external cause of the WHO's list never stays as the principal — when
   * registering, when its code changes, when it is marked principal. The one
   * source for the API, an import and a `psql`; the trigger raises the name
   * as the prefix of its message, which is how it travels.
   */
  encounter_diagnosis_principal_use: {
    code: 'DIAGNOSIS_PRINCIPAL_USE_INVALID',
    field: 'conceptId',
    message: 'Registre primero la enfermedad o la lesión',
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
 * EN-052 (D-160). The CEO-D / CPO-D. Every count is bounded by the teeth there
 * are — 32 permanent, 20 primary — and named on its own box; so is the sum of
 * the three, each tooth being in one category; the frozen age outside both
 * bands, and the other index's count, are not applicable. The figures MUST
 * match `20261007150002_encounter_dental_index` and
 * `20261007150005_encounter_dental_index_teeth_total`.
 */
const DENTAL_COUNTS = [
  ['decayed', 'cariados'],
  ['extracted', 'extraídos'],
  ['filled', 'obturados'],
  ['missing', 'perdidos'],
] as const;

registerConstraintMeanings({
  ...Object.fromEntries(
    DENTAL_COUNTS.flatMap(([field, label]) => [
      [
        `encounter_dental_index_${field}_range`,
        {
          code: 'VALIDATION_FAILED',
          field,
          message: `Los dientes ${label} deben estar entre 0 y 32: revise el valor ingresado`,
        },
      ],
      [
        `encounter_dental_index_${field}_required`,
        {
          code: 'VALIDATION_FAILED',
          field,
          message: `Indique los dientes ${label}`,
        },
      ],
      [
        `encounter_dental_index_${field}_primary`,
        {
          code: 'VALIDATION_FAILED',
          field,
          message: `El CEO-D cuenta dientes temporales: los ${label} son 20 como mucho`,
        },
      ],
    ]),
  ),
  encounter_dental_index_primary_total: {
    code: 'VALIDATION_FAILED',
    field: 'index',
    message: 'Entre cariados, extraídos y obturados no pueden pasar de los 20 dientes temporales', // prettier-ignore
  },
  encounter_dental_index_permanent_total: {
    code: 'VALIDATION_FAILED',
    field: 'index',
    message: 'Entre cariados, perdidos y obturados no pueden pasar de los 32 dientes permanentes', // prettier-ignore
  },
  encounter_dental_index_applies: {
    code: 'DENTAL_INDEX_NOT_APPLICABLE',
    field: 'index',
    message: 'Esta atención no lleva ese índice odontológico: sólo en odontología, el CEO-D con más de 6 meses y menos de 11 años, y el CPO-D desde los 12 años', // prettier-ignore
  },
  /**
   * EN-052. Whoever recorded the index stays its author. No body field sets
   * it, so the error names the attention the index belongs to.
   */
  encounter_dental_index_keeps_its_author: {
    code: 'VALIDATION_FAILED',
    field: 'encounterId',
    message: 'Quien registró el índice no cambia al corregirlo',
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
