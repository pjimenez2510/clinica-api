import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong ordering an exam and receiving its result, in business
 * terms.
 *
 * No HTTP here: the CATEGORY decides the status in `problem-details.filter.ts`,
 * which is what lets these same rules run from an import script the day a
 * laboratory finally publishes an API.
 *
 * ⚠️ NOT ONE OF THESE MESSAGES NAMES THE PATIENT OR THE VALUE (ORD-024). No
 * name, no document, no analyte reading, no diagnosis. These sentences reach
 * logs and support screenshots, and here the datum that would leak is a
 * laboratory result — which is what an employer or an insurer would want.
 *
 * NOT DECLARED HERE, on purpose: `CATALOG_CONCEPT_NOT_FOUND` and
 * `CATALOG_CONCEPT_NOT_IN_FORCE`. Both live in `shared/domain/errors` PRECISELY
 * so that more than one module can answer them with the same `code`, and the
 * `code` is a public contract: which module emitted it must not change the
 * string a client branches on.
 */

/**
 * ORD-009. The order does not exist — or belongs to a site outside the
 * caller's scope.
 *
 * ONE ANSWER FOR BOTH, and it is the requirement rather than a convenience:
 * telling them apart would confirm orders of other sites to whoever guesses
 * identifiers, one at a time. `ENCOUNTER_NOT_FOUND` and
 * `AGENDA_ENTRY_NOT_FOUND` take the same line for the same reason.
 */
export class OrderNotFoundError extends NotFoundError {
  readonly code = 'ORDER_NOT_FOUND';
  override readonly userTitle =
    'Esa orden no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Service order not found within the caller site scope');
  }
}

/**
 * ORD-001, ORD-090. The attention the order would hang off does not exist — or
 * belongs to a site outside the caller's scope.
 *
 * ⚠️ IT IS NOT `ENCOUNTER_NOT_FOUND`, AND THE DIFFERENCE IS THE MODULE
 * BOUNDARY. That code belongs to `encounter`, whose error classes this module
 * must not import (`sin-imports-entre-modulos`), and a second class declaring
 * the same string fails `error-catalogue.spec.ts` on the spot. The SENTENCE is
 * deliberately the same one, because what the person in front of the patient
 * has to do is the same.
 */
export class OrderEncounterNotFoundError extends NotFoundError {
  readonly code = 'ORDER_ENCOUNTER_NOT_FOUND';
  override readonly userTitle =
    'Esa atención no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Encounter not found within the caller site scope');
  }
}

/** ORD-051. The report does not exist, or is out of scope. Same silence. */
export class ReportNotFoundError extends NotFoundError {
  readonly code = 'REPORT_NOT_FOUND';
  override readonly userTitle =
    'Ese informe no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Diagnostic report not found within the caller site scope');
  }
}

/**
 * ORD-003. The orderable does not exist, or the clinic disabled it.
 *
 * ⚠️ IT REFUSES THE WHOLE ORDER AND NOT THE LINE, which is the requirement. A
 * request for five exams that quietly stores four is a request in which nobody
 * notices which one is missing — and the one missing is the one nobody chases.
 *
 * ONE CODE FOR «no existe» AND «está deshabilitado»: what the caller does next
 * is identical — pick from the list — and the second answer would turn the
 * endpoint into an oracle of the catalogue, walked by trying identifiers.
 *
 * A retired code is DISABLED, never deleted (IHE LCSD): there are historical
 * orders referencing it. So «deshabilitado» is a permanent, ordinary state of
 * this catalogue and not an anomaly.
 */
export class ExamNotOrderableError extends ValidationError {
  readonly code = 'EXAM_NOT_ORDERABLE';
  override readonly userTitle =
    'Ese examen ya no se puede pedir. Elíjalo de la lista de exámenes disponibles';

  constructor() {
    super('Exam definition does not exist or is not active', {}, [
      {
        field: 'items',
        code: 'EXAM_NOT_ORDERABLE',
        message: 'Elija un examen de la lista vigente',
      },
    ]);
  }
}

