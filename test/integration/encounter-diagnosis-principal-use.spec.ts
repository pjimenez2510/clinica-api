import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaClinicalCodingRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-coding.repository';
import '../../src/modules/encounter/infrastructure/encounter.constraints';
import {
  DomainError,
  ValidationError,
} from '../../src/shared/domain/errors/domain-error';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-235 (D-147.3) against a real PostgreSQL: an asterisk or an external
 * cause is never the principal diagnosis.
 *
 * `trg_encounter_diagnosis_principal_use` is the guarantee, exercised through
 * raw SQL — an import, a `psql` — and through the repository, which is how the
 * application reaches it. Each refusal has its positive control: the same
 * code as a secondary diagnosis goes in, a PRINCIPAL code goes in as rank 1,
 * and a concept with no `use` is not judged.
 */
const db = useDatabase();

const codingOf = (prisma: PrismaClient) =>
  new PrismaClinicalCodingRepository(prisma as unknown as PrismaService);

/** Stamps from the test's clock, one second apart and in order. */
let tick = 0;
const nextStamp = () => new Date(Date.now() + (tick += 1) * 1000);

type Use = 'PRINCIPAL' | 'ASTERISK' | 'EXTERNAL_CAUSE';

/** A WHO CIE-10 concept with its `use`, or without one (the old edition). */
async function aConcept(prisma: PrismaClient, code: string, use?: Use) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: 'CIE10' },
    create: { code: 'CIE10', name: 'CIE-10' },
    update: {},
  });
  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code,
      display: `Diagnóstico ${code}`,
      validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      attributes: use === undefined ? { level: 3 } : { level: 3, use },
    },
  });
}

async function anEncounter(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const editor = await createUser(prisma);
  return { encounter, sites: [site.id], editor };
}

/** A raw INSERT, the way an import writes. */
function insert(
  prisma: PrismaClient,
  encounterId: string,
  concept: { id: string; code: string; display: string },
  rank: number,
) {
  return prisma.$executeRaw`
    INSERT INTO encounter_diagnosis
      (encounter_id, concept_id, cie10_code, cie10_display, certainty, occurrence, rank)
    VALUES (${encounterId}::uuid, ${concept.id}::uuid, ${concept.code},
            ${concept.display}, 'DEFINITIVE', 'FIRST_TIME', ${rank})`;
}

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return extractDatabaseProblem(error) ?? domainProblemOf(error);
  }
  throw new Error('the operation should have failed');
}

/**
 * The adapter asks first and throws the catalogued error (EN-235): the same
 * code, status and field error the constraint mapping gives.
 */
function domainProblemOf(error: unknown) {
  if (!(error instanceof DomainError)) throw error;
  return {
    status: error instanceof ValidationError ? 422 : undefined,
    code: error.code,
    errors: error.fieldErrors,
  };
}

const REFUSED = {
  status: 422,
  code: 'DIAGNOSIS_PRINCIPAL_USE_INVALID',
  errors: [
    {
      field: 'conceptId',
      code: 'DIAGNOSIS_PRINCIPAL_USE_INVALID',
      message: 'Registre primero la enfermedad o la lesión',
    },
  ],
};

