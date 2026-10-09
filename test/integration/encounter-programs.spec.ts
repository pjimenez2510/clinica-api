import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { seedRdacaa } from '../../prisma/seed-rdacaa.mts';
import '../../src/modules/encounter/infrastructure/encounter.constraints';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-090 to EN-093, EN-249 against a real PostgreSQL: the triggers of blocks
 * G, H and I — who may have each block, the catalogues, the coherence of
 * vaccine and risk group — and the guard and the version every block shares.
 *
 * Every date derives from the attention's own clinical date, and the ages are
 * chosen away from the edge of a month, so the frozen age is the one named
 * whatever day the suite runs. Each refusal has its positive control on the
 * same path.
 */
const db = useDatabase();

/** The clinical date of an instant, and a calendar date `days` from it. */
function calendar(startedAt: Date) {
  const [y, m, d] = clinicalDateOf(startedAt).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return {
    year: y,
    month: m,
    day: d,
    plus: (days: number) => new Date(Date.UTC(y, m - 1, d + days)),
    iso: (days: number) =>
      new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10),
  };
}

/** An attention an hour ago, of a patient born `age` before it. */
async function anAttention(
  prisma: PrismaClient,
  options: {
    age?: { years: number; months?: number };
    sex?: 'MALE' | 'FEMALE';
  } = {},
) {
  const startedAt = new Date(Date.now() - 3_600_000);
  const cal = calendar(startedAt);
  const age = options.age ?? { years: 28 };
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma, {
    sex: options.sex ?? 'FEMALE',
    // The same day of the month: the frozen age is the completed months named.
    birthDate: new Date(
      Date.UTC(
        cal.year - age.years,
        cal.month - 1 - (age.months ?? 0),
        cal.day,
      ),
    ),
  });
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    startedAt,
  });
  const author = await createUser(prisma);
  return { encounter, patient, author, cal };
}

/** The chart's PREGNANT record from `fromDays` to `toDays` around the clinical date. */
async function pregnant(
  prisma: PrismaClient,
  scene: Awaited<ReturnType<typeof anAttention>>,
  fromDays: number,
  toDays: number,
) {
  await prisma.patientPriorityGroup.create({
    data: {
      patientId: scene.patient.id,
      groupCode: 'PREGNANT',
      startsOn: scene.cal.plus(fromDays),
      endsOn: scene.cal.plus(toDays),
      origin: 'SELF_DECLARED',
      recordedById: scene.author.id,
    },
  });
}

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return extractDatabaseProblem(error);
  }
  throw new Error('the operation should have failed');
}

async function discharge(prisma: PrismaClient, encounterId: string) {
  const encounter = await prisma.encounter.findUniqueOrThrow({
    where: { id: encounterId },
  });
  await prisma.encounter.update({
    where: { id: encounterId },
    data: {
      status: 'DISCHARGED',
      endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000),
      dischargeCondition: 'ALIVE',
    },
  });
}

const OBSTETRIC = {
  risk: 'LOW' as const,
  birthPlan: true,
  transportPlan: false,
  plannedPregnancy: true,
  gestationalAgeMethod: 'ULTRASOUND' as const,
  gestationalWeeks: 12,
};

const NOT_APPLICABLE = { status: 422, code: 'PROGRAM_BLOCK_NOT_APPLICABLE' };
const invalid = (field: string) => ({
  status: 422,
  code: 'VALIDATION_FAILED',
  errors: [expect.objectContaining({ field })],
});

