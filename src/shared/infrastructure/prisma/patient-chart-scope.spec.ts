/**
 * PA-055, D-038 (opción C). THE GUARANTEE, not the convention.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS THE POINT OF D-038 AND `patient-chart-scope.ts` IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-038 chose option C over option A, and the ONLY difference between them is
 * this file. A shared resolution that a new module can ignore IS option A with
 * extra steps — and option A is the decision that had already been taken and
 * had already failed, not through bad judgement but because «acuérdate
 * siempre» is not a guarantee. This project decided the same thing about
 * cedulas, time zones and permissions: what depends on remembering gets
 * forgotten.
 *
 * So this walks the REAL SOURCE — the same procedure `route-authorisation.spec`
 * uses on the routes NestJS actually registered, and `error-catalogue.spec` on
 * the codes the code actually throws — and fails the build when a patient's
 * history is read without coming through `patient-chart-scope.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT CATCHES — the three shapes the mistake takes, all three seen here
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. A HISTORY TABLE READ BY A BARE PATIENT ID.
 *     `prisma.patientAllergy.findMany({ where: { patientId } })` — the naive
 *     read, and the one that hides the penicillin allergy.
 *  2. A NESTED SELECT OF A HISTORY RELATION WITHOUT THE ABSORBED CHARTS.
 *     `select: { priorityGroups: … }` hanging off a patient row. This one is
 *     invisible to rule 1 because no patient id appears anywhere in it, and it
 *     is exactly how the calculated priority (PA-041) was wrong before PA-055.
 *  3. RAW SQL NAMING A HISTORY TABLE BY `patient_id`.
 *     The register search and the eight counters of PA-049 are raw, and the
 *     RDACAA report will be more of it. The ORM rules cannot see any of that.
 *  4. A COLUMN THAT POINTS AT A CHART UNDER ANOTHER NAME, FILTERED BY A BARE
 *     ID. `patient.mother_patient_id` is the one that exists today, and it is
 *     the one that got through: the three rules above look for `patient_id`,
 *     so a link column named anything else is invisible to all of them. See
 *     `CHART_LINKS` for what each of the four is and why.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND NEITHER LIST IS MAINTAINED BY HAND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both are read out of `schema.prisma`: every model with a `patient_id`
 * column, and the name Patient's relation to it carries; plus every OTHER
 * column in the schema whose foreign key points at `patient`. A NEW TABLE
 * HANGING OFF A CHART, OR A NEW COLUMN POINTING AT ONE, BREAKS THIS TEST
 * until somebody classifies it or writes down why it needs no scope. That is
 * the half `encounter` needs — it does not exist yet, and when it does its
 * author will be told rather than trusted.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  chartScope,
  chartScopeIds,
  chartScopeRows,
  chartScopeSelect,
} from './patient-chart-scope';

// From the project root, for the same reason as `error-catalogue.spec.ts` and
// `spec-traceability.spec.ts`: this file compiles to CommonJS output, where
// `import.meta` is unavailable.
const REPO_ROOT = process.cwd();
const SRC_DIR = join(REPO_ROOT, 'src');
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma');

/**
 * WHAT IS HISTORY: what happened to the PERSON. It keeps its `patient_id` on
 * the chart it was written on (D-031) and is read through the scope.
 *
 * Adding a row here is not paperwork. It is the answer to «si esta persona
 * tuvo dos fichas, ¿un médico tiene que ver esto de las dos?», and the answer
 * for everything in this list is yes.
 */
const HISTORY_TABLES: readonly string[] = [
  'patient_priority_group',
  'patient_allergy',
  // 20-08-2026, con EN-087. «Sin alergias conocidas» es una afirmación sobre la
  // PERSONA, no sobre el papel en el que se escribió, y las dos mitades de la
  // lectura la necesitan: la afirmación puede estar en la ficha absorbida, y —
  // lo peligroso — la alergia que la deja sin efecto también. Leer la segunda
  // por el `patient_id` desnudo mantiene viva una afirmación de «ninguna» sobre
  // una ficha cuya alergia a la penicilina vive en la absorbida.
  'patient_allergy_absence',
  // 30-09-2026, con EN-085. Un antecedente familiar de diabetes es de la
  // PERSONA: escrito en la ficha que luego se absorbió, tiene que verse desde
  // la superviviente igual que su alergia.
  'patient_history',
  'patient_contact',
  'agenda_entry',
  'waitlist_entry',
  'encounter',
  'medical_certificate',
  'referral',
  // 20-08-2026, con la migración de facturación. Una cuenta es la consecuencia
  // económica de una atención, y `encounter` ya está en esta lista: si la
  // atención sigue el enlace de la fusión y su cuenta no, la visita se ve y su
  // deuda no. Eso es exactamente la forma de PA-009 — algo que le ocurrió a la
  // persona dejando de ser alcanzable por el único camino que tenía.
  //
  // Y el daño aquí es de los que nadie reporta como defecto: una cuenta
  // impagada de la ficha absorbida simplemente deja de aparecer, así que no se
  // cobra y nadie sabe que existió.
  //
  // `charge_item`, `invoice` y `credit_note` NO están en ninguna de las dos
  // listas y es correcto: cuelgan de la cuenta, no de la ficha, así que el
  // analizador no las ve y llegar a ellas ya pasa por aquí.
  'patient_account',
  // 30-09-2026, con `privacy` (PD-016, PD-036, PD-040). El consentimiento que
  // dio la persona y las solicitudes que presentó sobre sus datos son de la
  // PERSONA: si firmó en la ficha que luego se absorbió, la superviviente
  // tiene que seguir mostrándolo, y una exportación que leyera solo la
  // superviviente entregaría la mitad (D-083 §3).
  'patient_consent',
  'data_subject_request',
];

