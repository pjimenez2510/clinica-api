import type { z } from 'zod';

import {
  candidatesContext,
  LINES_INSTRUCTIONS,
  LINES_PROMPT_VERSION,
  linesAnswer,
  MAPPING_INSTRUCTIONS,
  MAPPING_PROMPT_VERSION,
  mappingAnswer,
  vocabularyContext,
  writtenLines,
} from '../../src/modules/assistant/application/prescription-reading.prompts.ts';
import { withContext } from '../../src/modules/assistant/application/llm-client.port.ts';
import { noteText } from '../../src/modules/assistant/application/problem-coding.prompts.ts';
import {
  backedLines,
  knownCodes,
  presentationFor,
} from '../../src/modules/assistant/domain/prescription-reading.ts';
import type { CnmbMedicine as CuadroMedicine } from '../../src/modules/catalogs/import/cnmb.ts';
import type { CnmbMedicine } from '../../src/shared/clinical/prescribing-context.port.ts';
import { caseText } from '../case-text.ts';
import type { PrescriptionNoteCase } from '../cases.ts';
import type { Catalogues } from '../catalogue.ts';
import type { EvalTask, Scores } from '../task.ts';

/** AS-064. Candidates offered per line, as the product offers them. */
const CANDIDATES = 5;

type LinesAnswer = z.infer<typeof linesAnswer>;

/** The product's folding of a name (`PrismaPrescribingContextReader`). */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** The concentration compared without spaces, case or the decimal comma. */
const sameConcentration = (a: string | null, b: string | null) =>
  (a ?? '').toLowerCase().replace(/\s+/g, '').replace(/,/g, '.') ===
  (b ?? '').toLowerCase().replace(/\s+/g, '').replace(/,/g, '.');

/**
 * AS-064. The product's search over the cuadro of the repository: the DCI
 * key or the display containing the name, the exact one first, then the one
 * that starts with it, then the shortest — what `searchCnmb` of the reader
 * does in SQL.
 */
export function searchLikeTheProduct(
  name: string,
  cnmb: readonly CuadroMedicine[],
): CnmbMedicine[] {
  const term = fold(name);
  if (term === '') return [];
  return cnmb
    .filter(
      (medicine) =>
        fold(medicine.display).includes(term) ||
        medicine.substances.some(
          (key) => key.startsWith('dci:') && key.includes(term),
        ),
    )
    .sort((a, b) => {
      const rank = (m: CuadroMedicine) =>
        fold(m.display) === term ? 0 : fold(m.display).startsWith(term) ? 1 : 2; // prettier-ignore
      return (
        rank(a) - rank(b) ||
        a.display.length - b.display.length ||
        a.code.localeCompare(b.code)
      );
    })
    .slice(0, CANDIDATES)
    .map((medicine) => ({
      conceptId: medicine.code,
      code: medicine.code,
      display: medicine.display,
      presentations: medicine.presentations.map((p) => ({
        form: p.form,
        forms: p.forms,
        concentration: p.concentration,
        label: p.label,
        route: p.route,
      })),
      controlled: medicine.controlled,
    }));
}

/**
 * AS-079 (D2). «Proponer la receta» measured as the product runs it: the
 * reading prompt over the note, the search of the cuadro, the choosing
 * prompt and the barriers of AS-063 to AS-066 — the very functions of
 * `src/`. One arm, D: what the physician sees.
 *
 * The primary metric is E-072's: of the lines the note prescribes, how many
 * the screen shows with the RIGHT medicine and presentation of the cuadro.
 * A line whose written strength is not in the cuadro is right only shown
 * without a presentation (AS-066). Lines shown that the note does not
 * prescribe (what is suspended, what the patient already takes, an
 * allergy) are counted apart. A medicine outside the cuadro is never shown
 * by construction — a choice is only a candidate — so it is counted to prove
 * it, not to measure it.
 */
