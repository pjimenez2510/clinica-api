import { describe, expect, it } from 'vitest';

import {
  ConceptWrongCatalogueError,
  DiagnosisConceptNotInForceError,
  DiagnosisPrimaryTakenError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import { PrismaClinicalCodingRepository } from './prisma-clinical-coding.repository';
import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

/**
 * Block K's write transaction, against a double of the Prisma client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A DOUBLE CAN HONESTLY PROVE HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT the guarantees — `trg_diagnosis_snapshot`,
 * `trg_diagnosis_concept_in_force` and `encounter_diagnosis_one_primary` are
 * exercised against a real PostgreSQL in
 * `test/integration/encounter-diagnoses.spec.ts`, and a double returning what
 * we asked it for would prove none of them.
 *
 * What IS this adapter's own decision, and what an integration failure would
 * report from three layers away:
 *
 *  - that the scope of the attention is re-checked INSIDE the transaction;
 *  - that the catalogue of the concept is checked at all, which is the hole
 *    the foreign key leaves open;
 *  - that the code and the description written are the ones READ FROM THE
 *    CONCEPT in this same transaction, never values a caller supplied;
 *  - that the rank is taken from the highest in use, so an explicit 5 does not
 *    make the next one collide with an existing 2;
 *  - ⚠️ and that NO AMOUNT is ever part of the insert (EN-051).
 */

const ENCOUNTER = '00000000-0000-4000-8000-00000000000a';
const CONCEPT = '00000000-0000-4000-8000-00000000000b';
const SITE = '00000000-0000-4000-8000-000000000001';

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** One row of what `conceptForEncounter` asks PostgreSQL. */
function conceptRow(overrides: Record<string, unknown> = {}) {
  return {
    system_code: 'CIE10',
    concept_code: 'J020',
    concept_display: 'Faringitis estreptocócica',
    in_force: true,
    ...overrides,
  };
}

/**
 * A Prisma double whose `$transaction` simply runs the callback: what is
 * verified is which calls the adapter makes INSIDE it, and with which
 * arguments.
 */
function prismaDouble(options: {
  encounter?: { id: string } | null;
  concept?: Record<string, unknown>[];
  ranks?: { rank: number }[];
}) {
  const calls: Call[] = [];

  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
  };

  const tx = {
    encounter: {
      findFirst: (args: Record<string, unknown>) => {
        record('encounter.findFirst', args);
        return Promise.resolve(
          options.encounter === undefined
            ? { id: ENCOUNTER }
            : options.encounter,
        );
      },
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      record('$queryRaw', { sql: strings.join('?'), values });
      return Promise.resolve(options.concept ?? [conceptRow()]);
    },
    encounterDiagnosis: {
      findMany: (args: Record<string, unknown>) => {
        record('encounterDiagnosis.findMany', args);
        return Promise.resolve(options.ranks ?? []);
      },
      create: (args: Record<string, unknown>) => {
        record('encounterDiagnosis.create', args);
        const data = args.data as Record<string, unknown>;
        return Promise.resolve({
          id: 'diagnosis-1',
          encounterId: ENCOUNTER,
          conceptId: CONCEPT,
          cie10Code: data.cie10Code,
          cie10Display: data.cie10Display,
          certainty: data.certainty,
          occurrence: data.occurrence,
          rank: data.rank,
          notifiable: data.notifiable,
          note: data.note ?? null,
          recordedAt: new Date('2026-08-14T14:20:00Z'),
        });
      },
    },
    encounterProcedure: {
      create: (args: Record<string, unknown>) => {
        record('encounterProcedure.create', args);
        const data = args.data as Record<string, unknown>;
        return Promise.resolve({
          id: 'procedure-1',
          encounterId: ENCOUNTER,
          conceptId: CONCEPT,
          procedureCode: data.procedureCode,
          procedureDisplay: data.procedureDisplay,
          quantity: data.quantity,
          performedAt: data.performedAt ?? new Date('2026-08-14T15:00:00Z'),
          note: data.note ?? null,
        });
      },
    },
  };

  const prisma = {
    $transaction: <T>(run: (client: typeof tx) => Promise<T>): Promise<T> =>
      run(tx),
  };

  return { prisma: prisma as unknown as PrismaService, calls };
}

const aDiagnosis = (overrides: Record<string, unknown> = {}) => ({
  encounterId: ENCOUNTER,
  conceptId: CONCEPT,
  certainty: 'DEFINITIVE' as const,
  occurrence: 'FIRST_TIME' as const,
  sites: [SITE],
  ...overrides,
});