/**
 * WHAT IS NOT, each with the reason written where it is declared.
 *
 * An entry here is a decision, never a shortcut: it says this table hangs off
 * a chart and STILL must not be read through the link, and why.
 */
const NOT_HISTORY: Record<string, string> = {
  patient_identifier:
    'PA-043: los documentos OFICIALES ya se consolidan en la superviviente ' +
    'dentro de la transacción de la fusión, y vuelven al deshacer. Un ' +
    'documento no es algo que le ocurrió a la persona: es cómo se la ' +
    'encuentra. Es la ÚNICA tabla hija cuyo patient_id cambia en una fusión, ' +
    'y resolverla otra vez por el enlace devolvería la misma fila dos veces.',
  patient_change_history:
    'D-032: rastro SOBRE la ficha —quién corrigió qué apellido y cuándo—, no ' +
    'atención recibida. Corregir la ficha absorbida no es historia clínica de ' +
    'la persona, y su régimen de rectificación es el de la ficha en la que se ' +
    'escribió.',
};

/**
 * EVERY OTHER COLUMN THAT POINTS AT A CHART, and what asking by it means.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS LIST EXISTS: IT IS THE ONE THAT WOULD HAVE CAUGHT PA-009
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET /patients?motherId=B` filtered `p.mother_patient_id = B` and returned
 * NOTHING for a newborn linked to `A` after `A` was merged into `B` — while
 * `GET /patients/A` answers 409, so the baby was unreachable by the only path
 * it had before holding a document of its own (PA-009). None of the three
 * rules above can see it: they all look for the literal `patient_id`, and this
 * column is not called that. `mother_patient_id` was even written down as NOT
 * history — correctly, it is a column of ANOTHER chart — and that classifica-
 * tion silently answered a question nobody had asked, because «is it history?»
 * and «does asking by it need the scope?» are two different questions.
 *
 * So the schema is walked a SECOND time for every foreign key that points at
 * `patient` and is not called `patient_id`, and each one is classified:
 *
 *  - `scope` — the column names a chart AS A PERSON. Asking by it has to
 *    resolve the chart and its absorbed ones, or the answer is half a person.
 *  - `exact` — the column names a chart AS A ROW. Resolving a scope would be
 *    WRONG, not merely unnecessary.
 *
 * A new column pointing at `patient` fails the classification test until its
 * author answers that question, exactly as a new `patient_id` table does.
 */
const CHART_LINKS: Record<
  string,
  { resolution: 'scope' | 'exact'; why: string }
> = {
  'patient.mother_patient_id': {
    resolution: 'scope',
    why:
      'PA-009. Nombra a la MADRE como PERSONA: el vínculo existe para ' +
      'encontrar al recién nacido antes de que tenga documento propio, y ' +
      'preguntar por la superviviente tiene que encontrar a los hijos ' +
      'enlazados a cualquiera de sus fichas. Sin alcance, fusionar a la ' +
      'madre borra al neonato del único camino que lo alcanzaba.',
  },
  'patient.merged_into_id': {
    resolution: 'exact',
    why:
      'ES EL ALCANCE. `chartScope`, `chartScopeSelect` y `chartScopeIds` se ' +
      'escriben leyendo esta columna; resolverla por el alcance sería la ' +
      'definición mordiéndose la cola. La fusión y el deshacer la ESCRIBEN, ' +
      'y una escritura nombra una fila concreta por definición.',
  },
  'patient_merge.source_patient_id': {
    resolution: 'exact',
    why:
      'PA-044. El rastro dice qué DOS FILAS se fusionaron, no qué le pasó a ' +
      'una persona. Resolverlo por el alcance haría que la fusión A→B ' +
      'apareciera también como fusión de las fichas que A absorbió —que ' +
      'PA-046 prohíbe— y que deshacer no supiera qué enlace limpiar.',
  },
  'patient_merge.target_patient_id': {
    resolution: 'exact',
    why: 'Por lo mismo que `source_patient_id`: es la otra mitad de la pareja de filas que una fila del rastro nombra.', // prettier-ignore
  },
};