/**
 * ORD-005. The attention no longer admits new clinical content.
 *
 * 409 AND NOT 422: nothing sent is wrong. The attention was closed, interrupted
 * or annulled, and what the caller does next is open another one — which the
 * message says.
 *
 * ⚠️ IT IS NOT `ENCOUNTER_ALREADY_CLOSED`, AND THE DIFFERENCE IS THE MODULE
 * BOUNDARY, not a nuance. That code belongs to `encounter`, whose error classes
 * this module MUST NOT import (`sin-imports-entre-modulos`), and a second class
 * declaring the same string would fail `error-catalogue.spec.ts` on the spot —
 * two errors answering one code is two situations a client cannot tell apart.
 */
export class OrderEncounterNotOpenError extends ConflictError {
  readonly code = 'ORDER_ENCOUNTER_NOT_OPEN';
  override readonly userTitle =
    'Esa atención ya no admite registrar exámenes. Abra una atención nueva para pedirlos';

  constructor(status: string) {
    super(`Encounter in status ${status} does not admit new orders`, {
      status,
    });
  }
}

/**
 * ORD-008. The line is already completed or already cancelled.
 *
 * 409: the request is well formed and the state refuses it. Cancelling a line
 * whose result already arrived would take a real observation out of the
 * worklist while leaving the observation itself in the chart.
 */
export class OrderItemNotPendingError extends ConflictError {
  readonly code = 'ORDER_ITEM_NOT_PENDING';
  override readonly userTitle =
    'Esa línea de la orden ya no está pendiente: su resultado llegó o ya se anuló';

  constructor() {
    super('The order item is neither REQUESTED nor IN_PROGRESS');
  }
}

/**
 * ORD-052. The report already has a correction.
 *
 * GUARANTEED BY THE `UNIQUE` ON `diagnostic_report.supersedes_id`; this class
 * is what turns that collision into a sentence. A chain that forks has no
 * «current version», and two clinicians would each be looking at a different
 * final result of the same specimen.
 */
export class ReportAlreadyCorrectedError extends ConflictError {
  readonly code = 'REPORT_ALREADY_CORRECTED';
  override readonly userTitle =
    'Ese informe ya fue corregido. Corrija la última versión, no ésta';

  constructor() {
    super('The diagnostic report has already been superseded');
  }
}

/**
 * ORD-053. A partial or an annulled report is not corrected.
 *
 * A partial report is not corrected, it is COMPLETED — the determinations that
 * were missing simply arrive. And an annulled one asserts nothing, so there is
 * nothing to correct. The message names the way out of each.
 */
export class ReportNotCorrectableError extends ConflictError {
  readonly code = 'REPORT_NOT_CORRECTABLE';
  override readonly userTitle =
    'Sólo se corrige un informe definitivo. Si el informe está parcial, complételo; si está anulado, registre uno nuevo';

  constructor(status: string) {
    super(`A ${status} report cannot be corrected`, { status });
  }
}

/**
 * ORD-042. The analyte is not in the catalogue.
 *
 * ⚠️ THE WHOLE REPORT IS REFUSED, like ORD-003 refuses the whole order. A
 * hand-written analyte is a value no chart will ever plot and no rule will ever
 * compare, so accepting the other nineteen and dropping this one produces a
 * report that LOOKS complete and is not.
 *
 * The escape valve of form 010 — the few blank cells — is deliberately narrow
 * and visible: somebody always writing the same thing in the blank cell is the
 * signal that a row is missing from the catalogue, and that signal only exists
 * if the blank cell is not the default.
 */
export class ResultAnalyteUnknownError extends ValidationError {
  readonly code = 'RESULT_ANALYTE_UNKNOWN';
  override readonly userTitle =
    'Esa determinación no está en el catálogo. Pida que se añada antes de registrar el resultado';

  constructor() {
    super('Analyte definition does not exist', {}, [
      {
        field: 'results',
        code: 'RESULT_ANALYTE_UNKNOWN',
        message: 'Elija una determinación del catálogo',
      },
    ]);
  }
}

