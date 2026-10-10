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
  /** EN-128. A suspended attention says why, who and since when. */
  encounter_on_hold_states_who_when_and_why: {
    code: 'ENCOUNTER_HOLD_REASON_REQUIRED',
    field: 'reason',
    message: 'Indique por qué sale el paciente',
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
   * EN-240 (D-188 §7). The deferred trigger: the consultation note signed and
   * the attention discharged with block F unanswered. The service refuses it
   * first; this is the sentence for whatever reaches the commit anyway. It
   * says what is missing and nothing else: every attention has one.
   */
  clinical_note_sign_needs_screening: {
    code: 'SCREENING_PENDING',
    field: 'screening',
    message: 'Responda el tamizaje: sin signos, no se aplicó o con signos',
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
 * EN-090 to EN-093, EN-249. The program blocks G, H and I. Who may have each
 * block, the last menstrual period, the vaccines and their risk group: the
 * triggers of `20261009100000_encounter_program_block_g`,
 * `…100100_encounter_program_block_h` and `…100200_encounter_program_block_i`.
 */
const PROGRAM_NOT_APPLICABLE = 'PROGRAM_BLOCK_NOT_APPLICABLE';

registerConstraintMeanings({
  encounter_obstetric_applies: {
    code: PROGRAM_NOT_APPLICABLE,
    field: 'encounterId',
    message: 'Esta atención no lleva datos obstétricos: la ficha no registra el embarazo en la fecha de la atención', // prettier-ignore
  },
  encounter_obstetric_weeks_range: {
    code: 'VALIDATION_FAILED',
    field: 'gestationalWeeks',
    message: 'Las semanas de gestación van de 1 a 42',
  },
  encounter_obstetric_lmp_for_fum: {
    code: 'VALIDATION_FAILED',
    field: 'lastMenstrualPeriod',
    message: 'Con el método FUM, escriba la fecha de la última menstruación',
  },
  encounter_obstetric_lmp_range: {
    code: 'VALIDATION_FAILED',
    field: 'lastMenstrualPeriod',
    message: 'La fecha de la última menstruación no puede ser posterior a la atención ni de hace más de 42 semanas', // prettier-ignore
  },
  encounter_nutrition_applies: {
    code: PROGRAM_NOT_APPLICABLE,
    field: 'encounterId',
    message: 'Esta atención no lleva datos de lactancia: se registran hasta los 8 meses de edad, con la pregunta de su edad, y en la mujer de 10 a 49 años sólo su propia lactancia', // prettier-ignore
  },
  encounter_nutrition_exclusive_required: {
    code: 'VALIDATION_FAILED',
    field: 'exclusiveBreastfeeding',
    message: 'Indique si en las últimas 24 horas recibió sólo leche materna',
  },
  encounter_nutrition_complementary_required: {
    code: 'VALIDATION_FAILED',
    field: 'complementaryFeeding',
    message: 'Indique si en las últimas 24 horas consumió alimento sólido, semisólido o suave', // prettier-ignore
  },
  encounter_vaccination_doses_shape: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'Cada vacuna lleva su dosis y, si lo pide, su grupo de riesgo',
  },
  encounter_vaccination_vaccine_in_force: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'Una de las vacunas no está en el catálogo vigente en la fecha de la atención', // prettier-ignore
  },
  encounter_vaccination_vaccine_distinct: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'La misma vacuna está dos veces: deje una sola dosis por vacuna',
  },
  encounter_vaccination_risk_group_required: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'Elija el grupo de riesgo de la vacuna: esa vacuna lo pide',
  },
  encounter_vaccination_risk_group_not_asked: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'Esa vacuna no lleva grupo de riesgo: déjelo vacío',
  },
  encounter_vaccination_risk_group_not_admitted: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'Ese grupo de riesgo no corresponde a la vacuna: elija uno de los suyos', // prettier-ignore
  },
  encounter_vaccination_risk_group_sex: {
    code: 'VALIDATION_FAILED',
    field: 'doses',
    message: 'Embarazada y puérpera no corresponden a un paciente de sexo masculino', // prettier-ignore
  },
  /**
   * EN-094. Block J. No message names the datum: «la prueba», «la sección».
   */
  encounter_hiv_test_confirmation_needs_reactive: {
    code: 'CONFIRMATORY_TEST_WITHOUT_SCREENING',
    field: 'confirmation',
    message: 'La segunda prueba y la vía de transmisión sólo se registran si la primera prueba fue reactiva', // prettier-ignore
  },
  encounter_hiv_test_route_needs_infection: {
    code: 'CONFIRMATORY_TEST_WITHOUT_SCREENING',
    field: 'transmissionRoute',
    message: 'Con la segunda prueba no reactiva no se registra la vía de transmisión', // prettier-ignore
  },
  encounter_hiv_test_confirmation_whole: {
    code: 'VALIDATION_FAILED',
    field: 'confirmation',
    message: 'La segunda prueba lleva su dispositivo y su resultado',
  },
  encounter_hiv_test_viral_load_range: {
    code: 'VALIDATION_FAILED',
    field: 'viralLoad',
    message: 'Revise la carga viral: va de 0 a 100 000 000 copias/mL',
  },
  encounter_hiv_test_cd4_range: {
    code: 'VALIDATION_FAILED',
    field: 'cd4',
    message: 'Revise el CD4: va de 0 a 5000 células/mm³',
  },
  encounter_hiv_test_change_is_stamped: {
    code: 'VALIDATION_FAILED',
    field: 'encounterId',
    message: 'Toda corrección de la sección dice quién y cuándo',
  },
  /** EN-249. Whoever recorded a block stays its author. */
  program_block_keeps_its_author: {
    code: 'VALIDATION_FAILED',
    field: 'encounterId',
    message: 'Quien registró el bloque no cambia al corregirlo',
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

/**
 * EN-071, EN-074, EN-077. Block F of form 002, from
 * `20261008170000_violence_screening_block_f`.
 *
 * ⚠️ NONE OF THESE MESSAGES NAMES A VALUE (EN-073). They say which field the
 * doctor has to fill, never what the screening says; PostgreSQL's `detail`,
 * which carries the row, is never read (`database-problem.ts`).
 */
registerConstraintMeanings({
  violence_screening_types_iff_positive: {
    code: 'VALIDATION_FAILED',
    field: 'types',
    message:
      'Con signos se marca al menos un tipo; sin signos no se marca ninguno',
  },
  violence_screening_action_iff_positive: {
    code: 'VALIDATION_FAILED',
    field: 'actionTaken',
    message: 'Con signos se escribe la acción tomada; sin signos, ninguna',
  },
  violence_screening_report_needs_positive: {
    code: 'VALIDATION_FAILED',
    field: 'reportedToAuthority',
    message: 'Sólo se notifica a la autoridad un tamizaje con signos',
  },
  /**
   * EN-074, EN-242. Every notified screening says who recorded the
   * notification and when; the adapter always stamps both.
   */
  violence_screening_notified_who_and_when: {
    code: 'VALIDATION_FAILED',
    field: 'notification',
    message: 'La notificación a la autoridad se registra con quién y cuándo',
  },
  /**
   * EN-242, EN-130. `trg_violence_screening_guard`, for whatever reaches the
   * table without the adapter, which refuses both first under the
   * attention's lock. They say the rule, never a value (EN-073).
   */
  violence_screening_after_discharge: {
    code: 'SCREENING_LOCKED_AFTER_DISCHARGE',
    field: 'notification',
    message:
      'La atención ya tiene el alta: del tamizaje sólo se completa la notificación a la autoridad',
  },
  violence_screening_moved: {
    code: 'VALIDATION_FAILED',
    field: 'screening',
    message: 'El tamizaje pertenece a su atención',
  },
  violence_screening_frozen: {
    code: 'ENCOUNTER_ALREADY_CLOSED',
    field: 'screening',
    message: 'La atención ya no admite contenido clínico nuevo',
  },
  violence_screening_report_block_iff_reported: {
    code: 'VALIDATION_FAILED',
    field: 'notification',
    message:
      'Al notificar se copian del formulario el número de serie, las lesiones, si identifica al agresor y el parentesco; sin notificar, ninguno',
  },
});

/**
 * encounter H8 (EN-100 to EN-107). The guarantees of
 * `20261008230100_referral_interconsultation_h8`. The service refuses the
 * ordinary cases first; these are the sentences for whatever reaches the
 * table anyway —a race, an import— and for the ones only the database can
 * judge, like what a counter-referral answers.
 */
registerConstraintMeanings({
  // EN-102. A counter-referral answers a live referral or derivation of the
  // same patient; and a referral or derivation never answers anything.
  referral_thread_coherence: {
    code: 'COUNTER_REFERRAL_WITHOUT_REFERRAL',
    field: 'respondsToId',
    message: 'Elija la referencia o derivación de este paciente que la contrarreferencia responde: no puede estar anulada', // prettier-ignore
  },
  // EN-102. At most one LIVE answer.
  referral_one_live_response: {
    code: 'REFERRAL_ALREADY_ANSWERED',
    field: 'respondsToId',
    message: 'Esa referencia ya tiene su contrarreferencia. Anule la anterior si se registró por error', // prettier-ignore
  },
  referral_answered_cannot_be_cancelled: {
    code: 'REFERRAL_ALREADY_ANSWERED',
    field: 'referralId',
    message: 'Esta referencia ya tiene su contrarreferencia: anule primero la contrarreferencia', // prettier-ignore
  },
  // EN-105. The deferred trigger at commit, and the annulment of the last
  // referral of a «referred» discharge.
  encounter_referred_needs_referral: {
    code: 'REFERRAL_REQUIRED_ON_DISCHARGE',
    field: 'dischargeCondition',
    message: 'La atención sale como «Referido»: necesita una referencia, derivación o referencia inversa emitida', // prettier-ignore
  },
  // EN-101.
  referral_destination_stated: {
    code: 'VALIDATION_FAILED',
    field: 'destination',
    message: 'Indique el UNICÓDIGO y el nombre del establecimiento de destino',
  },
  referral_destination_code_format: {
    code: 'VALIDATION_FAILED',
    field: 'destination.mspUnicode',
    message: 'El UNICÓDIGO del establecimiento lleva sólo números',
  },
  // EN-106.
  referral_reason_written: {
    code: 'VALIDATION_FAILED',
    field: 'reason',
    message: 'Escriba el motivo',
  },
  interconsultation_reason_written: {
    code: 'VALIDATION_FAILED',
    field: 'reason',
    message: 'Escriba el motivo',
  },
  // EN-107.
  referral_cancellation_complete: {
    code: 'VALIDATION_FAILED',
    field: 'reason',
    message: 'Una anulación dice quién la hizo, cuándo y por qué: escriba el motivo', // prettier-ignore
  },
  interconsultation_cancellation_complete: {
    code: 'VALIDATION_FAILED',
    field: 'reason',
    message: 'Una anulación dice quién la hizo, cuándo y por qué: escriba el motivo', // prettier-ignore
  },
  // EN-103.
  interconsultation_role_shape: {
    code: 'VALIDATION_FAILED',
    field: 'role',
    message: 'La interconsulta solicitada dice quién la pide; la recibida, quién la pidió y su respuesta', // prettier-ignore
  },
  referral_patient_matches_encounter: {
    code: 'VALIDATION_FAILED',
    field: 'patientId',
    message: 'La referencia es del paciente de su atención',
  },
  referral_born_issued: {
    code: 'VALIDATION_FAILED',
    field: 'status',
    message: 'Una referencia nace emitida',
  },
  // EN-104, EN-107. The 053 or 007 leaves only with its act.
  clinical_note_act_form_follows_its_act: {
    code: 'VALIDATION_FAILED',
    field: 'noteId',
    message: 'Este formulario se retira anulando su referencia o interconsulta',
  },
  // EN-130. New content only in a live attention.
  referral_needs_live_encounter: {
    code: 'ENCOUNTER_ALREADY_CLOSED',
    field: 'encounterId',
    message: 'La atención ya no admite contenido nuevo',
  },
  interconsultation_needs_live_encounter: {
    code: 'ENCOUNTER_ALREADY_CLOSED',
    field: 'encounterId',
    message: 'La atención ya no admite contenido nuevo',
  },
});

/**
 * The form 024 (EN-152 to EN-154, D-159). The adapters refuse each of these
 * first with the domain's own error; what reaches here is a race — the mark
 * switched on between the question and the commit, two revocations at once —
 * or a write from below the application, and it gets the same sentence
 * instead of a 500.
 */
registerConstraintMeanings({
  encounter_procedure_consent_required: {
    code: 'CONSENT_024_REQUIRED',
    field: 'consent',
    message:
      'Este procedimiento exige el consentimiento informado firmado (024): indique quién lo firmó o registre la excepción con su fundamento',
  },
  procedure_consent_signed_before_performed: {
    code: 'CONSENT_SIGNED_AFTER_PROCEDURE',
    field: 'consent.signedAt',
    message: 'La firma no puede ser posterior al procedimiento',
  },
  procedure_consent_refusal_states_who: {
    code: 'CONSENT_WITNESS_REQUIRED',
    field: 'witness',
    message:
      'Si el paciente no firma la negativa, indique el nombre y el documento del testigo',
  },
  procedure_consent_revocation_pkey: {
    code: 'CONSENT_NOT_REVOCABLE',
    field: 'consentId',
    message: 'Ese consentimiento ya se revocó. Actualice la lista',
  },
});