/**
 * Where a naive read is allowed, and why. `<ruta relativa>#<declaración>`.
 *
 * The key is the enclosing declaration and not a line number on purpose: a
 * line number drifts with the first edit above it and the exemption silently
 * moves to whatever landed there.
 *
 * ⚠️ AN EXEMPTION THAT NO LONGER COVERS ANYTHING FAILS THE BUILD, and it has
 * to: `countLinkedRecords` renamed would leave this key alive, silently
 * covering whatever declaration lands on that name next. The test asserts each
 * key still produces a finding when the exemptions are switched off — the same
 * thing the stale-table check does for `HISTORY_TABLES` and `NOT_HISTORY`.
 */
const EXEMPT: Record<string, string> = {
  'src/modules/patients/infrastructure/prisma-patient.repository.ts#countLinkedRecords':
    'PA-049. Cuenta a propósito lo que SE QUEDÓ en la ficha ABSORBIDA, que es ' +
    'la única forma de enseñar desde fuera que «se lee por el enlace» (D-031) ' +
    'y que ninguna fila se movió. Resolverla por el alcance contaría las de ' +
    'la superviviente y la respuesta dejaría de significar nada.',
  'src/shared/infrastructure/prisma/waitlist-follows-merge.ts#reEnrolOpenWaitlistEntries':
    'PA-060, D-041 (B). Aquí las dos fichas se nombran COMO FILAS y no como ' +
    'persona: se leen las inscripciones abiertas de la ABSORBIDA para ' +
    'recrearlas en la superviviente, y se comprueba si la SUPERVIVIENTE ya ' +
    'tiene una equivalente. Resolver el alcance en la primera mitad traería ' +
    'también las de las fichas que la absorbida absorbió —que PA-046 prohíbe— ' +
    'y en la segunda traería las de la propia absorbida, con lo que la fusión ' +
    'nunca copiaría nada porque cada entrada sería «equivalente a sí misma». ' +
    'Es el mismo motivo que `countLinkedRecords`: la fusión escribe, y una ' +
    'escritura nombra filas concretas por definición.',
  'src/modules/agenda/infrastructure/prisma-agenda.repository.ts#applyStatusChange':
    'AG-045, EN-168. `encounters` se lee desde la CITA, no desde la ficha: ' +
    'son las atenciones colgadas de esa cita concreta, para saber si alguna ' +
    'sigue viva antes de anularla. El nombre coincide con la relación de ' +
    '`Patient` y por eso el escáner la marca; resolver el alcance de la ficha ' +
    'traería atenciones de OTRAS citas del mismo paciente y vetaría anular ' +
    'una cita por una atención que no es suya.',
  'src/modules/agenda/infrastructure/prisma-agenda.repository.ts#ENTRY_SELECT':
    'AG-150. Mismo caso que `applyStatusChange`: el estado de la atención ' +
    'viva de ESTA cita, que es lo que el menú necesita. Las atenciones de ' +
    'las fichas absorbidas no cuelgan de esta cita y no deben aparecer.',
};

// ---------------------------------------------------------------------------
// The schema, read as the source of truth about what hangs off a chart
// ---------------------------------------------------------------------------

interface ChartChild {
  /** `patient_priority_group` */
  table: string;
  /** `patientPriorityGroup` — the accessor on the Prisma client. */
  accessor: string;
  /** `priorityGroups` — how Patient names the relation, or `undefined`. */
  relation: string | undefined;
}

function readChartChildren(): ChartChild[] {
  const schema = readFileSync(SCHEMA, 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];

  const patient = models.find(([, name]) => name === 'Patient');
  if (!patient) throw new Error('no `model Patient` in schema.prisma');

  // `priorityGroups  PatientPriorityGroup[]` → PatientPriorityGroup →
  // priorityGroups. A list relation on Patient is how a nested select reaches
  // a child table without naming a patient id at all.
  const relationOf = new Map<string, string>();
  for (const line of (patient[2] ?? '').split('\n')) {
    const match = /^\s*(\w+)\s+(\w+)\[\]/.exec(line);
    if (match?.[1] && match[2]) relationOf.set(match[2], match[1]);
  }

  const children: ChartChild[] = [];
  for (const [, name, body = ''] of models) {
    if (!name || name === 'Patient') continue;
    if (!/@map\("patient_id"\)/.test(body)) continue;

    const mapped = /@@map\("(\w+)"\)/.exec(body)?.[1];
    children.push({
      table: mapped ?? name,
      accessor: name.charAt(0).toLowerCase() + name.slice(1),
      relation: relationOf.get(name),
    });
  }
  return children;
}

/** A foreign key that points at `patient` and is NOT called `patient_id`. */
export interface ChartLink {
  /** `patient.mother_patient_id` — the key of `CHART_LINKS`. */
  key: string;
  /** `motherPatientId` — the property a `where` would name. */
  field: string;
  /** `mother_patient_id` — what raw SQL names. */
  column: string;
  /** `patient` — the accessor of the model the column lives on. */
  accessor: string;
}