const argsOf = (calls: Call[], method: string) =>
  calls.find((call) => call.method === method)?.args;

describe('el adaptador del bloque K', () => {
  it('EN-121 vuelve a comprobar el alcance de sede DENTRO de la transacción', async () => {
    /**
     * El servicio ya rechazó una atención fuera de alcance, y esto no es
     * ceremonia: entre aquella lectura y esta escritura se puede revocar una
     * concesión, y la fila que aterriza es la que cuenta.
     */
    const { prisma, calls } = prismaDouble({ encounter: null });

    await expect(
      new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis()),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);

    expect(argsOf(calls, 'encounter.findFirst')).toMatchObject({
      where: { id: ENCOUNTER, siteId: { in: [SITE] } },
    });
    // Y no se escribió nada.
    expect(argsOf(calls, 'encounterDiagnosis.create')).toBeUndefined();
  });

  it('EN-121 no filtra por sede cuando el alcance es todas', async () => {
    const { prisma, calls } = prismaDouble({});

    await new PrismaClinicalCodingRepository(prisma).addDiagnosis(
      aDiagnosis({ sites: 'all' }),
    );

    expect(argsOf(calls, 'encounter.findFirst')).toMatchObject({
      where: { id: ENCOUNTER },
    });
  });

  it('EN-040 rechaza un concepto de otro catálogo antes de escribir', async () => {
    const { prisma, calls } = prismaDouble({
      concept: [conceptRow({ system_code: 'DPA', concept_code: '170150' })],
    });

    await expect(
      new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis()),
    ).rejects.toBeInstanceOf(ConceptWrongCatalogueError);
    expect(argsOf(calls, 'encounterDiagnosis.create')).toBeUndefined();
  });

  it('EN-040 responde lo mismo a un concepto que no existe: elegir de la lista correcta', async () => {
    // La clave foránea lo rechazaría un instante después con
    // `RELATED_RECORD_MISSING`, que le dice «falta un registro relacionado» a
    // quien tecleó un código.
    const { prisma } = prismaDouble({ concept: [] });

    await expect(
      new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis()),
    ).rejects.toBeInstanceOf(ConceptWrongCatalogueError);
  });

  it('EN-042 pregunta la vigencia con la fecha clínica en America/Guayaquil', async () => {
    /**
     * ⚠️ EL MISMO PREDICADO DEL DISPARADOR, LITERAL. Un `::date` desnudo sobre
     * un `timestamptz` usa el huso de la SESIÓN, así que un diagnóstico
     * registrado a las 20:00 del último día de vigencia se comprobaría contra
     * el día siguiente y se rechazaría.
     */
    const { prisma, calls } = prismaDouble({});

    await new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis());

    const sql = String(argsOf(calls, '$queryRaw')?.sql);
    expect(sql).toContain("AT TIME ZONE 'America/Guayaquil'");
    expect(sql).toContain('valid_period');
  });

  it('EN-042 rechaza sin escribir cuando el concepto no regía ese día', async () => {
    const { prisma, calls } = prismaDouble({
      concept: [conceptRow({ in_force: false })],
    });

    await expect(
      new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis()),
    ).rejects.toBeInstanceOf(DiagnosisConceptNotInForceError);
    expect(argsOf(calls, 'encounterDiagnosis.create')).toBeUndefined();
  });

  it('EN-041 escribe el código y la descripción LEÍDOS DEL CONCEPTO', async () => {
    /**
     * No hay forma de que un valor del cliente llegue a estas dos columnas: no
     * viajan en la petición y el adaptador las copia del concepto que acaba de
     * leer. `trg_diagnosis_snapshot` rechaza cualquier otra cosa, así que ésta
     * es la única pareja que el `INSERT` puede llevar.
     */
    const { prisma, calls } = prismaDouble({});

    await new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis());

    expect(argsOf(calls, 'encounterDiagnosis.create')).toMatchObject({
      data: {
        cie10Code: 'J020',
        cie10Display: 'Faringitis estreptocócica',
      },
    });
  });

  it('EN-043 hace principal al primer diagnóstico cuando nadie dice el orden', async () => {
    const { prisma, calls } = prismaDouble({ ranks: [] });

    await new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis());

    expect(argsOf(calls, 'encounterDiagnosis.create')).toMatchObject({
      data: { rank: 1 },
    });
  });

  it('EN-047 toma el rango del MÁS ALTO en uso y no de un recuento de filas', async () => {
    // Un recuento repartiría el 2 dos veces en cuanto existiera un rango 5.
    const { prisma, calls } = prismaDouble({
      ranks: [{ rank: 1 }, { rank: 5 }],
    });

    await new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis());

    expect(argsOf(calls, 'encounterDiagnosis.create')).toMatchObject({
      data: { rank: 6 },
    });
  });

  it('EN-043 rechaza el segundo principal antes de llegar al índice', async () => {
    const { prisma, calls } = prismaDouble({ ranks: [{ rank: 1 }] });

    await expect(
      new PrismaClinicalCodingRepository(prisma).addDiagnosis(
        aDiagnosis({ rank: 1 }),
      ),
    ).rejects.toBeInstanceOf(DiagnosisPrimaryTakenError);
    expect(argsOf(calls, 'encounterDiagnosis.create')).toBeUndefined();
  });

  it('EN-049 escribe la marca de notificación como falsa cuando nadie la pone', async () => {
    const { prisma, calls } = prismaDouble({});

    await new PrismaClinicalCodingRepository(prisma).addDiagnosis(aDiagnosis());

    expect(argsOf(calls, 'encounterDiagnosis.create')).toMatchObject({
      data: { notifiable: false },
    });
  });

  it('EN-046 deriva la modalidad del código CONGELADO al devolver la fila', async () => {
    const { prisma } = prismaDouble({
      concept: [
        conceptRow({
          concept_code: 'Z349',
          concept_display: 'Supervisión de embarazo normal',
        }),
      ],
    });

    const diagnosis = await new PrismaClinicalCodingRepository(
      prisma,
    ).addDiagnosis(aDiagnosis());

    expect(diagnosis.careModality).toBe('PREVENTION');
  });

  it('EN-050 congela el código del tarifario, que no tiene disparador que lo garantice', async () => {
    const { prisma, calls } = prismaDouble({
      concept: [
        conceptRow({
          system_code: 'TARIFF',
          concept_code: '23.09',
          concept_display: 'Extracción dental',
        }),
      ],
    });

    const procedure = await new PrismaClinicalCodingRepository(
      prisma,
    ).addProcedure({
      encounterId: ENCOUNTER,
      conceptId: CONCEPT,
      quantity: 2,
      sites: [SITE],
    });

    expect(argsOf(calls, 'encounterProcedure.create')).toMatchObject({
      data: {
        procedureCode: '23.09',
        procedureDisplay: 'Extracción dental',
        quantity: 2,
      },
    });
    expect(procedure.procedureCode).toBe('23.09');
  });

  it('EN-050 rechaza un concepto que no es del tarifario', async () => {
    const { prisma, calls } = prismaDouble({});

    await expect(
      new PrismaClinicalCodingRepository(prisma).addProcedure({
        encounterId: ENCOUNTER,
        conceptId: CONCEPT,
        quantity: 1,
        sites: [SITE],
      }),
    ).rejects.toBeInstanceOf(ConceptWrongCatalogueError);
    expect(argsOf(calls, 'encounterProcedure.create')).toBeUndefined();
  });

  it('EN-051 no incluye ninguna columna de dinero en el INSERT del procedimiento', async () => {
    /**
     * ⚠️ LA AUSENCIA ES EL REQUISITO. `encounter_procedure.tariff_amount`
     * existe y este adaptador no la nombra: lo que cuesta el procedimiento es
     * un `charge_item` de `billing`, resuelto por la lista de precios del
     * pagador en la fecha del servicio. Una fila clínica que además lleve el
     * dinero son dos registros en uno, y el hecho clínico no cambia porque el
     * paciente no pague.
     */
    const { prisma, calls } = prismaDouble({
      concept: [
        conceptRow({
          system_code: 'TARIFF',
          concept_code: '23.09',
          concept_display: 'Extracción dental',
        }),
      ],
    });

    await new PrismaClinicalCodingRepository(prisma).addProcedure({
      encounterId: ENCOUNTER,
      conceptId: CONCEPT,
      quantity: 1,
      sites: [SITE],
    });

    const data = (
      argsOf(calls, 'encounterProcedure.create') as { data: object }
    ).data;
    expect(
      Object.keys(data).filter((key) => /amount|price|tarif/i.test(key)),
    ).toEqual([]);
  });
});
