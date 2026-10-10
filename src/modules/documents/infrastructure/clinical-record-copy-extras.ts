import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type {
  CopyResultReport,
  CopyScreening,
} from '../domain/document-source';

type Db = Prisma.TransactionClient | PrismaService;

/** DOC-121, DOC-123. What the copy adds to each attention's summary. */
export interface CopyExtras {
  results: CopyResultReport[];
  evolutionNotes: { signedAt: Date; text: string }[];
  screening: CopyScreening | null;
}

const ABNORMAL_LABEL: Readonly<Record<string, string>> = {
  LOW: 'Bajo',
  HIGH: 'Alto',
  CRITICAL_LOW: 'Crítico bajo',
  CRITICAL_HIGH: 'Crítico alto',
};

/**
 * DOC-121, DOC-123 (D-203 §4, §6). The results, the evolution notes and —only
 * when the professional's review includes it— the violence screening of the
 * attentions of a copy, AS THEY STOOD WHEN IT WAS AUTHORISED (D-203 §3):
 *
 * - The report of an exam that was in the system by then (`created_at`), not
 *   cancelled, and not replaced by a correction recorded by then. A correction
 *   recorded AFTER is not part of what was authorised: the copy says the
 *   report was corrected on that date, and does not print the new values.
 * - Form 005 signed by then and still standing (an amended or retracted one
 *   is not the record).
 *
 * Read apart from the summary's own select so the summary (DOC-111) stays
 * exactly what it was; one statement per kind for every attention.
 */
export async function copyExtrasOf(
  db: Db,
  encounterIds: readonly string[],
  authorisedAt: Date,
  includesScreening: boolean,
): Promise<Map<string, CopyExtras>> {
  const extras = new Map<string, CopyExtras>(
    encounterIds.map((id) => [
      id,
      { results: [], evolutionNotes: [], screening: null },
    ]),
  );
  if (encounterIds.length === 0) return extras;
  const ids = [...encounterIds];

  const orders = await db.serviceOrder.findMany({
    where: { encounterId: { in: ids }, status: 'ISSUED' },
    orderBy: { requestedAt: 'asc' },
    select: {
      encounterId: true,
      number: true,
      reports: {
        where: {
          status: { not: 'CANCELLED' },
          createdAt: { lte: authorisedAt },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          issuedAt: true,
          conclusion: true,
          supersededBy: { select: { createdAt: true } },
          results: {
            orderBy: { id: 'asc' },
            select: {
              analyteDisplay: true,
              valueNumeric: true,
              valueText: true,
              valueCode: true,
              unit: true,
              referenceLow: true,
              referenceHigh: true,
              referenceText: true,
              abnormalFlag: true,
            },
          },
        },
      },
    },
  });
  for (const order of orders) {
    for (const report of order.reports) {
      const replacedBy = report.supersededBy?.createdAt ?? null;
      // Replaced by a correction that was already there: not the standing one.
      if (replacedBy !== null && replacedBy <= authorisedAt) continue;
      extras.get(order.encounterId)?.results.push({
        orderNumber: order.number,
        issuedAt: report.issuedAt,
        conclusion: report.conclusion?.trim() || null,
        values: report.results.map((result) => ({
          analyte: result.analyteDisplay,
          value: valueText(result),
          reference: referenceText(result),
          abnormal: result.abnormalFlag
            ? (ABNORMAL_LABEL[result.abnormalFlag] ?? null)
            : null,
        })),
        correctedAfter: replacedBy,
      });
    }
  }

  const notes = await db.clinicalNote.findMany({
    where: {
      encounterId: { in: ids },
      formCode: '005',
      status: 'SIGNED',
      signedAt: { lte: authorisedAt },
    },
    orderBy: { signedAt: 'asc' },
    select: { encounterId: true, signedAt: true, content: true },
  });
  for (const note of notes) {
    const text = evolutionText(note.content);
    if (note.signedAt === null || text === '') continue;
    extras
      .get(note.encounterId)
      ?.evolutionNotes.push({ signedAt: note.signedAt, text });
  }

  // D-188 §3, D-203 §6: only after a professional's review that includes it.
  if (includesScreening) {
    const screenings = await db.violenceScreening.findMany({
      where: { encounterId: { in: ids }, result: { not: 'NOT_APPLIED' } },
      select: {
        encounterId: true,
        result: true,
        types: true,
        screeningTool: true,
        actionTaken: true,
        reportedToAuthority: true,
      },
    });
    for (const screening of screenings) {
      const target = extras.get(screening.encounterId);
      if (!target) continue;
      target.screening = {
        result: screening.result,
        types: screening.types,
        tool: screening.screeningTool,
        actionTaken: screening.actionTaken,
        reportedToAuthority: screening.reportedToAuthority,
      };
    }
  }
  return extras;
}

function decimal(value: Prisma.Decimal | null): string | null {
  return value === null ? null : Number(value).toString();
}

function valueText(result: {
  valueNumeric: Prisma.Decimal | null;
  valueText: string | null;
  valueCode: string | null;
  unit: string | null;
}): string {
  const value =
    decimal(result.valueNumeric) ?? result.valueText ?? result.valueCode ?? '—';
  return result.unit && result.valueNumeric !== null
    ? `${value} ${result.unit}`
    : value;
}

function referenceText(result: {
  referenceLow: Prisma.Decimal | null;
  referenceHigh: Prisma.Decimal | null;
  referenceText: string | null;
  unit: string | null;
}): string | null {
  if (result.referenceText) return result.referenceText;
  const low = decimal(result.referenceLow);
  const high = decimal(result.referenceHigh);
  if (low === null && high === null) return null;
  const range =
    low !== null && high !== null
      ? `${low} – ${high}`
      : low !== null
        ? `≥ ${low}`
        : `≤ ${high}`;
  return result.unit ? `${range} ${result.unit}` : range;
}

/** Form 005 carries one narrative (`evolucion`); any other text, after it. */
function evolutionText(content: Prisma.JsonValue): string {
  if (
    content === null ||
    typeof content !== 'object' ||
    Array.isArray(content)
  ) {
    return '';
  }
  const record = content as Record<string, unknown>;
  const first = typeof record.evolucion === 'string' ? [record.evolucion] : [];
  const rest = Object.entries(record)
    .filter(([key, value]) => key !== 'evolucion' && typeof value === 'string')
    .map(([, value]) => value as string);
  return [...first, ...rest]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n');
}
