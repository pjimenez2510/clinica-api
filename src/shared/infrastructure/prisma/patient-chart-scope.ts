import { Prisma } from '@prisma/client';

/**
 * «La ficha y sus absorbidas», written ONCE (PA-055, D-038 option C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT PROBLEM THIS IS, IN ONE SCENE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > Admissions correctly merges a patient's two charts. The absorbed one held
 * > her ALLERGY TO PENICILLIN. The doctor opens the surviving chart, sees no
 * > allergy, and prescribes.
 *
 * The merge was right, the trail is impeccable and the datum is in the
 * database. What was missing is somebody to READ it. REQ-008 demands allergies
 * be permanently visible during a consultation, and a merged chart hides them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS COMPLETES D-031, IT DOES NOT CONTRADICT IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-031 decided the merge RE-POINTS NOTHING: appointments, encounters,
 * documents, allergies, contacts and priority groups keep their `patient_id`
 * on the absorbed chart, and the survivor reads them BY FOLLOWING THE LINK.
 * That decision stands and this file does not touch it — no `UPDATE` is
 * issued here, and undoing a merge stays trivial precisely because nothing
 * moved. The link was always the mechanism; what never existed was the reader.
 * This is the reader.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT «HISTORY» IS, AND WHAT IS NOT — because not everything hanging off a
 * chart is read this way
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HISTORY — what happened to the PERSON. It stays where it was written and is
 * read through this scope: `patient_priority_group`, `patient_allergy`,
 * `patient_contact`, `agenda_entry`, `waitlist_entry`, `encounter`,
 * `medical_certificate`, `referral`.
 *
 * NOT HISTORY, and each for its own reason:
 *
 *  - `patient_identifier` — ALREADY CONSOLIDATED into the survivor inside the
 *    merge transaction (PA-043). A document is not something that happened to
 *    the person, it is HOW SHE IS FOUND. It is the one child table whose
 *    `patient_id` a merge changes; scoping it on top would return the same
 *    row twice.
 *  - `patient_change_history` — a trail ABOUT the chart, not care received
 *    (D-032). «Who corrected this surname» is a question about the record.
 *  - `patient_merge` and `access_audit` — trails about the chart for the same
 *    reason, and neither even has a `patient_id` column.
 *  - `patient.mother_patient_id` — a column of ANOTHER chart pointing at this
 *    one, not content of this one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE: THREE FRAGMENTS, NO VIEW — and why
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A SQL view (`patient_chart_scope`) was the obvious other answer and was
 * rejected AS OF TODAY: nothing in the code path would read it. Every read
 * that exists today is Prisma-shaped, so a view would be a THIRD statement of
 * one predicate that only the tests exercise — and three statements of one
 * predicate is how they end up disagreeing. `chartScopeIds` below is that
 * predicate for raw SQL, in the same file as the other two, so the day a
 * report needs it there is one place to change and one place to read. If a
 * raw statement ever needs it in a `JOIN` rather than an `IN`, THAT is when a
 * view earns a migration.
 *
 * ONE LEVEL, NEVER A TREE. `trg_patient_merge_not_chained` refuses A→B→C in
 * both directions (PA-046), so an absorbed chart can never itself have
 * absorbed one. That is why this is a flat `OR` and not a recursive CTE:
 * walking a tree that cannot exist would cost every read for a shape the
 * database forbids.
 *
 * UNDOING WORKS WITH NOBODY REMEMBERING ANYTHING. The scope is derived from
 * `merged_into_id` at read time and stored nowhere. Clearing the link is all
 * an undo does, and the history stops being visible from the former survivor
 * in the same instant.
 *
 * NOT A QUERY PER ROW AND NOT A SECOND ROUND TRIP. `chartScope` is a relation
 * filter that the planner resolves as a join; `chartScopeSelect` travels
 * inside the SAME statement as the row it hangs off (`relationJoins` is on,
 * see the header of `schema.prisma`). Both are answered by the PARTIAL index
 * `patient_absorbed_charts` (`WHERE merged_into_id IS NOT NULL`), which P4
 * created exactly «para recorrer el enlace hacia atrás».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS NOT ENOUGH TO WRITE IT — see `patient-chart-scope.spec.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A shared resolution a new module can ignore is option A with extra steps.
 * The spec beside this file walks the REAL source and fails when a history
 * table is read by a bare patient id, the same way `route-authorisation.spec`
 * walks the routes NestJS actually registered. Reading history without coming
 * through here breaks the build.
 */

/**
 * The Prisma relation filter, for any model that has a `patient` relation.
 *
 * Typed through `Prisma.PatientWhereInput` and not as the literal it happens
 * to be: Prisma models a required relation as an XOR between «la fila» and «un
 * filtro sobre la fila», and a hand-written literal lands in neither branch.
 */
export interface ChartScopeFilter {
  patient: Prisma.PatientWhereInput;
}

/**
 * The chart and its absorbed charts, as a `where` fragment.
 *
 * ```ts
 * this.prisma.patientPriorityGroup.findMany({ where: chartScope(chartId) })
 * ```
 *
 * THROUGH THE RELATION AND NOT THROUGH A LIST OF IDS: resolving the ids first
 * would be a second round trip on every read, and a stale list between the two
 * would be a merge or an undo that lands in the gap.
 */
export function chartScope(chartId: string): ChartScopeFilter {
  return { patient: { OR: [{ id: chartId }, { mergedIntoId: chartId }] } };
}

/**
 * The same scope when reading DOWN from a patient row that is already being
 * selected — one statement, no extra query.
 *
 * ```ts
 * ...chartScopeSelect('priorityGroups', PRIORITY_PERIOD_SELECT)
 * ```
 *
 * yields the chart's own rows AND the same selection on every chart it
 * absorbed. `chartScopeRows` puts the two halves back together, so no caller
 * writes that union by hand — a union written by hand is a union somebody
 * forgets on the second call site.
 */
export function chartScopeSelect<K extends string, S>(
  relation: K,
  select: S,
): Record<K, S> & { mergedFrom: { select: Record<K, S> } } {
  const own = { [relation]: select } as Record<K, S>;
  return { ...own, mergedFrom: { select: { ...own } } };
}

/** A row selected with `chartScopeSelect`, from the reader's side. */
export type ChartScopeRow<K extends string, R> = Record<K, readonly R[]> & {
  mergedFrom: readonly Record<K, readonly R[]>[];
};

/**
 * The chart's own rows followed by the absorbed charts', in one list.
 *
 * OWN FIRST on purpose: when a caller keeps only the newest of something, the
 * live chart is the one whose row should win a tie.
 */
export function chartScopeRows<K extends string, R>(
  row: ChartScopeRow<K, R>,
  relation: K,
): readonly R[] {
  return [
    ...row[relation],
    ...row.mergedFrom.flatMap((absorbed) => absorbed[relation]),
  ];
}

/**
 * The same scope for a raw statement: `WHERE patient_id IN ${chartScopeIds(id)}`.
 *
 * Raw SQL is how this project answers anything the ORM cannot express in one
 * pass — the register search, the eight counters of PA-049 — and the RDACAA
 * report will be more of it. Without this fragment the first such report would
 * either re-derive the predicate or quietly skip the absorbed chart.
 */
export function chartScopeIds(chartId: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT chart.id
      FROM patient AS chart
     WHERE chart.id = ${chartId}::uuid
        OR chart.merged_into_id = ${chartId}::uuid
  )`;
}
