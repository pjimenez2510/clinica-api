import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of the exam catalogue means to the person who hit it
 * (ORD-103, ORD-104). Imported for its side effect by `orders.module.ts`.
 *
 * The code is the one an order freezes on every line (ORD-002): two exams with
 * one code would make a paper report quote something ambiguous, and the
 * `UNIQUE` is what arbitrates two administrators typing at once — no read
 * first could.
 */
registerConstraintMeanings({
  exam_definition_code_unique: {
    code: 'EXAM_CODE_DUPLICATE',
    field: 'code',
    message: 'Ya hay un examen con ese código',
  },
  // ORD-104. A result is tied to its analyte by the name it froze (ORD-031),
  // so two active analytes with one name would be confused.
  analyte_definition_active_name_unique: {
    code: 'ANALYTE_NAME_DUPLICATE',
    field: 'name',
    message: 'Ya hay una determinación activa con ese nombre',
  },
  // ORD-129 (D-137). Hours of fast only on an exam that asks for one; the
  // range is also checked by the DTO, this answers whatever bypasses it.
  exam_definition_fasting_hours_needs_fasting: {
    code: 'EXAM_FASTING_HOURS_INVALID',
    field: 'fastingHours',
    message:
      'Marque «Pide ayuno» para indicar las horas, o deje las horas vacías',
  },
  exam_definition_fasting_hours_range: {
    code: 'EXAM_FASTING_HOURS_INVALID',
    field: 'fastingHours',
    message: 'El ayuno es de 1 a 24 horas',
  },
  // ORD-008, ORD-131. Raised by `trg_service_order_item_completed_is_not_cancelled`
  // only when a write passes the application's own check (a race, a psql):
  // the same code and sentence the application gives.
  service_order_item_completed_is_not_cancelled: {
    code: 'ORDER_ITEM_NOT_PENDING',
    field: 'status',
    message:
      'Esa línea de la orden ya no está pendiente: su resultado llegó o ya se anuló',
  },
  service_order_item_with_result_is_not_cancelled: {
    code: 'ORDER_ITEM_HAS_RESULTS',
    field: 'status',
    message:
      'Este examen ya tiene resultados y no se anula. Edite el informe o pídalo de nuevo',
  },
  analyte_definition_code_unique: {
    code: 'ANALYTE_CODE_DUPLICATE',
    field: 'code',
    message: 'Ya hay una determinación con ese código',
  },
});