export function prescriptionFromNoteTask(
  catalogues: Catalogues,
): EvalTask<PrescriptionNoteCase, LinesAnswer> {
  const inCuadro = new Set(catalogues.cnmb.map((medicine) => medicine.code));

  return {
    name: 'receta-nota',
    title: 'Receta propuesta desde la nota (D2)',
    arms: ['D'],
    promptVersions: { D: `${LINES_PROMPT_VERSION}+${MAPPING_PROMPT_VERSION}` },
    latencyBudgetMs: 5_000,
    callsPerAnswer: 2,
    metrics: [
      {
        key: 'mapping',
        label: 'Líneas con el medicamento y la presentación correctos',
        kind: 'mean',
        primary: true,
      },
      { key: 'medicine', label: 'Líneas con el medicamento correcto', kind: 'mean' }, // prettier-ignore
      { key: 'all', label: 'Receta entera correcta', kind: 'binary' },
      {
        key: 'extra',
        label: 'Medicamentos mostrados que la nota no receta (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
      },
      {
        key: 'outsideCnmb',
        label: 'Medicamentos fuera del CNMB mostrados (por caso)',
        kind: 'mean',
        lowerIsBetter: true,
        primary: true,
      },
    ],
    request(item) {
      return {
        tier: 'quality',
        purpose: 'eval-receta-nota',
        promptVersion: LINES_PROMPT_VERSION,
        system: LINES_INSTRUCTIONS,
        prompt: withContext(
          caseText(noteText([{ label: 'Plan', text: item.plan }])),
          vocabularyContext(),
        ),
        answer: linesAnswer,
        maxTokens: 2_000,
      };
    },
    async evaluate(item, _arm, value, _judge, followUp) {
      const sections = [{ key: 'plan', text: item.plan }];
      const backed = backedLines({
        read: value.lines.map(knownCodes),
        cleared: item.plan,
        sections,
        restore: (text) => text,
      });
      const candidates = backed.kept.map((line) =>
        searchLikeTheProduct(line.drug, catalogues.cnmb),
      );
      let choices: z.infer<typeof mappingAnswer>['choices'] = [];
      if (candidates.some((each) => each.length > 0)) {
        if (!followUp) throw new Error('receta-nota pregunta dos veces al mismo proveedor'); // prettier-ignore
        const answer = await followUp({
          tier: 'quality',
          purpose: 'eval-receta-nota-mapeo',
          promptVersion: MAPPING_PROMPT_VERSION,
          system: MAPPING_INSTRUCTIONS,
          prompt: withContext(
            caseText(writtenLines(backed.kept)),
            candidatesContext(candidates),
          ),
          answer: mappingAnswer,
          maxTokens: 1_000,
        });
        // The second call failed: nothing is shown, as in the product.
        if (answer === null) return { shown: null, scores: nothingShown(item) };
        choices = answer.choices;
      }

      const shown = backed.kept.flatMap((line, at) => {
        const choice = choices.find((each) => each.line === at + 1);
        const medicine =
          choice?.medicine == null
            ? undefined
            : candidates[at]?.[choice.medicine - 1];
        if (!medicine) return [];
        const chosen = presentationFor(
          choice?.presentation == null
            ? undefined
            : medicine.presentations[choice.presentation - 1],
          { form: line.form, strength: line.strength },
        );
        return [
          { code: medicine.code, concentration: chosen?.concentration ?? null },
        ];
      });

      return { shown, scores: scoresOf(item, shown, inCuadro) };
    },
  };
}

function scoresOf(
  item: PrescriptionNoteCase,
  shown: readonly { code: string; concentration: string | null }[],
  inCuadro: ReadonlySet<string>,
): Scores {
  const left = [...shown];
  let mapped = 0;
  let medicines = 0;
  for (const expected of item.expected) {
    const sameMedicine = left.findIndex((each) => each.code === expected.cnmbCode); // prettier-ignore
    if (sameMedicine < 0) continue;
    medicines += 1;
    const exact = left.findIndex(
      (each) =>
        each.code === expected.cnmbCode &&
        sameConcentration(each.concentration, expected.concentration),
    );
    if (exact >= 0) {
      mapped += 1;
      left.splice(exact, 1);
    } else {
      left.splice(sameMedicine, 1);
    }
  }
  const lines = item.expected.length;
  return {
    mapping: lines === 0 ? null : mapped / lines,
    medicine: lines === 0 ? null : medicines / lines,
    all: mapped === lines && left.length === 0 ? 1 : 0,
    extra: left.length,
    outsideCnmb: shown.filter((each) => !inCuadro.has(each.code)).length,
  };
}

/** A failed second call shows nothing: every expected line is missed. */
function nothingShown(item: PrescriptionNoteCase): Scores {
  const lines = item.expected.length;
  return {
    mapping: lines === 0 ? null : 0,
    medicine: lines === 0 ? null : 0,
    all: lines === 0 ? 1 : 0,
    extra: 0,
    outsideCnmb: 0,
  };
}
