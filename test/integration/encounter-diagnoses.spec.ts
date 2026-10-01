import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaClinicalCodingRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-coding.repository';
import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import '../../src/modules/encounter/infrastructure/encounter.constraints';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * Block K against a real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE GUARANTEES THAT ONLY THE DATABASE CAN DEMONSTRATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - EN-041: `trg_diagnosis_snapshot`. The frozen code and description are
 *    deliberately redundant with the catalogue — in fifteen years it may have
 *    been migrated, pruned or reloaded and the record still has to say what
 *    was diagnosed — and that same redundancy is the way a lie would get in.
 *    What has to be shown is that the two CANNOT be made to disagree, which a
 *    double returning what we asked it for proves nothing about.
 *  - EN-042: `trg_diagnosis_concept_in_force`, with the clinical date resolved
 *    in `America/Guayaquil`. REQ-029 turned into a property of the row instead
 *    of a query somebody has to remember to write every time a report is
 *    reprocessed.
 *  - EN-043: `encounter_diagnosis_one_primary`, a partial unique index. Two
 *    principals make the monthly report count one consultation twice, in two
 *    different causes of morbidity.
 *
 * ⚠️ AND EACH OF THEM IS EXERCISED TWICE: through the repository, which is how
 * the application reaches them, AND through raw SQL, which is how an import, a
 * `psql` or a use case somebody writes in two years reaches them. If only the
 * first were tested, an application check would look indistinguishable from a
 * database guarantee.
 */
const db = useDatabase();

const codingOf = (prisma: PrismaClient) =>
  new PrismaClinicalCodingRepository(prisma as unknown as PrismaService);

const encountersOf = (prisma: PrismaClient) =>
  new PrismaEncounterRepository(prisma as unknown as PrismaService);

/** The CIE-10 as the catalogue holds it: a system and versioned concepts. */
async function aCie10Concept(
  prisma: PrismaClient,
  concept: { code: string; display: string; validFrom: Date; validTo?: Date },
  systemCode = 'CIE10',
) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: systemCode },
    create: { code: systemCode, name: `Catálogo ${systemCode}` },
    update: {},
  });

  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code: concept.code,
      display: concept.display,
      validFrom: concept.validFrom,
      validTo: concept.validTo ?? null,
    },
  });
}

async function anEncounter(
  prisma: PrismaClient,
  startedAt = new Date('2026-08-14T14:00:00Z'),
) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);

  const encounter = await encountersOf(prisma).open({
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    startedAt,
    careModality: 'MORBIDITY',
    careSetting: 'INTRAMURAL',
    visitSequence: 'FIRST_TIME',
  });

  return { site, encounter, sites: [site.id] as const };
}

/** Runs an operation expected to fail and maps whatever it threw. */
async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error('the operation should have failed');
  } catch (error) {
    return extractDatabaseProblem(error);
  }
}