/**
 * Every such column in the schema, found the same way the tables are.
 *
 * A relation field carrying `fields: [x]` is the OWNING side, which is the
 * only side that has a column. The back-references (`children Patient[]`,
 * `mergedFrom Patient[]`) carry no `fields:` and are skipped by construction,
 * so a list relation cannot double-count the column its owner declares.
 */
function readChartLinks(): ChartLink[] {
  const schema = readFileSync(SCHEMA, 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];

  const links: ChartLink[] = [];
  for (const [, name, body = ''] of models) {
    if (!name) continue;
    const table = /@@map\("(\w+)"\)/.exec(body)?.[1] ?? name;

    const owning = body.matchAll(
      /^\s*\w+\s+Patient\??\s+@relation\([^)]*fields:\s*\[(\w+)\]/gm,
    );
    for (const [, field] of owning) {
      if (!field) continue;
      const declaration = new RegExp(`^\\s*${field}\\s+[^\\n]*$`, 'm').exec(
        body,
      );
      const column =
        /@map\("(\w+)"\)/.exec(declaration?.[0] ?? '')?.[1] ?? field;
      // `patient_id` is already the subject of the three rules above; adding
      // it here would report the same read twice with two different reasons.
      if (column === 'patient_id') continue;
      links.push({
        key: `${table}.${column}`,
        field,
        column,
        accessor: name.charAt(0).toLowerCase() + name.slice(1),
      });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// The analyser
// ---------------------------------------------------------------------------

const READ_METHODS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

/** The shared resolution, named as it appears in the source that uses it. */
const SCOPE_HELPERS = /\bchartScope\(|\bchartScopeIds\(|\bchartScopeSelect\(/;

export interface Finding {
  file: string;
  /** `<ruta>#<declaración>` — the exemption key, so a report is actionable. */
  key: string;
  rule: 'model-read' | 'nested-select' | 'raw-sql' | 'chart-link';
  detail: string;
}

/**
 * The declaration a node lives in, which is what an exemption names.
 *
 * THE METHOD WINS OVER THE LOCAL `const`, and that is not cosmetic: almost
 * every query in this codebase is written `const rows = await …`, so taking
 * the nearest declaration would key half the exemptions on `#rows` — a name
 * that says nothing and that two different methods would share.
 */
function enclosingName(node: ts.Node): string {
  let declared: string | undefined;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
      const name = current.name;
      if (name && ts.isIdentifier(name)) return name.text;
    }
    if (
      declared === undefined &&
      (ts.isVariableDeclaration(current) ||
        ts.isPropertyDeclaration(current)) &&
      ts.isIdentifier(current.name)
    ) {
      declared = current.name.text;
    }
  }
  return declared ?? '<top level>';
}

/** `true` when this object literal is being handed to Prisma as a selection. */
function inSelectionContext(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isPropertyAssignment(current) &&
      ts.isIdentifier(current.name) &&
      (current.name.text === 'select' || current.name.text === 'include')
    ) {
      return true;
    }
    if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      if (/Prisma\.\w*(Select|Include|Args)/.test(current.type.getText())) {
        return true;
      }
    }
  }
  return false;
}

/** The `where:` of a Prisma call, as a node — `undefined` when there is none. */
function whereOf(argument: ts.Node | undefined): ts.Node | undefined {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
  for (const property of argument.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'where'
    ) {
      return property.initializer;
    }
    // `where: chartScope(id)` also travels as `...chartScope(id)`, and a
    // spread carries no property name to match on.
    if (ts.isSpreadAssignment(property)) return property.expression;
  }
  return undefined;
}

/**
 * `true` when a subtree names a property whose value is a patient.
 *
 * OVER THE TREE AND NOT OVER THE TEXT, and it cost a false positive to learn
 * it: `noShowCounts` in `agenda` has a COMMENT saying «has no patient», inside
 * a `where` that never mentions one. Matching source text reported it, and an
 * exemption for a rule that was wrong would have been the worst outcome
 * available — a written justification for something that never needed one.
 */
function namesAPatient(node: ts.Node): boolean {
  return namesProperty(node, (name) => name === 'patientId' || name === 'patient'); // prettier-ignore
}

/** `true` when a subtree assigns a property whose name the predicate accepts. */
function namesProperty(
  node: ts.Node,
  accepts: (name: string) => boolean,
): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(current) ||
        ts.isShorthandPropertyAssignment(current)) &&
      ts.isIdentifier(current.name) &&
      accepts(current.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * `true` when this node already hangs UNDER a `mergedFrom` selection.
 *
 * UN SOLO NIVEL, NUNCA UN ÁRBOL. `trg_patient_merge_not_chained` refuses
 * A→B→C in both directions (PA-046), so an absorbed chart can never itself
 * have absorbed one — and the `allergies` inside `mergedFrom: { select: … }`
 * is the CORRECT shape, not a naive read. Without this the rule would demand a
 * `mergedFrom` inside the `mergedFrom`, for ever, for a shape the database
 * forbids.
 */
function insideAbsorbedSelection(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isPropertyAssignment(current) &&
      ts.isIdentifier(current.name) &&
      current.name.text === 'mergedFrom'
    ) {
      return true;
    }
  }
  return false;
}