describe('EN-235 lo que no puede ser el diagnóstico principal', () => {
  it('EN-235 la BASE rechaza un asterisco y una causa externa como rango 1 al insertar, y los admite como rango 2', async () => {
    const prisma = db();
    const { encounter } = await anEncounter(prisma);
    const asterisk = await aConcept(prisma, 'G63.2', 'ASTERISK');
    const external = await aConcept(prisma, 'W19.0', 'EXTERNAL_CAUSE');

    expect(await problemFrom(insert(prisma, encounter.id, asterisk, 1))).toMatchObject(REFUSED); // prettier-ignore
    expect(await problemFrom(insert(prisma, encounter.id, external, 1))).toMatchObject(REFUSED); // prettier-ignore
    expect(await prisma.encounterDiagnosis.count()).toBe(0);

    // Positive control: behind the principal, both go in.
    await insert(prisma, encounter.id, asterisk, 2);
    await insert(prisma, encounter.id, external, 3);
    expect(await prisma.encounterDiagnosis.count()).toBe(2);
  });

  it('EN-235 la BASE admite como rango 1 un código PRINCIPAL y un concepto sin `use`, que no se juzga', async () => {
    const prisma = db();
    const first = await anEncounter(prisma);
    const second = await anEncounter(prisma);

    await insert(prisma, first.encounter.id, await aConcept(prisma, 'S52.5', 'PRINCIPAL'), 1); // prettier-ignore
    await insert(prisma, second.encounter.id, await aConcept(prisma, 'J02.9'), 1); // prettier-ignore

    expect(
      await prisma.encounterDiagnosis.findMany({
        where: { rank: 1 },
        select: { cie10Code: true },
        orderBy: { cie10Code: 'asc' },
      }),
    ).toEqual([{ cie10Code: 'J02.9' }, { cie10Code: 'S52.5' }]);
  });

  it('EN-235 la BASE rechaza pasar a rango 1 un asterisco, y cambiar el principal a un código de causa externa', async () => {
    const prisma = db();
    const { encounter, editor } = await anEncounter(prisma);
    const principal = await aConcept(prisma, 'S52.5', 'PRINCIPAL');
    const asterisk = await aConcept(prisma, 'G63.2', 'ASTERISK');
    const external = await aConcept(prisma, 'W19.0', 'EXTERNAL_CAUSE');
    await insert(prisma, encounter.id, asterisk, 2);
    const secondary = await prisma.encounterDiagnosis.findFirstOrThrow({ where: { rank: 2 } }); // prettier-ignore

    const promote = (id: string) => prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET rank = 1, edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${id}::uuid`;
    expect(await problemFrom(promote(secondary.id))).toMatchObject(REFUSED);

    await insert(prisma, encounter.id, principal, 1);
    const head = await prisma.encounterDiagnosis.findFirstOrThrow({ where: { rank: 1 } }); // prettier-ignore
    const recode = (
      id: string,
      concept: { id: string; code: string; display: string },
    ) => prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET concept_id = ${concept.id}::uuid, cie10_code = ${concept.code},
             cie10_display = ${concept.display},
             edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${id}::uuid`;
    expect(await problemFrom(recode(head.id, external))).toMatchObject(REFUSED);
    expect(
      (await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: head.id } })).cie10Code, // prettier-ignore
    ).toBe('S52.5');

    // Positive control: the same recoding on the secondary goes through.
    await recode(secondary.id, external);
    expect(
      (await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: secondary.id } })).cie10Code, // prettier-ignore
    ).toBe('W19.0');
  });

  it('EN-235 un principal anterior a la regla sigue como está mientras no se toque su rango ni su código', async () => {
    const prisma = db();
    const { encounter, editor } = await anEncounter(prisma);
    // Coded before the WHO edition said what it was used for.
    const concept = await aConcept(prisma, 'G63.2');
    await insert(prisma, encounter.id, concept, 1);
    await prisma.catalogConcept.update({
      where: { id: concept.id },
      data: { attributes: { level: 3, use: 'ASTERISK' } },
    });
    const head = await prisma.encounterDiagnosis.findFirstOrThrow();

    await prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET certainty = 'PRESUMPTIVE', rank = 1, concept_id = ${concept.id}::uuid,
             edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${head.id}::uuid`;
    expect(
      await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: head.id } }),
    ).toMatchObject({ rank: 1, certainty: 'PRESUMPTIVE' }); // prettier-ignore
  });

  it('EN-235 el adaptador: el primer diagnóstico sin rango no entra como principal si es de causa externa; detrás del principal, sí, y no puede ser principal', async () => {
    const prisma = db();
    const { encounter, sites } = await anEncounter(prisma);
    const external = await aConcept(prisma, 'W19.0', 'EXTERNAL_CAUSE');
    const principal = await aConcept(prisma, 'S52.5', 'PRINCIPAL');
    const record = (conceptId: string) =>
      codingOf(prisma).addDiagnosis({
        encounterId: encounter.id,
        conceptId,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites,
      });

    expect(await problemFrom(record(external.id))).toMatchObject(REFUSED);

    const lesion = await record(principal.id);
    const cause = await record(external.id);
    expect([lesion, cause].map((d) => [d.cie10Code, d.rank, d.mayBePrincipal])).toEqual([
      ['S52.5', 1, true],
      ['W19.0', 2, false],
    ]); // prettier-ignore
  });

  it('EN-235 el adaptador: marcar principal o cambiar a asterisco el código del principal se rechaza sin cambiar nada', async () => {
    const prisma = db();
    const { encounter, sites, editor } = await anEncounter(prisma);
    const principal = await aConcept(prisma, 'S52.5', 'PRINCIPAL');
    const asterisk = await aConcept(prisma, 'H36.0', 'ASTERISK');
    const coding = codingOf(prisma);
    const base = { encounterId: encounter.id, certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME', sites } as const; // prettier-ignore
    const lesion = await coding.addDiagnosis({ ...base, conceptId: principal.id }); // prettier-ignore
    const companion = await coding.addDiagnosis({ ...base, conceptId: asterisk.id }); // prettier-ignore
    const authority = { editedById: editor.id, mayCorrectAfterDischarge: true, sites }; // prettier-ignore

    expect(
      await problemFrom(coding.makePrimary({ ...authority, encounterId: encounter.id, diagnosisId: companion.id })), // prettier-ignore
    ).toMatchObject(REFUSED);
    expect(
      await problemFrom(coding.editDiagnosis({ ...authority, encounterId: encounter.id, diagnosisId: companion.id, primary: true, reason: null })), // prettier-ignore
    ).toMatchObject(REFUSED);
    expect(
      await problemFrom(coding.editDiagnosis({ ...authority, encounterId: encounter.id, diagnosisId: lesion.id, conceptId: asterisk.id, reason: null })), // prettier-ignore
    ).toMatchObject(REFUSED);

    const sheet = await coding.diagnosesOf({
      encounterId: encounter.id,
      sites,
    });
    expect(sheet.map((d) => [d.cie10Code, d.rank])).toEqual([
      ['S52.5', 1],
      ['H36.0', 2],
    ]);
    // Nothing was versioned: the refused edits left no trace.
    expect(await prisma.recordVersion.count({ where: { resourceType: 'encounter_diagnosis' } })).toBe(0); // prettier-ignore
  });

  it('EN-235 el adaptador deja editar la condición de un principal anterior a la regla, y no cambiarle el código a otro asterisco', async () => {
    const prisma = db();
    const { encounter, sites, editor } = await anEncounter(prisma);
    const concept = await aConcept(prisma, 'G63.2');
    const other = await aConcept(prisma, 'H36.0', 'ASTERISK');
    const coding = codingOf(prisma);
    const legacy = await coding.addDiagnosis({ encounterId: encounter.id, conceptId: concept.id, certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME', sites }); // prettier-ignore
    await prisma.catalogConcept.update({
      where: { id: concept.id },
      data: { attributes: { level: 3, use: 'ASTERISK' } },
    });
    const authority = { encounterId: encounter.id, diagnosisId: legacy.id, editedById: editor.id, mayCorrectAfterDischarge: true, reason: null, sites }; // prettier-ignore

    const edited = await coding.editDiagnosis({ ...authority, certainty: 'PRESUMPTIVE' }); // prettier-ignore
    expect(edited).toMatchObject({ rank: 1, certainty: 'PRESUMPTIVE', mayBePrincipal: false }); // prettier-ignore
    expect(await problemFrom(coding.editDiagnosis({ ...authority, conceptId: other.id }))).toMatchObject(REFUSED); // prettier-ignore
  });

  it('EN-235 deshacer el quitar de un principal cuyo uso lo impide lo devuelve DETRÁS, sin error', async () => {
    const prisma = db();
    const { encounter, sites, editor } = await anEncounter(prisma);
    // A principal coded before the rule, whose concept the WHO list now marks.
    const concept = await aConcept(prisma, 'G63.2');
    const other = await aConcept(prisma, 'J02.9', 'PRINCIPAL');
    const coding = codingOf(prisma);
    const base = { encounterId: encounter.id, certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME', sites } as const; // prettier-ignore
    const legacy = await coding.addDiagnosis({
      ...base,
      conceptId: concept.id,
    });
    await coding.addDiagnosis({ ...base, conceptId: other.id });
    await prisma.catalogConcept.update({
      where: { id: concept.id },
      data: { attributes: { level: 3, use: 'ASTERISK' } },
    });
    await coding.retractDiagnosis({
      encounterId: encounter.id,
      diagnosisId: legacy.id,
      reason: null,
      retractedById: editor.id,
      mayCorrectAfterDischarge: true,
      sites,
    });

    // Positive control: the place of the principal is free.
    expect(await prisma.encounterDiagnosis.count({ where: { rank: 1 } })).toBe(0); // prettier-ignore

    const restored = await coding.restoreDiagnosis({
      encounterId: encounter.id,
      retractionId: legacy.id,
      restoredById: editor.id,
      sites,
    });
    expect(restored).toMatchObject({ cie10Code: 'G63.2', rank: 3, mayBePrincipal: false }); // prettier-ignore
  });

  it('EN-235 deshacer el quitar del único diagnóstico, si su uso impide el principal, lo devuelve como rango 2', async () => {
    const prisma = db();
    const { encounter, sites, editor } = await anEncounter(prisma);
    const concept = await aConcept(prisma, 'W19.0');
    const coding = codingOf(prisma);
    const only = await coding.addDiagnosis({ encounterId: encounter.id, conceptId: concept.id, certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME', sites }); // prettier-ignore
    await prisma.catalogConcept.update({
      where: { id: concept.id },
      data: { attributes: { level: 3, use: 'EXTERNAL_CAUSE' } },
    });
    await coding.retractDiagnosis({ encounterId: encounter.id, diagnosisId: only.id, reason: null, retractedById: editor.id, mayCorrectAfterDischarge: true, sites }); // prettier-ignore

    const restored = await coding.restoreDiagnosis({ encounterId: encounter.id, retractionId: only.id, restoredById: editor.id, sites }); // prettier-ignore
    expect(restored.rank).toBe(2);
  });

  it('EN-235 las versiones de un diagnóstico dicen si su concepto puede ser principal', async () => {
    const prisma = db();
    const { encounter, sites, editor } = await anEncounter(prisma);
    const external = await aConcept(prisma, 'W19.0', 'EXTERNAL_CAUSE');
    const asterisk = await aConcept(prisma, 'G63.2', 'ASTERISK');
    const principal = await aConcept(prisma, 'S52.5', 'PRINCIPAL');
    const coding = codingOf(prisma);
    const base = { encounterId: encounter.id, certainty: 'DEFINITIVE', occurrence: 'FIRST_TIME', sites } as const; // prettier-ignore
    await coding.addDiagnosis({ ...base, conceptId: principal.id });
    const cause = await coding.addDiagnosis({ ...base, conceptId: external.id }); // prettier-ignore
    await coding.editDiagnosis({ encounterId: encounter.id, diagnosisId: cause.id, conceptId: asterisk.id, reason: null, editedById: editor.id, mayCorrectAfterDischarge: true, sites }); // prettier-ignore

    const versions = await coding.diagnosisVersions({ encounterId: encounter.id, diagnosisId: cause.id, sites }); // prettier-ignore
    expect(versions.map((v) => [v.diagnosis.cie10Code, v.diagnosis.mayBePrincipal])).toEqual([['W19.0', false]]); // prettier-ignore
    const sheet = await coding.diagnosesOf({
      encounterId: encounter.id,
      sites,
    });
    expect(sheet.map((d) => [d.cie10Code, d.mayBePrincipal])).toEqual([
      ['S52.5', true],
      ['G63.2', false],
    ]);
  });
});