describe('los diagnósticos de la atención', () => {
  it('EN-040 registra el diagnóstico contra la VERSIÓN del concepto y congela su código', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const concept = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });

    const diagnosis = await codingOf(prisma).addDiagnosis({
      encounterId: encounter.id,
      conceptId: concept.id,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      sites: [...sites],
    });

    expect(diagnosis.conceptId).toBe(concept.id);
    expect(diagnosis.cie10Code).toBe('J020');
    expect(diagnosis.cie10Display).toBe('Faringitis estreptocócica');
  });

  it('EN-041 la BASE rechaza un código congelado que no es el del concepto', async () => {
    /**
     * ⚠️ ESTO ES LO QUE HACE HONESTA A LA REDUNDANCIA. La copia existe para
     * que la atención de hace quince años siga diciendo qué se diagnosticó
     * aunque el catálogo se haya recargado —lo mismo que una factura guarda el
     * precio y no sólo el id del producto—. Sin el disparador, esa misma copia
     * es por donde entraría la mentira: un `UPDATE` o un `INSERT` a mano
     * dejando el código de otra enfermedad junto al concepto correcto.
     */
    const prisma = db();
    const { encounter } = await anEncounter(prisma);
    const concept = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });

    const problem = await problemFrom(
      prisma.$executeRawUnsafe(
        `INSERT INTO encounter_diagnosis
           (encounter_id, concept_id, cie10_code, cie10_display, certainty, occurrence, rank)
         VALUES ($1::uuid, $2::uuid, 'E119', 'Diabetes mellitus tipo 2', 'DEFINITIVE', 'FIRST_TIME', 1)`,
        encounter.id,
        concept.id,
      ),
    );

    expect(problem?.code).toBe('INTEGRITY_RULE_FAILED');
    expect(problem?.status).toBe(422);
  });

  it('EN-041 completa la descripción desde el concepto cuando nadie la escribe', async () => {
    // `trg_diagnosis_snapshot` hace `coalesce(NEW.cie10_display, v_display)`:
    // el que escribe por otra vía no puede dejar la fila sin descripción.
    const prisma = db();
    const { encounter } = await anEncounter(prisma);
    const concept = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO encounter_diagnosis
         (encounter_id, concept_id, cie10_code, certainty, occurrence, rank)
       VALUES ($1::uuid, $2::uuid, 'J020', 'DEFINITIVE', 'FIRST_TIME', 1)`,
      encounter.id,
      concept.id,
    );

    const stored = await prisma.encounterDiagnosis.findFirstOrThrow({
      where: { encounterId: encounter.id },
      select: { cie10Display: true },
    });
    expect(stored.cie10Display).toBe('Faringitis estreptocócica');
  });

  it('EN-042 la BASE rechaza un concepto cuya vigencia terminó el día ANTERIOR a la atención', async () => {
    /**
     * La prueba independiente que pide H3, escrita contra SQL crudo para que
     * lo que se demuestre sea el disparador y no la comprobación del
     * adaptador. La atención es del 14-08-2026 y el código dejó de regir el
     * 13: `daterange` es semiabierto, así que `[2019-01-01, 2026-08-14)` cubre
     * hasta el 13 inclusive.
     */
    const prisma = db();
    const { encounter } = await anEncounter(
      prisma,
      new Date('2026-08-14T14:00:00Z'),
    );
    const retired = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica (edición anterior)',
      validFrom: new Date('2019-01-01'),
      validTo: new Date('2026-08-14'),
    });

    const problem = await problemFrom(
      prisma.$executeRawUnsafe(
        `INSERT INTO encounter_diagnosis
           (encounter_id, concept_id, cie10_code, cie10_display, certainty, occurrence, rank)
         VALUES ($1::uuid, $2::uuid, 'J020', 'Faringitis estreptocócica (edición anterior)', 'DEFINITIVE', 'FIRST_TIME', 1)`,
        encounter.id,
        retired.id,
      ),
    );

    expect(problem?.code).toBe('INTEGRITY_RULE_FAILED');
    expect(problem?.status).toBe(422);
  });

  it('EN-042 el adaptador lo rechaza antes, con el código que el cliente puede leer', async () => {
    /**
     * ⚠️ EL ORDEN ES EL DE `NOTE_ALREADY_SIGNED`: el disparador es la garantía
     * —también para un import y un `psql`— y el adaptador es la FRASE. El
     * disparador levanta `integrity_constraint_violation` desde PL/pgSQL, así
     * que PostgreSQL no emite cláusula «violates … constraint "…"», el nombre
     * no viaja, y el mapeo sólo puede responder `INTEGRITY_RULE_FAILED` — que
     * no le dice al médico qué código elegir.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const retired = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica (edición anterior)',
      validFrom: new Date('2019-01-01'),
      validTo: new Date('2026-08-14'),
    });

    await expect(
      codingOf(prisma).addDiagnosis({
        encounterId: encounter.id,
        conceptId: retired.id,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites: [...sites],
      }),
    ).rejects.toMatchObject({ code: 'DIAGNOSIS_CONCEPT_NOT_IN_FORCE' });
  });

  it('EN-042 acepta el último día de vigencia aunque en UTC ya sea el siguiente', async () => {
    /**
     * ⚠️ LA RAZÓN DE SER DE `20260806040611_clinical_date_in_ecuador_timezone`.
     * La atención empieza a las 02:00 UTC del 15, que en Guayaquil son las
     * 21:00 del 14 — la franja vespertina de la consulta externa. Con un
     * `::date` desnudo la fecha clínica caería en el 15 y el diagnóstico se
     * rechazaría el último día en que el código regía.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(
      prisma,
      new Date('2026-08-15T02:00:00Z'),
    );
    const expiring = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
      // Semiabierto: rige hasta el 14 inclusive.
      validTo: new Date('2026-08-15'),
    });

    const diagnosis = await codingOf(prisma).addDiagnosis({
      encounterId: encounter.id,
      conceptId: expiring.id,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      sites: [...sites],
    });

    expect(diagnosis.cie10Code).toBe('J020');
  });

  it('EN-043 la BASE rechaza el segundo diagnóstico principal de una atención', async () => {
    const prisma = db();
    const { encounter } = await anEncounter(prisma);
    const first = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });
    const second = await aCie10Concept(prisma, {
      code: 'E119',
      display: 'Diabetes mellitus tipo 2',
      validFrom: new Date('2019-01-01'),
    });

    const insertPrimary = (conceptId: string, code: string, display: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO encounter_diagnosis
           (encounter_id, concept_id, cie10_code, cie10_display, certainty, occurrence, rank)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'DEFINITIVE', 'FIRST_TIME', 1)`,
        encounter.id,
        conceptId,
        code,
        display,
      );

    await insertPrimary(first.id, 'J020', 'Faringitis estreptocócica');

    const problem = await problemFrom(
      insertPrimary(second.id, 'E119', 'Diabetes mellitus tipo 2'),
    );

    // El nombre del índice parcial viaja y `encounter.constraints.ts` lo
    // traduce, así que el que escribe por otra vía recibe la misma frase.
    expect(problem?.code).toBe('DIAGNOSIS_PRIMARY_TAKEN');
    expect(problem?.status).toBe(409);
  });

  it('EN-043 el adaptador rechaza el segundo principal antes de llegar al índice', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const coding = codingOf(prisma);
    const first = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });
    const second = await aCie10Concept(prisma, {
      code: 'E119',
      display: 'Diabetes mellitus tipo 2',
      validFrom: new Date('2019-01-01'),
    });

    await coding.addDiagnosis({
      encounterId: encounter.id,
      conceptId: first.id,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      rank: 1,
      sites: [...sites],
    });

    await expect(
      coding.addDiagnosis({
        encounterId: encounter.id,
        conceptId: second.id,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        rank: 1,
        sites: [...sites],
      }),
    ).rejects.toMatchObject({ code: 'DIAGNOSIS_PRIMARY_TAKEN' });
  });

  it('EN-043 hace principal al primero y encola los siguientes cuando nadie dice el orden', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const coding = codingOf(prisma);

    for (const [code, display] of [
      ['J020', 'Faringitis estreptocócica'],
      ['E119', 'Diabetes mellitus tipo 2'],
      ['I10X', 'Hipertensión esencial'],
    ] as const) {
      const concept = await aCie10Concept(prisma, {
        code,
        display,
        validFrom: new Date('2019-01-01'),
      });
      await coding.addDiagnosis({
        encounterId: encounter.id,
        conceptId: concept.id,
        certainty: 'DEFINITIVE',
        occurrence: 'SUBSEQUENT',
        sites: [...sites],
      });
    }

    const diagnoses = await coding.diagnosesOf({
      encounterId: encounter.id,
      sites: [...sites],
    });

    expect(diagnoses.map((diagnosis) => diagnosis.rank)).toEqual([1, 2, 3]);
    expect(diagnoses[0]?.cie10Code).toBe('J020');
  });

  it('EN-047 admite un cuarto diagnóstico: el recorte a tres es de la exportación', async () => {
    /**
     * El formulario tiene tres casillas (columnas 83 a 94) y la historia
     * clínica no tiene por qué tenerlas. Limitar el expediente a tres porque
     * la hoja A3 tiene tres es dejar de registrar lo que el paciente tiene
     * para que quepa en el papel.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const coding = codingOf(prisma);

    for (const code of ['J020', 'E119', 'I10X', 'K297']) {
      const concept = await aCie10Concept(prisma, {
        code,
        display: `Diagnóstico ${code}`,
        validFrom: new Date('2019-01-01'),
      });
      await coding.addDiagnosis({
        encounterId: encounter.id,
        conceptId: concept.id,
        certainty: 'DEFINITIVE',
        occurrence: 'SUBSEQUENT',
        sites: [...sites],
      });
    }

    const diagnoses = await coding.diagnosesOf({
      encounterId: encounter.id,
      sites: [...sites],
    });
    expect(diagnoses).toHaveLength(4);
  });

  it('EN-046 clasifica el mismo encuentro como prevención Y morbilidad, uno por diagnóstico', async () => {
    /**
     * Se controla el embarazo (Z34) y además se trata una faringitis (J02) en
     * la misma consulta. Con la marca en la atención hay que elegir una y
     * mentir en la otra, y las columnas 84 y 85 del formulario piden las dos.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const coding = codingOf(prisma);

    for (const [code, display] of [
      ['Z349', 'Supervisión de embarazo normal'],
      ['J020', 'Faringitis estreptocócica'],
    ] as const) {
      const concept = await aCie10Concept(prisma, {
        code,
        display,
        validFrom: new Date('2019-01-01'),
      });
      await coding.addDiagnosis({
        encounterId: encounter.id,
        conceptId: concept.id,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites: [...sites],
      });
    }

    const diagnoses = await coding.diagnosesOf({
      encounterId: encounter.id,
      sites: [...sites],
    });

    expect(
      diagnoses.map((diagnosis) => [
        diagnosis.cie10Code,
        diagnosis.careModality,
      ]),
    ).toEqual([
      ['Z349', 'PREVENTION'],
      ['J020', 'MORBIDITY'],
    ]);
    // Y la atención sigue diciendo a qué vino el paciente: EN-046 no la borra,
    // le quita el gobierno del reporte.
    expect(encounter.careModality).toBe('MORBIDITY');
  });

  it('EN-048 admite los códigos de planificación familiar de cinco caracteres', async () => {
    /**
     * `encounter_diagnosis.cie10_code` es `VarChar(10)`, así que la columna
     * aguanta los dieciséis códigos adaptados para Ecuador. Lo que falta es
     * que estén EN EL CATÁLOGO: la CIE-10 estándar no los trae y sin fila no
     * hay concepto al que apuntar. Eso es carga de catálogo, no esquema.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const concept = await aCie10Concept(prisma, {
      code: 'Z3041',
      display: 'Supervisión de uso de anticonceptivos orales combinados',
      validFrom: new Date('2019-01-01'),
    });

    const diagnosis = await codingOf(prisma).addDiagnosis({
      encounterId: encounter.id,
      conceptId: concept.id,
      certainty: 'DEFINITIVE',
      occurrence: 'SUBSEQUENT',
      sites: [...sites],
    });

    expect(diagnosis.cie10Code).toBe('Z3041');
    expect(diagnosis.careModality).toBe('PREVENTION');
  });

  it('EN-040 rechaza un concepto que no es de la CIE-10, que la clave foránea sí aceptaría', async () => {
    /**
     * ⚠️ EL AGUJERO QUE NADIE MIRA. `concept_id` apunta a `catalog_concept`,
     * que guarda TODOS los catálogos: la clave demuestra que la fila existe y
     * nada sobre qué clase de cosa es, y `trg_diagnosis_snapshot` aceptaría
     * una parroquia del DPA sin protestar, porque el código congelado coincide
     * con el concepto perfectamente.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const parish = await aCie10Concept(
      prisma,
      {
        code: '170150',
        display: 'Quito Distrito Metropolitano',
        validFrom: new Date('2019-01-01'),
      },
      'DPA',
    );

    await expect(
      codingOf(prisma).addDiagnosis({
        encounterId: encounter.id,
        conceptId: parish.id,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites: [...sites],
      }),
    ).rejects.toMatchObject({ code: 'CONCEPT_WRONG_CATALOGUE' });
  });

  it('EN-121 no devuelve los diagnósticos de una atención de otra sede', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const concept = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });
    const coding = codingOf(prisma);

    await coding.addDiagnosis({
      encounterId: encounter.id,
      conceptId: concept.id,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      sites: [...sites],
    });

    const fromElsewhere = await coding.diagnosesOf({
      encounterId: encounter.id,
      sites: [otherSite.id],
    });
    expect(fromElsewhere).toEqual([]);
  });
});

describe('los procedimientos de la atención', () => {
  it('EN-050 registra el procedimiento con su código del tarifario y su cantidad', async () => {
    /**
     * El ejemplo del propio instructivo: dos exodoncias en la misma atención.
     * «Por cada procedimiento se genera una o más actividades las cuales debe
     * registrar la cantidad realizada» — columnas 95 a 100 del formulario.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const service = await aCie10Concept(
      prisma,
      {
        code: '23.09',
        display: 'Extracción dental',
        validFrom: new Date('2018-01-01'),
      },
      'TARIFF',
    );

    const procedure = await codingOf(prisma).addProcedure({
      encounterId: encounter.id,
      conceptId: service.id,
      quantity: 2,
      sites: [...sites],
    });

    expect(procedure.procedureCode).toBe('23.09');
    expect(procedure.procedureDisplay).toBe('Extracción dental');
    expect(procedure.quantity).toBe(2);
  });

  it('EN-050 rechaza un concepto que no es del tarifario', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const diagnosisConcept = await aCie10Concept(prisma, {
      code: 'J020',
      display: 'Faringitis estreptocócica',
      validFrom: new Date('2019-01-01'),
    });

    await expect(
      codingOf(prisma).addProcedure({
        encounterId: encounter.id,
        conceptId: diagnosisConcept.id,
        quantity: 1,
        sites: [...sites],
      }),
    ).rejects.toMatchObject({ code: 'CONCEPT_WRONG_CATALOGUE' });
  });

  it('EN-051 no escribe ningún importe en la fila clínica', async () => {
    /**
     * ⚠️ `encounter_procedure.tariff_amount` EXISTE Y ESTE MÓDULO NO LO TOCA,
     * y la ausencia es el requisito. Congelar un importe dentro de una tabla
     * clínica choca con la separación «lo clínico no es lo económico» sobre la
     * que está construido `billing`: lo que cuesta el procedimiento es un
     * `charge_item`, resuelto por la lista de precios del pagador en la fecha
     * del servicio, y el Tarifario aporta la NOMENCLATURA — su alcance lo
     * estrechó el A.M. 0046-2017 a las relaciones dentro de la Red Pública.
     *
     * La columna queda como deuda declarada, no se propaga.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const service = await aCie10Concept(
      prisma,
      {
        code: '23.09',
        display: 'Extracción dental',
        validFrom: new Date('2018-01-01'),
      },
      'TARIFF',
    );

    const procedure = await codingOf(prisma).addProcedure({
      encounterId: encounter.id,
      conceptId: service.id,
      quantity: 1,
      sites: [...sites],
    });

    const [row] = await prisma.$queryRawUnsafe<
      { tariff_amount: string | null }[]
    >(
      `SELECT tariff_amount::text AS tariff_amount
         FROM encounter_procedure WHERE id = $1::uuid`,
      procedure.id,
    );
    expect(row?.tariff_amount).toBeNull();
    expect(Object.keys(procedure)).not.toContain('tariffAmount');
  });

  it('EN-050 guarda el instante del ACTO y no el del tecleo', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const service = await aCie10Concept(
      prisma,
      {
        code: '23.09',
        display: 'Extracción dental',
        validFrom: new Date('2018-01-01'),
      },
      'TARIFF',
    );

    const performedAt = new Date('2026-08-14T15:20:00Z');
    const procedure = await codingOf(prisma).addProcedure({
      encounterId: encounter.id,
      conceptId: service.id,
      quantity: 1,
      performedAt,
      sites: [...sites],
    });

    expect(procedure.performedAt.toISOString()).toBe(performedAt.toISOString());
  });

  it('EN-151 registra un procedimiento de rutina sin ningún consentimiento suscrito', async () => {
    /**
     * ⚠️ SE ESCRIBE COMO PRUEBA DE UNA AUSENCIA PORQUE EL FALLO ES CONSTRUIR
     * DE MÁS. El A.M. 5316 §7.6.d es textual: «no se requiere un
     * consentimiento informado suscrito en las intervenciones de riesgo
     * mínimo». Una barrera aquí entrena a todo el mundo a hacer clic sin leer,
     * y entonces el consentimiento que sí importa —el del riesgo mayor,
     * EN-152— se firma con el mismo automatismo.
     */
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const service = await aCie10Concept(
      prisma,
      {
        code: '90.59',
        display: 'Examen de orina',
        validFrom: new Date('2018-01-01'),
      },
      'TARIFF',
    );

    const procedure = await codingOf(prisma).addProcedure({
      encounterId: encounter.id,
      conceptId: service.id,
      quantity: 1,
      sites: [...sites],
    });

    expect(procedure.id).toBeTruthy();
  });
});

