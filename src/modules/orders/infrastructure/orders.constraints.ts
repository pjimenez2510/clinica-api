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
  analyte_definition_code_unique: {
    code: 'ANALYTE_CODE_DUPLICATE',
    field: 'code',
    message: 'Ya hay una determinación con ese código',
  },
});