describe('EN-090 EN-091 el bloque obstétrico contra la base', () => {
  it('EN-090 la BASE rechaza el bloque sin el embarazo en la ficha, o con uno que terminó antes; con el embarazo vigente entra', async () => {
    const prisma = db();
    const none = await anAttention(prisma);
    const ended = await anAttention(prisma);
    await pregnant(prisma, ended, -280, -1);
    const data = (scene: typeof none) => ({
      encounterId: scene.encounter.id,
      ...OBSTETRIC,
      recordedById: scene.author.id,
      recordedAt: new Date(),
    });

    expect(await problemFrom(prisma.encounterObstetric.create({ data: data(none) }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(prisma.encounterObstetric.create({ data: data(ended) }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore

    // Positive control: in force that day, both ends included.
    const today = await anAttention(prisma);
    await pregnant(prisma, today, 0, 0);
    await prisma.encounterObstetric.create({ data: data(today) });
    expect(await prisma.encounterObstetric.count()).toBe(1);
  });

  it('EN-090 la BASE acota las semanas a 1..42 y la FUM a la fecha clínica, y la exige con el método FUM', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);
    await pregnant(prisma, scene, -90, 150);
    const create = (extra: object) =>
      prisma.encounterObstetric.create({
        data: {
          encounterId: scene.encounter.id,
          ...OBSTETRIC,
          ...extra,
          recordedById: scene.author.id,
          recordedAt: new Date(),
        },
      });

    expect(await problemFrom(create({ gestationalWeeks: 0 }))).toMatchObject(invalid('gestationalWeeks')); // prettier-ignore
    expect(await problemFrom(create({ gestationalWeeks: 43 }))).toMatchObject(invalid('gestationalWeeks')); // prettier-ignore
    expect(await problemFrom(create({ gestationalAgeMethod: 'LMP' }))).toMatchObject(invalid('lastMenstrualPeriod')); // prettier-ignore
    expect(await problemFrom(create({ lastMenstrualPeriod: scene.cal.plus(1) }))).toMatchObject(invalid('lastMenstrualPeriod')); // prettier-ignore
    expect(await problemFrom(create({ lastMenstrualPeriod: scene.cal.plus(-301) }))).toMatchObject(invalid('lastMenstrualPeriod')); // prettier-ignore
    expect(await prisma.encounterObstetric.count()).toBe(0);

    // Positive control: the bounds themselves go in.
    await create({
      gestationalAgeMethod: 'LMP',
      lastMenstrualPeriod: scene.cal.plus(-300),
      gestationalWeeks: 42,
    });
    expect(await prisma.encounterObstetric.count()).toBe(1);
  });

  it('EN-091 la BASE guarda «sin dato» y «no se hizo» como valores, no como vacío', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);
    await pregnant(prisma, scene, -90, 150);
    await prisma.encounterObstetric.create({
      data: {
        encounterId: scene.encounter.id,
        ...OBSTETRIC,
        nonTreponemalTest: 'NO_DATA',
        treponemalTest: 'NEGATIVE',
        syphilisTreatment: 'NO_DATA',
        partnerTreatment: 'NOT_DONE',
        bacteriuria: 'NOT_DONE',
        recordedById: scene.author.id,
        recordedAt: new Date(),
      },
    });
    const [row] = await prisma.$queryRaw<{ non_treponemal_test: string; partner_treatment: string }[]>`
      SELECT non_treponemal_test::text, partner_treatment::text
        FROM encounter_obstetric WHERE encounter_id = ${scene.encounter.id}::uuid`; // prettier-ignore
    expect(row).toEqual({ non_treponemal_test: 'NO_DATA', partner_treatment: 'NOT_DONE' }); // prettier-ignore
  });
});

describe('EN-249 un bloque de programa se corrige con su versión, sólo con la atención viva, y no se borra', () => {
  it('EN-249 la BASE exige el sello al corregir y archiva la fila anterior entera en record_version', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);
    await pregnant(prisma, scene, -90, 150);
    const recordedAt = new Date();
    await prisma.encounterObstetric.create({
      data: { encounterId: scene.encounter.id, ...OBSTETRIC, recordedById: scene.author.id, recordedAt }, // prettier-ignore
    });
    const where = { encounterId: scene.encounter.id };

    await expect(
      prisma.encounterObstetric.update({ where, data: { risk: 'HIGH' } }),
    ).rejects.toThrow(/record_version_change_is_stamped/);
    // Nor does the author move with a correction.
    const other = await createUser(prisma);
    expect(await problemFrom(prisma.encounterObstetric.update({ where, data: { risk: 'HIGH', recordedById: other.id, editedById: other.id, editedAt: new Date(recordedAt.getTime() + 1000) } }))).toMatchObject({ code: 'VALIDATION_FAILED' }); // prettier-ignore

    // Positive control: stamped, it goes in and the previous row is kept.
    await prisma.encounterObstetric.update({
      where,
      data: { risk: 'HIGH', editedById: other.id, editedAt: new Date(recordedAt.getTime() + 1000) }, // prettier-ignore
    });
    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'encounter_obstetric', resourceId: scene.encounter.id }, // prettier-ignore
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.data).toMatchObject({ risk: 'LOW' });
  });

  it('EN-249 la BASE rechaza escribir un bloque con la atención de alta y borrarlo nunca; con la atención viva, entra', async () => {
    const prisma = db();
    const live = await anAttention(prisma, { age: { years: 0, months: 3 } });
    const answer = (scene: typeof live) => ({
      encounterId: scene.encounter.id,
      motherBreastfeeding: true,
      exclusiveBreastfeeding: true,
      recordedById: scene.author.id,
      recordedAt: new Date(),
    });
    // Positive control first: the attention is live.
    await prisma.encounterNutrition.create({ data: answer(live) });

    await expect(
      prisma.encounterNutrition.delete({ where: { encounterId: live.encounter.id } }), // prettier-ignore
    ).rejects.toThrow(/program_block_immutable/);

    const closed = await anAttention(prisma, { age: { years: 0, months: 3 } });
    await discharge(prisma, closed.encounter.id);
    await expect(
      prisma.encounterNutrition.create({ data: answer(closed) }),
    ).rejects.toThrow(/program_block_frozen/);
    await discharge(prisma, live.encounter.id);
    await expect(
      prisma.encounterNutrition.update({
        where: { encounterId: live.encounter.id },
        data: { motherBreastfeeding: false, editedById: live.author.id, editedAt: new Date(Date.now() + 1000) }, // prettier-ignore
      }),
    ).rejects.toThrow(/program_block_frozen/);
    expect(await prisma.encounterNutrition.count()).toBe(1);
  });
});

