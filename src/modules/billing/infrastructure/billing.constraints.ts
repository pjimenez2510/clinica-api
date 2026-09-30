import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each billing constraint means to the person who hit it.
 *
 * Lives HERE, beside the adapters and two directories from the migration that
 * creates these constraints, so adding one is a change inside the module that
 * owns it — never an edit to a shared file. Imported for its side effect by
 * `billing.module.ts`.
 *
 * These codes are deliberately NOT in `error-catalogue.ts`: they are produced
 * by PostgreSQL constraints, and this registration is their enumeration.
 */
registerConstraintMeanings({
  // ── The tariff (BI-041, BI-042) ─────────────────────────────────────────
  //
  // ⚠️ THE GUARANTEE OF THE WHOLE MODULE, and it is not in TypeScript.
  // `price_temporal_unique` is `UNIQUE (price_list_id, billable_service_id,
  // valid_period WITHOUT OVERLAPS)`. Two administrators editing the tariff at
  // the same moment do not see each other, so a check between the SELECT and
  // the INSERT leaves exactly that window — and the duplicate price does not
  // fail when it is saved: it fails months later, when resolving the price of
  // a date returns two rows and the charge freezes whichever PostgreSQL
  // handed over first.
  price_temporal_unique: {
    code: 'PRICE_PERIOD_OVERLAP',
    field: 'validFrom',
    message: 'Esa prestación ya tiene un precio vigente en esas fechas: cierre la vigencia anterior antes de abrir otra', // prettier-ignore
  },
  price_period_not_empty: {
    code: 'PRICE_PERIOD_EMPTY',
    field: 'validTo',
    message: 'La fecha de fin de la vigencia tiene que ser posterior a la de inicio', // prettier-ignore
  },
  price_is_not_negative: {
    code: 'PRICE_AMOUNT_NEGATIVE',
    field: 'amount',
    message: 'El precio no puede ser negativo. Cero sí es un precio válido',
  },
  tax_rate_code_temporal_unique: {
    code: 'TAX_RATE_PERIOD_OVERLAP',
    field: 'validFrom',
    message: 'Ese código del SRI ya tiene un porcentaje vigente en esas fechas',
  },

  // ── The catalogue (BI-010, BI-030) ──────────────────────────────────────
  billable_service_code_unique: {
    code: 'BILLABLE_SERVICE_CODE_DUPLICATE',
    field: 'code',
    message: 'Ya existe una prestación con ese código',
  },
  // BI-036: the shape of a payer's RUC, the same as the site's. `Ruc` refuses
  // more than this long before the database is reached; this is what a path
  // that skips it (an import, a script) is told.
  payer_ruc_format: {
    code: 'INVALID_RUC',
    field: 'ruc',
    message:
      'El RUC son trece dígitos y termina en un código de establecimiento como 001',
  },
  // ── Qué prestación es «la consulta» (BI-158) ────────────────────────────
  //
  // The pair travels together or not at all: half a mapping resolves nothing,
  // and a specialty with no sequence would make «which of the two
  // consultations is this» ambiguous.
  billable_service_consultation_states_both: {
    code: 'CONSULTATION_MAPPING_INCOMPLETE',
    field: 'consultation',
    message: 'Indique la especialidad y si es primera vez o subsecuente: las dos o ninguna', // prettier-ignore
  },
  billable_service_visit_sequence_is_known: {
    code: 'INVALID_VISIT_SEQUENCE',
    field: 'consultation.visitSequence',
    message: 'Valores admitidos: FIRST_TIME, SUBSEQUENT',
  },
  // «Se coge la primera» es como una clínica cobra la consulta vieja durante
  // meses sin que nada falle, así que la base admite una sola.
  billable_service_one_per_consultation: {
    code: 'CONSULTATION_ALREADY_MAPPED',
    field: 'consultation',
    message: 'Esa especialidad ya tiene una prestación para ese tipo de consulta: quítesela antes de asignarla aquí', // prettier-ignore
  },
  payer_code_unique: {
    code: 'PAYER_CODE_DUPLICATE',
    field: 'code',
    message: 'Ya existe un pagador con ese código',
  },
  payer_kind_is_known: {
    code: 'INVALID_PAYER_KIND',
    field: 'kind',
    message: 'Valores admitidos: SELF_PAY, PUBLIC_NETWORK, PRIVATE_INSURANCE, COMPANY_AGREEMENT', // prettier-ignore
  },

  // ── The charge (BI-055 to BI-058, BI-061, BI-065) ───────────────────────
  //
  // The three CHECKs of `charge_item` that a hand-written INSERT can still
  // hit. Nothing in this delivery reaches them — the service refuses first, or
  // never writes a discount at all — and that is exactly why they are here: an
  // import or a `psql` writes underneath the application, and when one of them
  // fires the message should say what happened instead of naming a constraint.
  // ── De qué acto viene la línea (BI-153, BI-154) ─────────────────────────
  //
  // ⚠️ LOS TRES ÍNDICES ÚNICOS PARCIALES SON LA IDEMPOTENCIA DE «ENVIAR A
  // CAJA», y no una comprobación previa: dos cajeras pulsando en el mismo
  // segundo leen las dos «todavía no hay nada» e insertan las dos. El
  // repositorio traduce su rechazo a `ACT_ALREADY_CHARGED` antes de que llegue
  // aquí; esto es lo que dice una escritura hecha por debajo de la aplicación.
  charge_item_one_per_encounter_procedure: {
    code: 'ACT_ALREADY_CHARGED',
    field: 'encounterProcedureId',
    message: 'Ese procedimiento de la atención ya tiene un cargo',
  },
  charge_item_one_per_service_order_item: {
    code: 'ACT_ALREADY_CHARGED',
    field: 'serviceOrderItemId',
    message: 'Ese examen de la orden ya tiene un cargo',
  },
  charge_item_one_consultation_per_encounter: {
    code: 'ACT_ALREADY_CHARGED',
    field: 'encounterId',
    message: 'La consulta de esa atención ya tiene un cargo',
  },
  charge_item_origin_is_known: {
    code: 'INVALID_CHARGE_ORIGIN',
    field: 'origin',
    message: 'Valores admitidos: MANUAL, CONSULTATION, PROCEDURE, EXAM',
  },
  charge_item_origin_names_its_act: {
    code: 'CHARGE_ORIGIN_INCOHERENT',
    field: 'origin',
    message: 'Un cargo derivado tiene que señalar el acto del que nació, y uno tecleado no puede señalar ninguno', // prettier-ignore
  },
  charge_item_void_states_who_when_and_why: {
    code: 'VOID_REASON_REQUIRED',
    field: 'reason',
    message: 'Una anulación sin autor, instante y motivo no es una anulación: indique por qué no se cobra', // prettier-ignore
  },
  charge_item_void_matches_status: {
    code: 'CHARGE_VOID_INCOHERENT',
    field: 'status',
    message: 'Un cargo anulado tiene que decir cuándo se anuló, y uno vivo no puede decirlo', // prettier-ignore
  },
  charge_item_billed_is_not_voided: {
    code: 'CHARGE_ITEM_ALREADY_INVOICED',
    field: 'status',
    message: 'Un cargo ya facturado no se anula: para corregirlo se emite una nota de crédito', // prettier-ignore
  },
  charge_item_quantity_is_positive: {
    code: 'INVALID_CHARGE_QUANTITY',
    field: 'quantity',
    message: 'La cantidad del cargo tiene que ser mayor que cero',
  },
  charge_item_discount_states_a_reason: {
    code: 'DISCOUNT_REASON_REQUIRED',
    field: 'discountReason',
    message: 'Un descuento sin motivo es un descuento que nadie puede explicar: indique por qué se concede', // prettier-ignore
  },
  charge_item_discount_within_line: {
    code: 'DISCOUNT_EXCEEDS_LINE_AMOUNT',
    field: 'discountAmount',
    message: 'El descuento no puede superar el importe de la línea',
  },

  // ── The account (BI-070, BI-071) ────────────────────────────────────────
  patient_account_status_is_known: {
    code: 'INVALID_ACCOUNT_STATUS',
    field: 'status',
    message: 'Valores admitidos: OPEN, SETTLED, CANCELLED',
  },
  patient_account_closed_states_its_instant: {
    code: 'ACCOUNT_CLOSURE_INCOHERENT',
    field: 'closedAt',
    message: 'Una cuenta cerrada tiene que decir cuándo se cerró, y una abierta no puede decirlo', // prettier-ignore
  },
  patient_account_one_open_per_encounter: {
    code: 'ACCOUNT_ALREADY_OPEN_FOR_ENCOUNTER',
    field: 'encounterId',
    message:
      'Esa atención ya tiene una cuenta abierta: use esa en lugar de abrir otra',
  },

  // ── The invoice (BI-084, BI-085) ────────────────────────────────────────
  invoice_sequential_unique: {
    code: 'INVOICE_SEQUENTIAL_TAKEN',
    field: 'sequential',
    message:
      'Ese secuencial ya se usó en el punto de emisión: vuelva a intentarlo',
  },
  // ⚠️ THE CHECK THAT STOPS A ROUNDING BUG FROM BECOMING A TAX DEFECT.
  // `total = subtotal_taxed + subtotal_untaxed + tax_total - discount_total`.
  // If this ever fires, the arithmetic in `totalsOf` and the columns disagree,
  // and the correct outcome is that NO invoice exists rather than one the SRI
  // will reject and which could never be corrected (D-A-007).
  invoice_total_is_consistent: {
    code: 'INVOICE_TOTAL_INCONSISTENT',
    field: 'total',
    message: 'Los importes de la factura no cuadran: no se emitió nada',
  },
  invoice_final_consumer_identification: {
    code: 'FINAL_CONSUMER_IDENTIFICATION_REQUIRED',
    field: 'receiver.identification',
    message: 'Una factura a Consumidor Final lleva la identificación 9999999999999 del SRI', // prettier-ignore
  },
  // BI-159: the receiver's RUC and cedula, the whole rule of `Ruc` and
  // `Cedula`. `resolveReceiver` refuses the same before the database is
  // reached; this is what a path that skips it (an import, a script) is told.
  invoice_buyer_ruc_valid: {
    code: 'INVALID_RUC',
    field: 'receiver.identification',
    message:
      'El RUC no supera la validación del SRI. Compruebe los trece dígitos y el código de establecimiento',
  },
  invoice_buyer_cedula_valid: {
    code: 'INVALID_CEDULA',
    field: 'receiver.identification',
    message: 'La cédula no es válida: revise los diez dígitos',
  },
  invoice_status_is_known: {
    code: 'INVALID_INVOICE_STATUS',
    field: 'status',
    message: 'Valores admitidos: DRAFT, ISSUED, AUTHORISED, REJECTED, VOIDED',
  },
  invoice_authorised_carries_its_key: {
    code: 'INVOICE_AUTHORISATION_INCOMPLETE',
    field: 'accessKey',
    message: 'Una factura autorizada lleva su clave de acceso y el instante de la autorización', // prettier-ignore
  },
});

/**
 * ⚠️ `trg_invoice_immutable` AND `trg_invoice_no_delete` ARE NOT HERE, AND IT
 * IS NOT AN OVERSIGHT.
 *
 * Both raise from PL/pgSQL with a bare `RAISE EXCEPTION`, so PostgreSQL emits
 * no «violates check constraint "…"» clause and the constraint NAME never
 * travels: they arrive as SQLSTATE `P0001` only, which this registry cannot
 * read. They are told apart by the SENTENCE each raises, in
 * `prisma-billing-account.repository.ts` — exactly as `agenda` resolved the
 * three waiting-list refusals and `patients` those of
 * `trg_patient_merge_not_chained`.
 *
 * THE RULE IS THE TRIGGER, not the translation: it still refuses an import and
 * a `psql`. What the translation decides is only what the rejection MEANS to
 * whoever is at the desk — and here that sentence has to name the way out,
 * because there is no «editar factura» button to look for and there never will
 * be (BI-090).
 */
