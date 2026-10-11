import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of the exam catalogue means to the person who hit it
 * (ORD-104, ORD-129, ORD-140). Imported for its side effect by
 * `orders.module.ts`.
 *
 * ADR-013. The exam is a service: its code's uniqueness is billing's
 * (`service_code_unique`), but that it does not change once an order line
 * froze it is this module's rule (ORD-140), raised by
 * `trg_service_code_fixed_once_ordered` on whichever write tries.
 */
registerConstraintMeanings({
  // ORD-140, BI-281. The code of a service an order line already froze.
  service_code_in_use: {
    code: 'EXAM_CODE_IN_USE',
    field: 'code',
    message: 'Hay órdenes que ya citan este código',
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
  service_exam_fasting_hours_needs_fasting: {
    code: 'EXAM_FASTING_HOURS_INVALID',
    field: 'fastingHours',
    message:
      'Marque «Pide ayuno» para indicar las horas, o deje las horas vacías',
  },
  service_exam_fasting_hours_range: {
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
  // ORD-170 (D-168 §1). Raised by `trg_observation_result_one_standing_per_analyte`
  // only when a write passes the service's own check (two at once, a psql).
  observation_result_one_standing_per_analyte: {
    code: 'RESULT_ALREADY_REPORTED',
    field: 'results',
    message:
      'Esa determinación ya tiene un valor en un informe vigente de esta orden. Use la corrección del informe vigente',
  },
  analyte_definition_code_unique: {
    code: 'ANALYTE_CODE_DUPLICATE',
    field: 'code',
    message: 'Ya hay una determinación con ese código',
  },
});
