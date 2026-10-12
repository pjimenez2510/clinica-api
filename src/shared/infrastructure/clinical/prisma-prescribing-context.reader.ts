import { Injectable } from '@nestjs/common';

import type { SubstanceKeys } from '../../clinical/allergy-match';
import type {
  CnmbMedicine,
  CnmbPresentation,
  PrescribedLine,
  PrescribingContextReader,
} from '../../clinical/prescribing-context.port';
import { PrismaService } from '../prisma/prisma.service';

import { substanceKeysIn } from './substance-keys';

/** A receta that still says what was prescribed: not discarded, not annulled. */
const STANDING = ['DRAFT', 'ACTIVE', 'COMPLETED'] as const;

/**
 * AS-064, AS-069, AS-072, AS-074 over PostgreSQL. Reads the cuadro and the
 * receta; writes nothing.
 */
@Injectable()
export class PrismaPrescribingContextReader implements PrescribingContextReader {
  constructor(private readonly prisma: PrismaService) {}

  async searchCnmb(
    name: string,
    clinicalDate: string,
    limit: number,
  ): Promise<CnmbMedicine[]> {
    const term = fold(name);
    if (term === '') return [];
    // AS-064. The DCI the importer keys (`dci:amoxicilina`) or the display;
    // `search_display` is the display already without accents nor case.
    const rows = await this.prisma.$queryRaw<
      { id: string; code: string; display: string; attributes: unknown }[]
    >`
      SELECT c.id::text AS id, c.code, c.display, c.attributes
        FROM catalog_concept c
        JOIN catalog_system s ON s.id = c.system_id AND s.code = 'CNMB'
       WHERE c.valid_period @> ${clinicalDate}::date
         AND (c.search_display LIKE ${`%${escapeLike(term)}%`}
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(c.attributes -> 'substances') = 'array'
                       THEN c.attributes -> 'substances' ELSE '[]'::jsonb END) AS d(key)
                 WHERE d.key LIKE ${`dci:%${escapeLike(term)}%`}))
       ORDER BY (c.search_display = ${term}) DESC,
                (c.search_display LIKE ${`${escapeLike(term)}%`}) DESC,
                length(c.display), c.code
       LIMIT ${limit}`;
    return rows.map((row) => {
      const attributes = asRecord(row.attributes);
      return {
        conceptId: row.id,
        code: row.code,
        display: row.display,
        presentations: presentationsOf(attributes.presentations),
        // PR-070. The issue's own criterion (`->> 'controlled' = 'true'`).
        controlled: String(attributes.controlled) === 'true',
      };
    });
  }

  substanceKeys(conceptIds: readonly string[]): Promise<SubstanceKeys> {
    return substanceKeysIn(this.prisma, conceptIds);
  }

  async prescribedCodes(encounterId: string): Promise<string[]> {
    const rows = await this.prisma.prescriptionItem.findMany({
      where: {
        prescription: { encounterId, status: { in: [...STANDING] } },
        conceptId: { not: null },
      },
      select: { concept: { select: { code: true } } },
    });
    return [
      ...new Set(
        rows.flatMap((row) => (row.concept ? [row.concept.code] : [])),
      ),
    ];
  }

  async prescriptionLine(
    encounterId: string,
    prescriptionId: string,
    line: number,
  ): Promise<PrescribedLine | null> {
    if (!Number.isSafeInteger(line) || line < 1) return null;
    const prescription = await this.prisma.prescription.findFirst({
      where: { id: prescriptionId, encounterId, status: { in: [...STANDING] } },
      select: {
        // The receta's own order (PR-032): no order column, the id's.
        items: { orderBy: { id: 'asc' }, skip: line - 1, take: 1 },
      },
    });
    const item = prescription?.items[0];
    if (!item) return null;
    return {
      conceptId: item.conceptId,
      dosageFormCode: item.dosageFormCode,
      concentration: item.concentration,
      routeCode: item.routeCode,
      doseAmount: item.doseAmount === null ? null : Number(item.doseAmount),
      doseUnitCode: item.doseUnitCode,
      frequencyCode: item.frequencyCode,
      frequencyText: item.frequencyText,
      durationDays: item.durationDays,
      quantity: item.quantity === null ? null : Number(item.quantity),
    };
  }
}

/** The importer's own folding (`substanceKeyOf`): no accents, no case. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** PR-115. The presentations as the importer wrote them; anything else is dropped. */
function presentationsOf(value: unknown): CnmbPresentation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const each = asRecord(entry);
    if (typeof each.form !== 'string' || typeof each.concentration !== 'string')
      return [];
    const forms = Array.isArray(each.forms)
      ? each.forms.filter((form): form is string => typeof form === 'string')
      : undefined;
    return [
      {
        form: each.form,
        concentration: each.concentration,
        ...(forms ? { forms } : {}),
        ...(typeof each.label === 'string' ? { label: each.label } : {}),
        ...(typeof each.route === 'string' ? { route: each.route } : {}),
      },
    ];
  });
}