/**
 * ORD-032. The value sent does not match the type the analyte declares.
 *
 * `observation_result_one_value` already guarantees that EXACTLY ONE of the
 * three columns is populated. What it cannot know is WHICH one should be, and
 * that is what this refuses: a haemoglobin typed into `value_text` is a number
 * no graph can plot and no threshold can compare — it is a string that looks
 * like a result.
 */
export class ResultValueTypeMismatchError extends ValidationError {
  readonly code = 'RESULT_VALUE_TYPE_MISMATCH';
  override readonly userTitle: string;
  override readonly fieldErrors: readonly {
    field: string;
    code: string;
    message: string;
  }[];

  constructor(analyteCode: string, expected: string) {
    super(`Analyte ${analyteCode} expects a ${expected} value`, {
      analyteCode,
      expected,
    });
    this.userTitle = TYPE_ADVICE[expected] ?? 'El valor no corresponde al tipo de esa determinación'; // prettier-ignore
    this.fieldErrors = [
      {
        field: 'results',
        code: 'RESULT_VALUE_TYPE_MISMATCH',
        message: this.userTitle,
      },
    ];
  }
}

/** What to do, per declared type. The user is transcribing a printed report. */
const TYPE_ADVICE: Readonly<Record<string, string>> = {
  NUMERIC: 'Esa determinación se registra como número. Escriba el valor numérico que trae el informe',
  CODED: 'Esa determinación se registra eligiendo una de las opciones, no escribiendo un número',
  ORDINAL: 'Esa determinación se registra eligiendo una de las opciones, no escribiendo un número',
  TEXT: 'Esa determinación se registra como texto. Copie la frase que trae el informe',
}; // prettier-ignore

/**
 * ORD-033. The coded value is not one of the answers the analyte admits.
 *
 * ⚠️ THE ADMITTED VALUES TRAVEL IN THE MESSAGE, and that is safe here: they are
 * catalogue metadata — `Negativo`, `Trazas`, `+`, `++` — and say nothing about
 * the patient. What must never travel is the value that was REJECTED, which is
 * the reading itself.
 *
 * Without this, every transcriber writes `POS`, `+`, `Positivo` and `positivo`,
 * and the clinical rule that compares them finds none of the four.
 */
export class ResultValueNotAllowedError extends ValidationError {
  readonly code = 'RESULT_VALUE_NOT_ALLOWED';
  override readonly userTitle: string;
  override readonly fieldErrors: readonly {
    field: string;
    code: string;
    message: string;
  }[];

  constructor(analyteCode: string, allowed: readonly string[]) {
    super(`Analyte ${analyteCode} does not admit that coded value`, {
      analyteCode,
    });
    this.userTitle = `Ese valor no es una de las opciones de la determinación. Las admitidas son: ${allowed.join(', ')}`;
    this.fieldErrors = [
      {
        field: 'results',
        code: 'RESULT_VALUE_NOT_ALLOWED',
        message: this.userTitle,
      },
    ];
  }
}

/**
 * ORD-035. The abnormal flag was sent in the request.
 *
 * ⚠️ IT IS REFUSED AND NOT IGNORED, exactly like `BMI_IS_DERIVED`. Dropping it
 * in silence would leave whoever typed it believing that THEIR mark is the one
 * on the record — and here the mark is what decides whether somebody phones the
 * patient tonight.
 *
 * The flag is computed from the clinic's OWN thresholds (`abnormal-flag.ts`)
 * because many laboratories send only «alto/bajo» and some send nothing: the
 * safety net of A.M. 00002393 art. 39 cannot depend on the sender.
 */
export class ResultFlagIsDerivedError extends ValidationError {
  readonly code = 'RESULT_FLAG_IS_DERIVED';
  override readonly userTitle =
    'La marca de valor anormal la calcula el sistema con los rangos del catálogo. Registre sólo el valor';
  override readonly fieldErrors = [
    {
      field: 'results.abnormalFlag',
      code: 'RESULT_FLAG_IS_DERIVED',
      message: 'No registre la marca: se calcula con el rango del catálogo',
    },
  ];