describe('EN-092 EN-097 el SIVAN contra la base, con la edad congelada', () => {
  const create = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof anAttention>>,
    answer: {
      exclusiveBreastfeeding?: boolean;
      complementaryFeeding?: boolean;
    },
  ) =>
    prisma.encounterNutrition.create({
      data: {
        encounterId: scene.encounter.id,
        motherBreastfeeding: true,
        ...answer,
        recordedById: scene.author.id,
        recordedAt: new Date(),
      },
    });

  it('EN-092 de 0 a 5 meses exige «sólo leche materna» y rechaza la del alimento sólido; de 6 a 8, al revés', async () => {
    const prisma = db();
    const four = await anAttention(prisma, { age: { years: 0, months: 4 } });
    const seven = await anAttention(prisma, { age: { years: 0, months: 7 } });

    expect(await problemFrom(create(prisma, four, {}))).toMatchObject(invalid('exclusiveBreastfeeding')); // prettier-ignore
    expect(await problemFrom(create(prisma, four, { exclusiveBreastfeeding: true, complementaryFeeding: false }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, seven, {}))).toMatchObject(invalid('complementaryFeeding')); // prettier-ignore
    expect(await problemFrom(create(prisma, seven, { exclusiveBreastfeeding: true, complementaryFeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterNutrition.count()).toBe(0);

    // Positive control: each with the question of its band.
    await create(prisma, four, { exclusiveBreastfeeding: true });
    await create(prisma, seven, { complementaryFeeding: true });
    expect(await prisma.encounterNutrition.count()).toBe(2);
  });

  it('EN-097 a los 9 meses y al año la BASE rechaza el bloque; a los 8, entra', async () => {
    const prisma = db();
    const nine = await anAttention(prisma, { age: { years: 0, months: 9 } });
    const year = await anAttention(prisma, { age: { years: 1, months: 1 } });
    const frozen = await prisma.encounter.findUniqueOrThrow({ where: { id: nine.encounter.id } }); // prettier-ignore
    // Nine months, or eight and some days at the start of a month.
    expect(frozen.ageYears).toBe(0);

    if (frozen.ageMonths === 9) {
      expect(await problemFrom(create(prisma, nine, { complementaryFeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    }
    expect(await problemFrom(create(prisma, year, { complementaryFeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore

    const eight = await anAttention(prisma, { age: { years: 0, months: 8 } });
    await create(prisma, eight, { complementaryFeeding: false });
    expect(
      await prisma.encounterNutrition.count({ where: { encounterId: eight.encounter.id } }), // prettier-ignore
    ).toBe(1);
  });
});

describe('EN-093 las vacunas contra la base, con el catálogo VACCINE', () => {
  const create = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof anAttention>>,
    doses: unknown,
    riskGroup: string | null = null,
  ) =>
    prisma.$executeRaw`
      INSERT INTO encounter_vaccination (encounter_id, doses, risk_group, recorded_by_id, recorded_at)
      VALUES (${scene.encounter.id}::uuid, ${JSON.stringify(doses)}::jsonb,
              ${riskGroup}::vaccine_risk_group, ${scene.author.id}::uuid, ${new Date()})`;

  it('EN-093 siembra las 19 vacunas del instructivo con su columna por código', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const vaccines = await prisma.catalogConcept.findMany({
      where: { system: { code: 'VACCINE' } },
      orderBy: { code: 'asc' },
    });
    expect(vaccines).toHaveLength(19);
    const byCode = new Map(vaccines.map((v) => [v.code, v.display]));
    expect(byCode.get('55')).toBe('BCG');
    expect(byCode.get('67')).toBe('dT adulto');
    expect(byCode.get('70')).toBe('HB adulto');
    expect(byCode.get('73')).toBe('Influenza');
  });

  it('EN-093 la BASE rechaza una vacuna fuera del catálogo, la misma dos veces o una dosis que no existe; las del catálogo entran', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const scene = await anAttention(prisma);

    expect(await problemFrom(create(prisma, scene, [{ code: '99', dose: 'FIRST' }]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, [{ code: '55', dose: 'FIRST' }, { code: '55', dose: 'SECOND' }]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, [{ code: '55', dose: 'EIGHTH' }]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, { code: '55' }))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await prisma.encounterVaccination.count()).toBe(0);

    // Positive control: BCG and pentavalente, which ask for no risk group.
    await create(prisma, scene, [
      { code: '55', dose: 'SINGLE' },
      { code: '60', dose: 'FIRST' },
    ]);
    expect(await prisma.encounterVaccination.count()).toBe(1);
  });

  it('EN-093 la BASE hace cumplir el grupo de riesgo de cada vacuna: lo exige, lo acota a los suyos y no lo admite donde no se pide', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const dT = [{ code: '67', dose: 'SECOND' }];
    const a = await anAttention(prisma);

    expect(await problemFrom(create(prisma, a, dT))).toMatchObject(invalid('riskGroup')); // prettier-ignore
    expect(await problemFrom(create(prisma, a, dT, 'TRAVELLER'))).toMatchObject(invalid('riskGroup')); // prettier-ignore
    expect(await problemFrom(create(prisma, a, [{ code: '55', dose: 'SINGLE' }], 'OTHER'))).toMatchObject(invalid('riskGroup')); // prettier-ignore
    // Together, the group has to fit every constrained vaccine: SR admits
    // travellers, dT does not.
    expect(await problemFrom(create(prisma, a, [...dT, { code: '69', dose: 'SINGLE' }], 'TRAVELLER'))).toMatchObject(invalid('riskGroup')); // prettier-ignore
    expect(await prisma.encounterVaccination.count()).toBe(0);

    // Positive controls: each with one of its own.
    await create(prisma, a, [...dT, { code: '69', dose: 'SINGLE' }], 'AGES_AT_RISK'); // prettier-ignore
    const b = await anAttention(prisma);
    await create(prisma, b, [{ code: '70', dose: 'FIRST' }], 'HEALTH_WORKER');
    const c = await anAttention(prisma);
    await create(prisma, c, dT, 'PREGNANT');
    expect(await prisma.encounterVaccination.count()).toBe(3);
  });

  it('EN-093 la BASE no admite embarazada ni puérpera en un hombre; en una mujer, sí', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const man = await anAttention(prisma, { sex: 'MALE' });
    const influenza = [{ code: '73', dose: 'SINGLE' }];

    expect(await problemFrom(create(prisma, man, influenza, 'PREGNANT'))).toMatchObject(invalid('riskGroup')); // prettier-ignore
    expect(await problemFrom(create(prisma, man, influenza, 'POSTPARTUM'))).toMatchObject(invalid('riskGroup')); // prettier-ignore

    await create(prisma, man, influenza, 'CHRONIC_DISEASE');
    const woman = await anAttention(prisma);
    await create(prisma, woman, influenza, 'POSTPARTUM');
    expect(await prisma.encounterVaccination.count()).toBe(2);
  });

  it('EN-093 la BASE rechaza una vacuna que el catálogo retiró antes de la fecha clínica', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const scene = await anAttention(prisma);
    // BCG, retired the day before the attention by a release of its own.
    await prisma.catalogConcept.updateMany({
      where: { system: { code: 'VACCINE' }, code: '55' },
      data: { validTo: scene.cal.plus(0) },
    });

    expect(await problemFrom(create(prisma, scene, [{ code: '55', dose: 'SINGLE' }]))).toMatchObject(invalid('doses')); // prettier-ignore
    // Positive control: one still in force.
    await create(prisma, scene, [{ code: '56', dose: 'SINGLE' }]);
    expect(await prisma.encounterVaccination.count()).toBe(1);
  });
});

describe('EN-094 EN-095 la prueba de VIH contra la base', () => {
  const create = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof anAttention>>,
    extra: object = {},
  ) =>
    prisma.encounterHivTest.create({
      data: {
        encounterId: scene.encounter.id,
        reason: 'VOLUNTARY',
        screeningDevice: 'RAPID_FOURTH_GENERATION',
        screeningResult: 'NON_REACTIVE',
        ...extra,
        recordedById: scene.author.id,
        recordedAt: new Date(),
      },
    });

  it('EN-094 la BASE rechaza la segunda prueba o la vía de transmisión sin una primera reactiva; con ella, entran', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);
    const confirmation = { confirmationDevice: 'ELISA' as const, confirmationResult: 'REACTIVE' as const }; // prettier-ignore
    const needsReactive = {
      status: 422,
      code: 'CONFIRMATORY_TEST_WITHOUT_SCREENING',
    };

    expect(await problemFrom(create(prisma, scene, confirmation))).toMatchObject(needsReactive); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, { transmissionRoute: 'SEXUAL' }))).toMatchObject(needsReactive); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, { screeningResult: 'REACTIVE', confirmationDevice: 'ELISA' }))).toMatchObject(invalid('confirmation')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, { cd4: -1 }))).toMatchObject(invalid('cd4')); // prettier-ignore
    expect(await prisma.encounterHivTest.count()).toBe(0);

    // Positive control: after a reactive screening.
    await create(prisma, scene, {
      screeningResult: 'REACTIVE',
      ...confirmation,
      transmissionRoute: 'SEXUAL',
      viralLoad: 12_000,
      cd4: 450,
    });
    expect(await prisma.encounterHivTest.count()).toBe(1);
  });

  it('EN-095 EN-249 la corrección archiva la anterior en su propia tabla y NUNCA en record_version; sin sello, no entra', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);
    await create(prisma, scene);
    const where = { encounterId: scene.encounter.id };

    expect(await problemFrom(prisma.encounterHivTest.update({ where, data: { reason: 'CAMPAIGN' } }))).toMatchObject({ code: 'VALIDATION_FAILED' }); // prettier-ignore

    // Positive control: stamped.
    await prisma.encounterHivTest.update({
      where,
      data: { reason: 'CAMPAIGN', editedById: scene.author.id, editedAt: new Date(Date.now() + 1000) }, // prettier-ignore
    });
    const versions = await prisma.encounterHivTestVersion.findMany({ where });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.data).toMatchObject({ reason: 'VOLUNTARY' });
    expect(await prisma.recordVersion.count({ where: { resourceId: scene.encounter.id } })).toBe(0); // prettier-ignore

    // The versions are not rewritten nor deleted; the test is never deleted.
    await expect(prisma.encounterHivTestVersion.deleteMany({ where })).rejects.toThrow(/insert_only/); // prettier-ignore
    await expect(prisma.encounterHivTest.delete({ where })).rejects.toThrow(/program_block_immutable/); // prettier-ignore
  });
});