/**
 * The half of block K that CANNOT be built yet, proved to be missing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A TEST AND NOT ONLY A NOTE IN THE SPEC
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Seven requirements of H3 name a datum the schema does not have. A note in
 * prose stops being true within weeks and nobody notices; this fails the day
 * the column or the table lands, and the failure message names the requirement
 * that is then implementable. It is the same instinct as
 * `spec-traceability.spec.ts`: a promise with no proof is not a promise.
 *
 * DELETE EACH LINE AS ITS HALF ARRIVES — and implement the requirement in the
 * same commit.
 */
describe('lo que el bloque K todavía no puede guardar', () => {
  const columnsOf = (prisma: PrismaClient, table: string) =>
    prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      table,
    );

  it('EN-044 y EN-046 siguen sin la condición de cuatro valores ni la marca por diagnóstico', async () => {
    const prisma = db();

    /**
     * EN-044: `diagnosis_certainty` tiene DOS valores y el instructivo tiene
     * cuatro — presuntivo, definitivo inicial, definitivo inicial confirmado
     * por laboratorio y definitivo control. Colapsarlos hace que dos casillas
     * del reporte salgan siempre iguales: el 4 distingue el control del
     * crónico y el 3 es el que mira la vigilancia epidemiológica.
     */
    const certainty = await prisma.$queryRawUnsafe<{ label: string }[]>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'diagnosis_certainty'`,
    );
    expect(
      certainty.map((row) => row.label).sort(),
      'Llegaron los cuatro valores del instructivo: implemente EN-044',
    ).toEqual(['DEFINITIVE', 'PRESUMPTIVE']);

    /**
     * EN-046: prevención/morbilidad se DERIVA del código Z00–Z99 y se sirve,
     * pero no se almacena. Es suficiente para una pantalla y no para la
     * exportación, que necesita un `WHERE` que un índice pueda responder.
     */
    const diagnosis = (await columnsOf(prisma, 'encounter_diagnosis')).map(
      (row) => row.column_name,
    );
    expect(
      diagnosis,
      'Llegó la columna de prevención/morbilidad por diagnóstico: implemente EN-046',
    ).not.toContain('care_modality');
  });

  it('EN-049 sigue sin poder deducir la notificación obligatoria del concepto', async () => {
    /**
     * `encounter_diagnosis.notifiable` existe; lo que no existe es DE DÓNDE
     * sale. La lista del MSP tiene que ser propiedad del CONCEPTO para que la
     * marca la ponga el sistema y no la memoria del médico — un dengue que
     * nadie marca no se notifica.
     */
    const prisma = db();
    const concept = (await columnsOf(prisma, 'catalog_concept')).map(
      (row) => row.column_name,
    );

    expect(
      concept,
      'El concepto ya sabe si es notificable: derive la marca y cierre EN-049',
    ).not.toContain('notifiable');
  });

  it('EN-040 sigue sin el dato para comprobar la coherencia con el sexo y la edad', async () => {
    /**
     * ⚠️ **Falta esquema**, y se escribe en vez de aproximarlo. Un diagnóstico
     * obstétrico en un paciente masculino y uno neonatal en un adulto son
     * rechazables SÓLO si el catálogo dice a quién aplica cada código, y para
     * la CIE-10 `catalog_concept.attributes` guarda `{ level, chapter }` y
     * nada más. Deducirlo del capítulo rechazaría diagnósticos reales —el
     * capítulo XV trae códigos que se codifican legítimamente en la ficha de
     * un recién nacido—, así que la regla espera al dato.
     */
    const prisma = db();
    const system = await prisma.catalogSystem.upsert({
      where: { code: 'CIE10' },
      create: { code: 'CIE10', name: 'CIE-10 Ecuador' },
      update: {},
    });
    const concept = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'O800',
        display: 'Parto único espontáneo',
        validFrom: new Date('2019-01-01'),
        attributes: { level: 4, chapter: 'O' },
      },
      select: { attributes: true },
    });

    expect(
      Object.keys(concept.attributes as Record<string, unknown>).sort(),
      'El concepto ya dice a qué sexo y a qué edad aplica: implemente la coherencia de EN-040',
    ).toEqual(['chapter', 'level']);
  });

  it('EN-052 sigue sin columnas para los índices CEO-D y CPO-D', async () => {
    /**
     * Columnas 101 a 104 del formulario, restringidas por el instructivo a
     * «profesionales con especialidad odontólogo y odontólogo rural». Los
     * rangos de edad se evalúan con la EDAD CONGELADA de EN-008, nunca con la
     * de hoy.
     */
    const prisma = db();
    const encounter = (await columnsOf(prisma, 'encounter')).map(
      (row) => row.column_name,
    );

    expect(
      encounter.filter((name) => /ceo|cpo|decay|caries/i.test(name)),
      'Llegaron los índices odontológicos: implemente EN-052',
    ).toEqual([]);
  });

  it('EN-152, EN-153 y EN-154 siguen sin tabla de consentimiento informado', async () => {
    /**
     * Faltan las DOS mitades: la clasificación de riesgo en el catálogo de
     * prestaciones —que es lo que decide si hace falta consentimiento— y la
     * tabla del formulario 024, atado AL PROCEDIMIENTO y no a la atención,
     * porque el A.M. 5316 define el consentimiento como un proceso de
     * comunicación sobre una intervención concreta. Con ellas llegan también
     * la negativa (EN-153) y la revocación (EN-154), que nunca borra el
     * consentimiento revocado.
     *
     * ⚠️ EN-151 SÍ ESTÁ CUMPLIDO Y LO ESTÁ POR AUSENCIA: nada exige
     * consentimiento suscrito para un procedimiento de riesgo mínimo.
     */
    const prisma = db();
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );

    // NOT the consent to process personal data (LOPDP), which is a different
    // thing with its own module: `privacy` (PD-001..PD-017) owns these two,
    // and neither is the form 024 bound to a procedure that this guards.
    const DATA_PROTECTION_CONSENT = new Set([
      'consent_text_version',
      'patient_consent',
    ]);
    expect(
      tables
        .map((row) => row.tablename)
        .filter((name) => !DATA_PROTECTION_CONSENT.has(name))
        .filter((name) => /consent|consentimiento/i.test(name)),
      'Llegó la tabla del consentimiento: implemente EN-152, EN-153 y EN-154',
    ).toEqual([]);
  });
});