  constructor() {
    super('The abnormal flag is derived and must not be supplied');
  }
}

/**
 * ORD-080, ORD-081. No live chart carries that cedula.
 *
 * ⚠️ AND NOTHING IS CREATED. Creating a chart from an incoming result is the
 * main cause of duplicate records in the systems that do it the other way
 * round, and `patients` has a whole subsystem — `patient_merge`, PA-043 to
 * PA-060 — built to repair that damage. The way out is to register the patient
 * in the register, on purpose, and the message says so.
 *
 * 404 and not 422: the request is perfectly well formed and there is simply
 * nothing there.
 */
export class ResultChartUnmatchedError extends NotFoundError {
  readonly code = 'RESULT_CHART_UNMATCHED';
  override readonly userTitle =
    'Ninguna historia clínica lleva esa cédula. Regístrela en el fichero antes de conciliar el informe';

  constructor() {
    super('No live patient chart holds that cedula');
  }
}

/**
 * ORD-043. The result does not exist — or belongs to a site outside the
 * caller's scope.
 *
 * ONE ANSWER FOR BOTH, the line `ORDER_NOT_FOUND` and `REPORT_NOT_FOUND`
 * already take: telling them apart would confirm other sites' results to
 * whoever walks the identifiers, and `observation_result.id` is a `bigint`
 * autoincrement, which is the easiest identifier in this system to walk.
 */
export class ResultNotFoundError extends NotFoundError {
  readonly code = 'RESULT_NOT_FOUND';
  override readonly userTitle =
    'Ese resultado no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Observation result not found within the caller site scope');
  }
}

/**
 * ORD-043. The result already answers an ordered line.
 *
 * 409: the request is well formed and the state refuses it. Two people working
 * the same queue is the ordinary case — one of them wins, and the loser has to
 * be told that rather than silently re-pointing a row somebody already
 * resolved.
 *
 * ⚠️ AND THERE IS NO WAY BACK FROM HERE (⚠️ **Falta esquema**, ORD-043).
 * Undoing a wrong pairing would need to record who undid it and why, exactly
 * as the discard of a prescription does, and `observation_result` has no
 * columns for that. Until it does, the honest answer is to refuse the second
 * write rather than to let the row be re-pointed with no trace.
 */
export class ResultAlreadyMatchedError extends ConflictError {
  readonly code = 'RESULT_ALREADY_MATCHED';
  override readonly userTitle =
    'Ese resultado ya está emparejado con una línea de la orden. Actualice la lista';

  constructor() {
    super('The observation result already answers an ordered line');
  }
}

/**
 * ORD-043. The line named is not a line of THIS result's order, or is
 * cancelled.
 *
 * ONE CODE FOR THE TWO, and the reason is what the caller does next: pick
 * another line from the order this result came in on. That is the same
 * sentence in both cases.
 *
 * ⚠️ AND THE FIRST HALF IS NOT PEDANTRY. An observation whose report belongs to
 * order A, pointed at a line of order B, would make `pending_items` and the
 * completeness rule count a value the order never received — a line closing on
 * somebody else's blood. Nothing in the schema forbids it (⚠️ **Falta
 * esquema**, ORD-043): there is no `CHECK` tying `order_item_id` to the
 * report's order, so this refusal, inside the write's own transaction, is the
 * whole of the guarantee.
 *
 * 422 and not 404: the line may well exist. What is wrong is the pairing.
 */
export class OrderItemNotMatchableError extends ValidationError {
  readonly code = 'ORDER_ITEM_NOT_MATCHABLE';
  override readonly userTitle =
    'Esa línea no es de la orden en la que llegó este resultado, o está anulada. Elija una línea de esta orden';
  override readonly fieldErrors = [
    {
      field: 'orderItemId',
      code: 'ORDER_ITEM_NOT_MATCHABLE',
      message: 'Elija una línea pendiente de esta misma orden',
    },
  ];

  constructor() {
    super('The order item does not belong to this result order, or is cancelled'); // prettier-ignore
  }
}
