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
    // A day of the month no later than today's and never past the 28th, so
    // the month never overflows: the frozen age is exactly the months named.
    birthDate: new Date(
      Date.UTC(
        cal.year - age.years,
        cal.month - 1 - (age.months ?? 0),
        Math.min(cal.day, 28),
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

  /** The age the database froze, asserted: no bound is tested by luck. */
  async function aged(prisma: PrismaClient, months: number) {
    const scene = await anAttention(prisma, { age: { years: 0, months } });
    const frozen = await prisma.encounter.findUniqueOrThrow({ where: { id: scene.encounter.id } }); // prettier-ignore
    expect([frozen.ageYears, frozen.ageMonths]).toEqual([0, months]);
    return scene;
  }

  it('EN-092 a los 5 meses exige «sólo leche materna» y rechaza la del alimento sólido; a los 6, al revés', async () => {
    const prisma = db();
    const five = await aged(prisma, 5);
    const six = await aged(prisma, 6);

    expect(await problemFrom(create(prisma, five, {}))).toMatchObject(invalid('exclusiveBreastfeeding')); // prettier-ignore
    expect(await problemFrom(create(prisma, five, { exclusiveBreastfeeding: true, complementaryFeeding: false }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, six, {}))).toMatchObject(invalid('complementaryFeeding')); // prettier-ignore
    expect(await problemFrom(create(prisma, six, { exclusiveBreastfeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterNutrition.count()).toBe(0);

    // Positive control: each with the question of its band.
    await create(prisma, five, { exclusiveBreastfeeding: true });
    await create(prisma, six, { complementaryFeeding: true });
    expect(await prisma.encounterNutrition.count()).toBe(2);
  });

  it('EN-097 a los 9 meses y al año la BASE rechaza el bloque; a los 8, entra', async () => {
    const prisma = db();
    const nine = await aged(prisma, 9);
    const year = await anAttention(prisma, { age: { years: 1, months: 1 } });

    expect(await problemFrom(create(prisma, nine, { complementaryFeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, year, { complementaryFeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore

    const eight = await aged(prisma, 8);
    await create(prisma, eight, { complementaryFeeding: false });
    expect(await prisma.encounterNutrition.count()).toBe(1);
  });
});

describe('EN-260 la lactancia de la mujer de 10 a 49 años, en la columna 52 de su fila', () => {
  const create = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof anAttention>>,
    answer: { exclusiveBreastfeeding?: boolean; complementaryFeeding?: boolean } = {}, // prettier-ignore
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

  /** The age the database froze, asserted: no bound is tested by luck. */
  async function woman(
    prisma: PrismaClient,
    years: number,
    sex: 'MALE' | 'FEMALE' = 'FEMALE',
  ) {
    // prettier-ignore
    const scene = await anAttention(prisma, { age: { years, months: 3 }, sex });
    const frozen = await prisma.encounter.findUniqueOrThrow({ where: { id: scene.encounter.id } }); // prettier-ignore
    expect(frozen.ageYears).toBe(years);
    return scene;
  }

  it('EN-260 la BASE rechaza la lactancia a los 9 y a los 50 años, en un hombre, o con las preguntas del lactante; a los 10 y a los 49, entra', async () => {
    const prisma = db();
    const nine = await woman(prisma, 9);
    const fifty = await woman(prisma, 50);
    const man = await woman(prisma, 30, 'MALE');
    const withInfantQuestion = await woman(prisma, 30);

    expect(await problemFrom(create(prisma, nine))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, fifty))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, man))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, withInfantQuestion, { exclusiveBreastfeeding: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, withInfantQuestion, { complementaryFeeding: false }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterNutrition.count()).toBe(0);

    // Positive control: both ends of the range, with only column 52.
    await create(prisma, await woman(prisma, 10));
    await create(prisma, await woman(prisma, 49));
    await create(prisma, withInfantQuestion);
    expect(await prisma.encounterNutrition.count()).toBe(3);
  });
});

describe('EN-096 los suplementos contra la base, por la población de cada casilla', () => {
  type Supplements = {
    micronutrientPowder?: boolean;
    vitaminA?: boolean;
    ironSyrup?: boolean;
    ironFolicAcid?: boolean;
  };
  const create = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof anAttention>>,
    answer: Supplements,
  ) =>
    prisma.encounterSupplement.create({
      data: {
        encounterId: scene.encounter.id,
        ...answer,
        recordedById: scene.author.id,
        recordedAt: new Date(),
      },
    });

  /** The age the database froze, in completed months, asserted. */
  async function aged(
    prisma: PrismaClient,
    totalMonths: number,
    sex: 'MALE' | 'FEMALE' = 'FEMALE',
  ) {
    // prettier-ignore
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    const scene = await anAttention(prisma, { age: { years, months }, sex });
    const frozen = await prisma.encounter.findUniqueOrThrow({ where: { id: scene.encounter.id } }); // prettier-ignore
    expect([frozen.ageYears, frozen.ageMonths]).toEqual([years, months]);
    return scene;
  }

  it('EN-096 las chispas de 6 a 24 meses, la vitamina A de 6 a 59 y el hierro en jarabe de 24 a 59: fuera, la BASE las rechaza', async () => {
    const prisma = db();
    const five = await aged(prisma, 5);
    const twentyFive = await aged(prisma, 25);
    const twentyThree = await aged(prisma, 23);
    const sixty = await aged(prisma, 60);

    expect(await problemFrom(create(prisma, five, { micronutrientPowder: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, five, { vitaminA: false }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, twentyFive, { micronutrientPowder: false }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, twentyThree, { ironSyrup: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, sixty, { vitaminA: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, sixty, { ironSyrup: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterSupplement.count()).toBe(0);

    // Positive controls: the bounds themselves.
    await create(prisma, await aged(prisma, 6), { micronutrientPowder: true, vitaminA: true }); // prettier-ignore
    await create(prisma, await aged(prisma, 24), { micronutrientPowder: false, vitaminA: true, ironSyrup: true }); // prettier-ignore
    await create(prisma, await aged(prisma, 59), { vitaminA: false, ironSyrup: false }); // prettier-ignore
    expect(await prisma.encounterSupplement.count()).toBe(3);
  });

  it('EN-096 EN-260 el hierro con ácido fólico, a la embarazada y a la que dijo estar lactando; sin ninguno de los dos, no', async () => {
    const prisma = db();
    const neither = await anAttention(prisma, { age: { years: 28 } });
    const saidNo = await anAttention(prisma, { age: { years: 28 } });
    await prisma.encounterNutrition.create({ data: { encounterId: saidNo.encounter.id, motherBreastfeeding: false, recordedById: saidNo.author.id, recordedAt: new Date() } }); // prettier-ignore

    expect(await problemFrom(create(prisma, neither, { ironFolicAcid: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(create(prisma, saidNo, { ironFolicAcid: true }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterSupplement.count()).toBe(0);

    // Positive controls: pregnant on the chart that day; lactating by her own answer.
    const expecting = await anAttention(prisma, { age: { years: 28 } });
    await pregnant(prisma, expecting, -90, 150);
    await create(prisma, expecting, { ironFolicAcid: true });
    const lactating = await anAttention(prisma, { age: { years: 28 } });
    await prisma.encounterNutrition.create({ data: { encounterId: lactating.encounter.id, motherBreastfeeding: true, recordedById: lactating.author.id, recordedAt: new Date() } }); // prettier-ignore
    await create(prisma, lactating, { ironFolicAcid: false });
    expect(await prisma.encounterSupplement.count()).toBe(2);
  });

  it('EN-096 EN-249 se corrige con su versión y su sello, sólo con la atención viva, y nunca se borra', async () => {
    const prisma = db();
    const scene = await aged(prisma, 30);
    const recordedAt = new Date();
    await prisma.encounterSupplement.create({ data: { encounterId: scene.encounter.id, vitaminA: true, recordedById: scene.author.id, recordedAt } }); // prettier-ignore
    const where = { encounterId: scene.encounter.id };

    await expect(prisma.encounterSupplement.update({ where, data: { vitaminA: false } })).rejects.toThrow(/record_version_change_is_stamped/); // prettier-ignore
    await expect(prisma.encounterSupplement.delete({ where })).rejects.toThrow(/program_block_immutable/); // prettier-ignore

    // Positive control: stamped, it goes in and the previous row is kept.
    await prisma.encounterSupplement.update({ where, data: { vitaminA: false, editedById: scene.author.id, editedAt: new Date(recordedAt.getTime() + 1000) } }); // prettier-ignore
    const versions = await prisma.recordVersion.findMany({ where: { resourceType: 'encounter_supplement', resourceId: scene.encounter.id } }); // prettier-ignore
    expect(versions).toHaveLength(1);
    expect(versions[0]!.data).toMatchObject({ vitamin_a: true });

    await discharge(prisma, scene.encounter.id);
    await expect(prisma.encounterSupplement.update({ where, data: { vitaminA: true, editedById: scene.author.id, editedAt: new Date(recordedAt.getTime() + 2000) } })).rejects.toThrow(/program_block_frozen/); // prettier-ignore
  });
});

describe('EN-090 EN-093 la fecha clínica es la de Guayaquil, también a las 21:30', () => {
  /**
   * An attention yesterday at 21:30 in Guayaquil is already today in UTC
   * (02:30Z): the pregnancy that ended yesterday applies to it, the one that
   * starts today does not. Derived from the clock, never typed.
   */
  async function lateLastNight(prisma: PrismaClient) {
    const today = calendar(new Date());
    const startedAt = new Date(Date.UTC(today.year, today.month - 1, today.day, 2, 30)); // prettier-ignore
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const encounter = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id, startedAt }); // prettier-ignore
    const author = await createUser(prisma);
    // Its clinical date, the day before the UTC one.
    expect(clinicalDateOf(startedAt)).toBe(today.iso(-1));
    return { encounter, patient, author, cal: calendar(startedAt) };
  }

  it('EN-090 el embarazo que terminó el día local de la atención aplica; el que empieza el día UTC, no', async () => {
    const prisma = db();
    const endedYesterday = await lateLastNight(prisma);
    await pregnant(prisma, endedYesterday, -200, 0);
    const startsToday = await lateLastNight(prisma);
    await pregnant(prisma, startsToday, 1, 200);
    const data = (scene: typeof endedYesterday) => ({ encounterId: scene.encounter.id, ...OBSTETRIC, recordedById: scene.author.id, recordedAt: new Date() }); // prettier-ignore

    expect(await problemFrom(prisma.encounterObstetric.create({ data: data(startsToday) }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    await prisma.encounterObstetric.create({ data: data(endedYesterday) });
    expect(await prisma.encounterObstetric.count()).toBe(1);
  });

  it('EN-093 la vacuna retirada el día UTC sigue vigente el día local de la atención', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const scene = await lateLastNight(prisma);
    // Retired from the UTC day on: still in force on the local one.
    await prisma.catalogConcept.updateMany({
      where: { system: { code: 'VACCINE' }, code: '55' },
      data: { validTo: scene.cal.plus(1) },
    });
    await prisma.$executeRaw`
      INSERT INTO encounter_vaccination (encounter_id, doses, recorded_by_id, recorded_at)
      VALUES (${scene.encounter.id}::uuid, '[{"code":"55","dose":"SINGLE","riskGroup":null}]'::jsonb, ${scene.author.id}::uuid, ${new Date()})`; // prettier-ignore
    expect(await prisma.encounterVaccination.count()).toBe(1);
  });
});

describe('EN-249 cada bloque tiene su guarda en la base', () => {
  it('EN-249 obstétrico, vacunas y VIH: con la atención de alta la BASE no los escribe, y nunca los borra; vivos, entran', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const live = await anAttention(prisma);
    await pregnant(prisma, live, -90, 150);
    const closed = await anAttention(prisma);
    await pregnant(prisma, closed, -90, 150);
    await discharge(prisma, closed.encounter.id);

    const writes = (scene: typeof live) => [
      () => prisma.encounterObstetric.create({ data: { encounterId: scene.encounter.id, ...OBSTETRIC, recordedById: scene.author.id, recordedAt: new Date() } }), // prettier-ignore
      () => prisma.encounterVaccination.create({ data: { encounterId: scene.encounter.id, doses: [{ code: '55', dose: 'SINGLE', riskGroup: null }], recordedById: scene.author.id, recordedAt: new Date() } }), // prettier-ignore
      () => prisma.encounterHivTest.create({ data: { encounterId: scene.encounter.id, reason: 'VOLUNTARY', screeningDevice: 'ELISA', screeningResult: 'NON_REACTIVE', recordedById: scene.author.id, recordedAt: new Date() } }), // prettier-ignore
    ];
    for (const write of writes(closed)) {
      await expect(write()).rejects.toThrow(/program_block_frozen/);
    }
    // Positive control: live, the same three go in.
    for (const write of writes(live)) await write();

    const where = { encounterId: live.encounter.id };
    await expect(prisma.encounterObstetric.delete({ where })).rejects.toThrow(/program_block_immutable/); // prettier-ignore
    await expect(prisma.encounterVaccination.delete({ where })).rejects.toThrow(/program_block_immutable/); // prettier-ignore
    await expect(prisma.encounterHivTest.delete({ where })).rejects.toThrow(/program_block_immutable/); // prettier-ignore
    expect(await prisma.encounterHivTest.count()).toBe(1);
  });
});

describe('EN-093 las vacunas contra la base, con el catálogo VACCINE', () => {
  const create = (
    prisma: PrismaClient,
    scene: Awaited<ReturnType<typeof anAttention>>,
    doses: unknown,
  ) =>
    prisma.$executeRaw`
      INSERT INTO encounter_vaccination (encounter_id, doses, recorded_by_id, recorded_at)
      VALUES (${scene.encounter.id}::uuid, ${JSON.stringify(doses)}::jsonb,
              ${scene.author.id}::uuid, ${new Date()})`;
  /** A dose as the API writes it: the risk group inside, `null` when none. */
  const given = (code: string, dose: string, riskGroup: string | null = null) => ({ code, dose, riskGroup }); // prettier-ignore

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

    expect(await problemFrom(create(prisma, scene, [given('99', 'FIRST')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, [given('55', 'FIRST'), given('55', 'SECOND')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, [given('55', 'EIGHTH')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, { code: '55' }))).toMatchObject(invalid('doses')); // prettier-ignore
    // The old shape, without the dose's own risk group, or a group outside the catalogue.
    expect(await problemFrom(create(prisma, scene, [{ code: '55', dose: 'SINGLE' }]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, scene, [given('67', 'FIRST', 'ASTRONAUT')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await prisma.encounterVaccination.count()).toBe(0);

    // Positive control: BCG and pentavalente, which ask for no risk group.
    await create(prisma, scene, [given('55', 'SINGLE'), given('60', 'FIRST')]);
    expect(await prisma.encounterVaccination.count()).toBe(1);
  });

  it('EN-093 la BASE hace cumplir el grupo de riesgo de cada dosis: lo exige, lo acota a los de su vacuna y no lo admite donde no se pide', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const a = await anAttention(prisma);

    expect(await problemFrom(create(prisma, a, [given('67', 'SECOND')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, a, [given('67', 'SECOND', 'TRAVELLER')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, a, [given('55', 'SINGLE', 'OTHER')]))).toMatchObject(invalid('doses')); // prettier-ignore
    // Each dose with its own: SR as a traveller beside a dT without a group.
    expect(await problemFrom(create(prisma, a, [given('67', 'SECOND'), given('69', 'SINGLE', 'TRAVELLER')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await prisma.encounterVaccination.count()).toBe(0);

    // Positive controls: each dose with one of its own vaccine.
    await create(prisma, a, [given('67', 'SECOND', 'AGES_AT_RISK'), given('69', 'SINGLE', 'TRAVELLER')]); // prettier-ignore
    const b = await anAttention(prisma);
    await create(prisma, b, [given('70', 'FIRST', 'HEALTH_WORKER')]);
    const c = await anAttention(prisma);
    await create(prisma, c, [given('67', 'FIRST', 'PREGNANT')]);
    expect(await prisma.encounterVaccination.count()).toBe(3);
  });

  it('EN-093 D-195.8 a la trabajadora de salud se le registran dT adulto y HB adulto en la misma atención, cada dosis con su grupo', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const worker = await anAttention(prisma);
    // No group fits both: one per dose is the only way they go together.
    await create(prisma, worker, [given('67', 'FIRST', 'AGES_AT_RISK'), given('70', 'FIRST', 'HEALTH_WORKER')]); // prettier-ignore
    const row = await prisma.encounterVaccination.findUniqueOrThrow({ where: { encounterId: worker.encounter.id } }); // prettier-ignore
    expect(row.doses).toEqual([
      { code: '67', dose: 'FIRST', riskGroup: 'AGES_AT_RISK' },
      { code: '70', dose: 'FIRST', riskGroup: 'HEALTH_WORKER' },
    ]);
    // The attention carries no risk group of its own any more.
    const [column] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
       WHERE table_name = 'encounter_vaccination' AND column_name = 'risk_group'`;
    expect(column!.n).toBe(0n);
  });

  it('EN-093 la BASE no admite embarazada ni puérpera en un hombre; en una mujer, sí', async () => {
    const prisma = db();
    await seedRdacaa(prisma);
    const man = await anAttention(prisma, { sex: 'MALE' });

    expect(await problemFrom(create(prisma, man, [given('73', 'SINGLE', 'PREGNANT')]))).toMatchObject(invalid('doses')); // prettier-ignore
    expect(await problemFrom(create(prisma, man, [given('73', 'SINGLE', 'POSTPARTUM')]))).toMatchObject(invalid('doses')); // prettier-ignore

    await create(prisma, man, [given('73', 'SINGLE', 'CHRONIC_DISEASE')]);
    const woman = await anAttention(prisma);
    await create(prisma, woman, [given('73', 'SINGLE', 'POSTPARTUM')]);
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

    expect(await problemFrom(create(prisma, scene, [given('55', 'SINGLE')]))).toMatchObject(invalid('doses')); // prettier-ignore
    // Positive control: one still in force.
    await create(prisma, scene, [given('56', 'SINGLE')]);
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

  it('EN-094 la BASE no registra la vía de transmisión con la segunda prueba no reactiva; con ella reactiva o sin resultado, sí', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);
    const reactive = { screeningResult: 'REACTIVE' as const, transmissionRoute: 'SEXUAL' as const }; // prettier-ignore

    expect(await problemFrom(create(prisma, scene, { ...reactive, confirmationDevice: 'ELISA', confirmationResult: 'NON_REACTIVE' }))).toMatchObject({ status: 422, code: 'CONFIRMATORY_TEST_WITHOUT_SCREENING' }); // prettier-ignore
    expect(await prisma.encounterHivTest.count()).toBe(0);

    // Positive control: the instructivo's own example, the second result blank.
    await create(prisma, scene, reactive);
    expect(await prisma.encounterHivTest.count()).toBe(1);
  });

  it('EN-094 D-195.11 la BASE admite carga viral y CD4 con la primera prueba no reactiva (infección aguda, recién nacido expuesto), y acota su rango', async () => {
    const prisma = db();
    const scene = await anAttention(prisma);

    expect(await problemFrom(create(prisma, scene, { viralLoad: -1 }))).toMatchObject(invalid('viralLoad')); // prettier-ignore
    expect(await prisma.encounterHivTest.count()).toBe(0);

    // Positive control: the first test non-reactive, with no confirmation.
    await create(prisma, scene, { viralLoad: 250_000, cd4: 820 });
    const row = await prisma.encounterHivTest.findUniqueOrThrow({ where: { encounterId: scene.encounter.id } }); // prettier-ignore
    expect([row.screeningResult, row.viralLoad, row.cd4]).toEqual(['NON_REACTIVE', 250_000, 820]); // prettier-ignore
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