/** `true` when a subtree calls the shared resolution. */
function usesChartScope(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (name.startsWith('chartScope')) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * Every read of a patient's history that does not come through the scope.
 *
 * Takes the sources rather than reading them itself, so the very same
 * analyser can be pointed at the real tree AND at a naive read written on
 * purpose — which is the only way to know the detector detects anything.
 */
export function findUnscopedHistoryReads(
  files: readonly { path: string; source: string }[],
  children: readonly ChartChild[],
  links: readonly ChartLink[] = [],
  exempt: Record<string, string> = EXEMPT,
): Finding[] {
  const history = children.filter((child) =>
    HISTORY_TABLES.includes(child.table),
  );
  // Only the links that name a chart AS A PERSON; the `exact` ones are the
  // scope itself and the merge trail, where a scope would be the defect.
  const scoped = links.filter(
    (link) => CHART_LINKS[link.key]?.resolution === 'scope',
  );
  const byAccessor = new Map(history.map((child) => [child.accessor, child]));
  const relations = new Set(
    history
      .map((child) => child.relation)
      .filter((name): name is string => name !== undefined),
  );

  const findings: Finding[] = [];

  for (const { path, source } of files) {
    const tree = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );

    const report = (
      node: ts.Node,
      rule: Finding['rule'],
      detail: string,
    ): void => {
      const key = `${path}#${enclosingName(node)}`;
      if (key in exempt) return;
      findings.push({ file: path, key, rule, detail });
    };

    const visit = (node: ts.Node): void => {
      // ── 1. `prisma.<historyModel>.<read>({ where: … })` ──────────────────
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        READ_METHODS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression)
      ) {
        const child = byAccessor.get(node.expression.expression.name.text);
        const where = whereOf(node.arguments[0]);
        // A read with no patient in its `where` is not a history read: it is
        // «this row by its id», and scoping it would be noise.
        if (
          child &&
          where !== undefined &&
          namesAPatient(where) &&
          !usesChartScope(where)
        ) {
          report(
            node,
            'model-read',
            `${child.table} se lee por un patient_id desnudo; usa chartScope(chartId)`,
          );
        }

        // ── 4a. the same read, filtered by a link column, through the ORM ──
        const accessor = node.expression.expression.name.text;
        for (const link of scoped) {
          if (link.accessor !== accessor) continue;
          if (where === undefined) continue;
          if (!namesProperty(where, (name) => name === link.field)) continue;
          if (usesChartScope(where)) continue;
          report(
            node,
            'chart-link',
            `${link.key} se filtra por un id desnudo; resuelve la ficha y sus absorbidas`,
          );
        }
      }

      // ── 2. `select: { <historyRelation>: … }` off a patient row ──────────
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        relations.has(node.name.text) &&
        ts.isObjectLiteralExpression(node.parent) &&
        inSelectionContext(node) &&
        !insideAbsorbedSelection(node)
      ) {
        /**
         * ⚠️ Y EL `mergedFrom` TIENE QUE TRAER **ESTA MISMA** RELACIÓN.
         *
         * Comprobar sólo que exista una hermana llamada `mergedFrom` deja
         * pasar la forma que el propio repositorio teme en voz alta —«EL
         * `select` SE EXTIENDE, NO SE SUSTITUYE», en `findById`—:
         *
         *     { allergies: { select: { substanceText: true } },
         *       mergedFrom: { select: { mrn: true } } }
         *
         * Hay `mergedFrom`, no hay alergias debajo, y la alergia a la
         * penicilina de la ficha absorbida vuelve a esconderse. Es el agujero
         * del tamaño exacto del defecto que motivó PA-055, dentro de la
         * garantía que hace que D-038 sea la opción C y no la A.
         *
         * Se busca el nombre de la relación EN CUALQUIER PARTE del subárbol de
         * `mergedFrom` y no a una profundidad fija: `chartScopeSelect` lo pone
         * bajo `select:`, y `findById` lo hereda por un `...spread` y añade
         * `orderBy`. Exigir una forma concreta obligaría a escribirla dos
         * veces.
         */
        const relation = node.name.text;
        const absorbed = node.parent.properties.find(
          (property) =>
            property.name !== undefined &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'mergedFrom',
        );
        const carriesAbsorbed =
          absorbed !== undefined &&
          namesProperty(absorbed, (name) => name === relation);
        if (!carriesAbsorbed) {
          report(
            node,
            'nested-select',
            absorbed === undefined
              ? `el select trae '${relation}' de la ficha y no de las que absorbió; usa chartScopeSelect()`
              : `el 'mergedFrom' de este select no trae '${relation}', así que las fichas absorbidas siguen sin ella; usa chartScopeSelect()`,
          );
        }
      }

      // ── 3. raw SQL naming a history table by `patient_id` ────────────────
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = node.tag.getText();
        if (/\$(queryRaw|executeRaw)$|Prisma\.sql$/.test(tag)) {
          const sql = node.template.getText();
          if (/patient_id/.test(sql) && !SCOPE_HELPERS.test(sql)) {
            for (const child of history) {
              if (
                new RegExp(`\\b(FROM|JOIN)\\s+${child.table}\\b`, 'i').test(sql)
              ) {
                report(
                  node,
                  'raw-sql',
                  `${child.table} se lee por patient_id en SQL crudo; usa \${chartScopeIds(chartId)}`,
                );
              }
            }
          }

          // ── 4b. the link column in raw SQL, which is where PA-009 broke ──
          if (!SCOPE_HELPERS.test(sql)) {
            for (const link of scoped) {
              if (new RegExp(`\\b${link.column}\\b`).test(sql)) {
                report(
                  node,
                  'chart-link',
                  `${link.key} se compara con un id desnudo en SQL crudo; usa \${chartScopeIds(chartId)}`,
                );
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(tree);
  }

  return findings;
}

function productionSources(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        found.push({
          path: relative(REPO_ROOT, full).replaceAll('\\', '/'),
          source: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(SRC_DIR);
  return found;
}

describe('PA-055 nadie lee la historia de un paciente sin pasar por el alcance', () => {
  const children = readChartChildren();
  const links = readChartLinks();

  it('PA-055 clasifica TODA tabla que cuelga de una ficha, o falla', () => {
    /**
     * The half that survives the module that does not exist yet.
     *
     * `encounter` will bring `encounter_diagnosis`, `prescription` and half a
     * dozen more. Any of them that carries a `patient_id` lands here on the
     * day it is written, and this fails until its author says whether a doctor
     * has to see it from both charts. Nobody is trusted to remember.
     */
    const unclassified = children
      .filter(
        (child) =>
          !HISTORY_TABLES.includes(child.table) &&
          !(child.table in NOT_HISTORY),
      )
      .map((child) => child.table);

    expect(
      unclassified,
      'Clasifícala en HISTORY_TABLES o en NOT_HISTORY con su motivo escrito',
    ).toEqual([]);

    // And the reverse: a classification naming a table that no longer exists
    // is a rule protecting nothing, exactly like a test citing a dead PA-###.
    const tables = new Set(children.map((child) => child.table));
    const stale = [...HISTORY_TABLES, ...Object.keys(NOT_HISTORY)].filter(
      (table) => !tables.has(table),
    );
    expect(stale, 'Esta tabla ya no cuelga de una ficha').toEqual([]);
  });

  it('PA-055 clasifica TODA columna que apunta a una ficha con otro nombre', () => {
    /**
     * LA MITAD QUE FALTABA, Y ES LA QUE HABRÍA CAZADO EL DEFECTO DE PA-009.
     *
     * `mother_patient_id` no la ve ninguna de las tres reglas anteriores —las
     * tres buscan el literal `patient_id`— y estaba escrita como «no es
     * historia», que es cierto y contesta otra pregunta. Aquí se contesta la
     * que importaba: preguntar por esta columna, ¿tiene que resolver la ficha
     * y sus absorbidas?
     */
    const unclassified = links
      .map((link) => link.key)
      .filter((key) => !(key in CHART_LINKS));

    expect(
      unclassified,
      'Clasifícala en CHART_LINKS como `scope` o `exact`, con su motivo escrito',
    ).toEqual([]);

    const present = new Set(links.map((link) => link.key));
    const stale = Object.keys(CHART_LINKS).filter((key) => !present.has(key));
    expect(stale, 'Esta columna ya no apunta a una ficha').toEqual([]);

    // Y la que existe hoy es la de PA-009, para que borrarla del esquema no
    // deje la regla 4 sin nada que vigilar y aun así en verde.
    expect(
      Object.entries(CHART_LINKS)
        .filter(([, link]) => link.resolution === 'scope')
        .map(([key]) => key),
    ).toEqual(['patient.mother_patient_id']);
  });

  it('PA-055 no deja ninguna lectura de historia fuera del alcance compartido', () => {
    const files = productionSources();
    // If the walk finds nothing, every assertion below passes vacuously, which
    // is worse than failing. Same guard as `route-authorisation.spec.ts`.
    expect(files.length).toBeGreaterThan(0);

    const findings = findUnscopedHistoryReads(files, children, links).map(
      (finding) => `${finding.key} — ${finding.detail}`,
    );

    expect(
      findings,
      'Lee por chartScope/chartScopeSelect/chartScopeIds, o razona la excepción en EXEMPT',
    ).toEqual([]);
  });

  it('PA-055 falla si una exención de EXEMPT ya no cubre nada', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * UNA EXENCIÓN CADUCADA CUBRE EN SILENCIO A QUIEN CAIGA EN SU NOMBRE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La clave es `<ruta>#<declaración>`. Si `countLinkedRecords` se renombra
     * o desaparece, la entrada sigue viva y el día que otro método se llame
     * igual en ese archivo queda exento sin que nadie lo haya decidido. Es
     * exactamente el caso que la comprobación de tablas obsoletas ya cierra
     * arriba, y no estaba cerrado para las exenciones.
     *
     * SE COMPRUEBA APAGÁNDOLAS, no mirando si la declaración existe: que el
     * método siga llamándose igual no significa que siga haciendo la lectura
     * ingenua que la exención justifica. Lo único que hace viva a una exención
     * es que sin ella habría hallazgo.
     */
    const files = productionSources();
    expect(files.length).toBeGreaterThan(0);

    const covered = new Set(
      findUnscopedHistoryReads(files, children, links, {}).map(
        (finding) => finding.key,
      ),
    );
    const dead = Object.keys(EXEMPT).filter((key) => !covered.has(key));

    expect(
      dead,
      'Esta exención ya no cubre ninguna lectura: bórrala de EXEMPT',
    ).toEqual([]);
  });

  it('PA-055 caza la lectura ingenua en sus CUATRO formas', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL MECANISMO, COMPROBADO ROMPIÉNDOLO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A detector nobody ever saw fire is a detector that might detect nothing,
     * and the test above passes just as green when the analyser is broken as
     * when the tree is clean. So the naive read is written here on purpose —
     * the four shapes, under the path of the module that will be written next
     * — and the assertion is that all four are reported.
     *
     * As SOURCES and not as files in the tree: a real file would have to fail
     * the test above by design, and deleting it later would take the proof
     * with it.
     */
    const naive = [
      {
        path: 'src/modules/encounter/infrastructure/prisma-encounter.repository.ts',
        source: `
          class Repo {
            listAllergies(patientId: string) {
              return this.prisma.patientAllergy.findMany({
                where: { patientId },
              });
            }
          }
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/encounter.select.ts',
        source: `
          const CHART_SELECT = {
            id: true,
            allergies: { select: { substanceText: true } },
          } satisfies Prisma.PatientSelect;
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/rdacaa.report.ts',
        source: `
          class Report {
            monthly(patientId: string) {
              return this.prisma.$queryRaw\`
                SELECT count(*) FROM encounter WHERE patient_id = \${patientId}::uuid
              \`;
            }
          }
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/newborns.repository.ts',
        source: `
          class Newborns {
            ofMother(motherId: string) {
              return this.prisma.$queryRaw\`
                SELECT id FROM patient WHERE mother_patient_id = \${motherId}::uuid
              \`;
            }
          }
        `,
      },
    ];

    const findings = findUnscopedHistoryReads(naive, children, links);

    expect(findings.map((finding) => finding.rule)).toEqual([
      'model-read',
      'nested-select',
      'raw-sql',
      'chart-link',
    ]);
    expect(findings[0]?.key).toContain('#listAllergies');
    expect(findings[1]?.key).toContain('#CHART_SELECT');
    expect(findings[2]?.key).toContain('#monthly');
    expect(findings[3]?.key).toContain('#ofMother');
  });

  it('PA-055 caza el `mergedFrom` que NO trae la relación que acompaña', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA FORMA QUE EL PROPIO REPOSITORIO TEME EN VOZ ALTA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `findById` lo escribe en mayúsculas: «EL `select` SE EXTIENDE, NO SE
     * SUSTITUYE… escribir aquí un `select` nuevo los tiraría sin que nada se
     * quejara». Y no se quejaba: la regla 2 sólo miraba si EXISTÍA una hermana
     * llamada `mergedFrom`, así que un `mergedFrom` que trae otra cosa —el
     * `mrn` de PA-054, por ejemplo— pasaba limpio con la alergia escondida.
     *
     * Es distinto de la forma sin `mergedFrom` de la prueba anterior, que ya
     * se cazaba: aquí la hermana está, y lo que falta es lo que trae debajo.
     */
    const camouflaged = [
      {
        path: 'src/modules/encounter/infrastructure/encounter.select.ts',
        source: `
          const CHART_SELECT = {
            id: true,
            allergies: { select: { substanceText: true } },
            mergedFrom: { select: { mrn: true } },
          } satisfies Prisma.PatientSelect;
        `,
      },
    ];

    const findings = findUnscopedHistoryReads(camouflaged, children, links);

    expect(findings.map((finding) => finding.rule)).toEqual(['nested-select']);
    expect(findings[0]?.detail).toContain("no trae 'allergies'");
  });

  it('PA-055 deja pasar la lectura que SÍ recorre el enlace', () => {
    /**
     * The other half of «rompiéndolo»: a detector that reports everything
     * would also be green on the tree only because nobody could satisfy it.
     * The three correct shapes are asserted to produce nothing.
     */
    const correct = [
      {
        path: 'src/modules/encounter/infrastructure/prisma-encounter.repository.ts',
        source: `
          class Repo {
            listAllergies(chartId: string) {
              return this.prisma.patientAllergy.findMany({
                where: chartScope(chartId),
              });
            }
          }
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/encounter.select.ts',
        source: `
          const CHART_SELECT = {
            id: true,
            ...chartScopeSelect('allergies', { select: { substanceText: true } }),
          } satisfies Prisma.PatientSelect;
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/rdacaa.report.ts',
        source: `
          class Report {
            monthly(chartId: string) {
              return this.prisma.$queryRaw\`
                SELECT count(*) FROM encounter
                 WHERE patient_id IN \${chartScopeIds(chartId)}
              \`;
            }
          }
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/newborns.repository.ts',
        source: `
          class Newborns {
            ofMother(chartId: string) {
              return this.prisma.$queryRaw\`
                SELECT id FROM patient
                 WHERE mother_patient_id IN \${chartScopeIds(chartId)}
              \`;
            }
          }
        `,
      },
      {
        path: 'src/modules/encounter/infrastructure/encounter.chart.ts',
        source: `
          const WITH_ABSORBED = {
            id: true,
            allergies: { select: { substanceText: true } },
            mergedFrom: { select: { allergies: { select: { substanceText: true } } } },
          } satisfies Prisma.PatientSelect;
        `,
      },
    ];

    expect(findUnscopedHistoryReads(correct, children, links)).toEqual([]);
  });

  it('PA-055 deja en paz la columna que nombra una FILA y no a una persona', () => {
    /**
     * La otra mitad de `CHART_LINKS`, y no es simetría: el rastro de PA-044
     * dice qué DOS FILAS se fusionaron. Resolverlo por el alcance haría que
     * una fusión A→B apareciera además como fusión de lo que A absorbió, y
     * deshacer no sabría qué enlace limpiar. Una regla que obligara a
     * envolverlo estaría equivocada, y una exención escrita para una regla
     * equivocada es el peor resultado disponible.
     */
    const trail = [
      {
        path: 'src/modules/patients/infrastructure/merge.trail.ts',
        source: `
          class Trail {
            of(sourcePatientId: string) {
              return this.prisma.$queryRaw\`
                SELECT id FROM patient_merge
                 WHERE source_patient_id = \${sourcePatientId}::uuid
              \`;
            }
          }
        `,
      },
    ];

    expect(findUnscopedHistoryReads(trail, children, links)).toEqual([]);
  });
});

describe('PA-055 las tres formas del mismo alcance', () => {
  /**
   * Las formas, no el resultado: que el `OR` case lo que la base guarda se
   * prueba contra PostgreSQL en `patient-merge.spec.ts`, que es donde
   * `merged_into_id` existe. Aquí se afirma lo único que se puede afirmar sin
   * base y que aun así se rompe en silencio: que las tres hablan del MISMO
   * predicado y que la unión de filas no se olvida de una mitad.
   */
  const CHART = '01a01716-f8bb-7e67-a942-98bba3ca075c';

  it('PA-055 el filtro del ORM pregunta por la ficha O por las que apuntan a ella', () => {
    expect(chartScope(CHART)).toEqual({
      patient: { OR: [{ id: CHART }, { mergedIntoId: CHART }] },
    });
  });

  it('PA-055 el fragmento crudo lleva las dos ramas y el id parametrizado', () => {
    const fragment = chartScopeIds(CHART);

    // Parametrizado y NUNCA interpolado: un id que viaja en el texto de la
    // sentencia es una inyección esperando a un id que no venga de un UUID.
    expect(fragment.values).toEqual([CHART, CHART]);
    expect(fragment.sql).toContain('merged_into_id');
    expect(fragment.sql).not.toContain(CHART);
  });

  it('PA-055 el select anidado pide lo mismo a la ficha y a las absorbidas', () => {
    const periods = { select: { startsOn: true, endsOn: true } };

    expect(chartScopeSelect('priorityGroups', periods)).toEqual({
      priorityGroups: periods,
      mergedFrom: { select: { priorityGroups: periods } },
    });
  });

  it('PA-055 la unión trae las filas propias Y las de cada ficha absorbida', () => {
    const row = {
      priorityGroups: [{ id: 'propia' }],
      mergedFrom: [
        { priorityGroups: [{ id: 'de-la-primera' }] },
        { priorityGroups: [{ id: 'de-la-segunda' }] },
      ],
    };

    // Las propias primero: cuando alguien se queda con la más reciente ante un
    // empate, la que gana debe ser la de la ficha viva.
    expect(chartScopeRows(row, 'priorityGroups')).toEqual([
      { id: 'propia' },
      { id: 'de-la-primera' },
      { id: 'de-la-segunda' },
    ]);
  });

  it('PA-055 una ficha que no absorbió a nadie devuelve sólo las suyas', () => {
    expect(
      chartScopeRows({ allergies: [{ id: 'penicilina' }], mergedFrom: [] }, 'allergies'), // prettier-ignore
    ).toEqual([{ id: 'penicilina' }]);
  });
});
