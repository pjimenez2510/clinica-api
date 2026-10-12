import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaCie10Lookup } from '../../src/shared/infrastructure/clinical/prisma-cie10.lookup';
import { PrismaCodingContextReader } from '../../src/shared/infrastructure/clinical/prisma-coding-context.reader';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * AS-027, AS-035, AS-039 against PostgreSQL: what the assistant reads of an
 * attention and the catalogue barrier its codes go through. Every refusal
 * has its positive control through the same path.
 */
const db = useDatabase();

const DAY_MS = 86_400_000;

async function cie10System(prisma: PrismaClient) {
  return prisma.catalogSystem.upsert({
    where: { code: 'CIE10' },
    create: { code: 'CIE10', name: 'CIE-10', hierarchical: true },
    update: {},
  });
}

/** A WHO four-character code (level 3), in force from long before any test. */
async function whoCode(
  prisma: PrismaClient,
  code: string,
  display: string,
  validTo?: Date,
) {
  const system = await cie10System(prisma);
  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code,
      display,
      attributes: { level: 3, use: 'PRINCIPAL' },
      validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      validTo,
    },
  });
}

async function diagnose(
  prisma: PrismaClient,
  encounterId: string,
  concept: { id: string; code: string; display: string },
  rank: number,
  recordedAt?: Date,
) {
  await prisma.encounterDiagnosis.create({
    data: {
      encounterId,
      conceptId: concept.id,
      cie10Code: concept.code,
      cie10Display: concept.display,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      rank,
      ...(recordedAt ? { recordedAt } : {}),
    },
  });
}

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { site, practitioner, patient, encounter };
}

describe('the CIE-10 barrier (AS-035)', () => {
  it('AS-035 resolves the exact code, its plain form and a category through .X, and nothing else', async () => {
    const prisma = db();
    const lookup = new PrismaCie10Lookup(prisma as unknown as PrismaService);
    const pharyngitis = await whoCode(prisma, 'J02.9', 'Faringitis aguda, no especificada'); // prettier-ignore
    const hypertension = await whoCode(prisma, 'I10.X', 'Hipertensión esencial (primaria)'); // prettier-ignore
    const today = clinicalDateOf(new Date());

    const resolved = await lookup.resolveWritten(
      ['J02.9', 'j029', 'I10', 'J02.7', 'J02', 'faringitis', ''],
      today,
    );

    expect(resolved.map((entry) => entry?.code ?? null)).toEqual([
      'J02.9',
      'J02.9',
      'I10.X',
      // J02.7 does not exist; J02 has no .X; neither is a CIE-10 shape guess.
      null,
      null,
      null,
      null,
    ]);
    // The name is the catalogue's, and the concept is the one the record takes.
    expect(resolved[0]).toEqual({
      conceptId: pharyngitis.id,
      code: 'J02.9',
      display: 'Faringitis aguda, no especificada',
    });
    expect(resolved[2]!.conceptId).toBe(hypertension.id);
  });

  it('AS-035 a code retired before the clinical date does not resolve, and does before it', async () => {
    const prisma = db();
    const lookup = new PrismaCie10Lookup(prisma as unknown as PrismaService);
    const today = clinicalDateOf(new Date());
    await whoCode(
      prisma,
      'U07.1',
      'COVID-19, virus identificado',
      new Date(`${addDays(today, -10)}T00:00:00Z`),
    );

    expect(await lookup.resolveWritten(['U07.1'], today)).toEqual([null]);
    // Control: on a day it was in force, the same code resolves.
    const [then] = await lookup.resolveWritten(['U07.1'], addDays(today, -20));
    expect(then?.code).toBe('U07.1');
  });

  it('AS-035 a chapter or any code that is not selectable never resolves', async () => {
    const prisma = db();
    const lookup = new PrismaCie10Lookup(prisma as unknown as PrismaService);
    const system = await cie10System(prisma);
    await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'J45',
        display: 'Asma (no seleccionable)',
        attributes: { level: 2 },
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    });
    const today = clinicalDateOf(new Date());

    expect(await lookup.resolveWritten(['J45'], today)).toEqual([null]);
    // Control: the selectable code of the same category resolves.
    await whoCode(prisma, 'J45.9', 'Asma, no especificada');
    const [asthma] = await lookup.resolveWritten(['J45.9'], today);
    expect(asthma?.code).toBe('J45.9');
  });
});

describe('what the assistant reads of an attention (AS-027, AS-028, AS-039)', () => {
  it('AS-039 an attention of another site reads as absent, and of its own site as itself', async () => {
    const prisma = db();
    const reader = new PrismaCodingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { site, practitioner, encounter } = await anAttention(prisma);
    const other = await createSite(prisma, 'Sede Sur');

    expect(await reader.encounter(encounter.id, [other.id])).toBeNull();
    const own = await reader.encounter(encounter.id, [site.id]);
    expect(own).toMatchObject({
      id: encounter.id,
      siteId: site.id,
      practitionerUserId: practitioner.userId,
      status: 'OPEN',
      clinicalDate: clinicalDateOf(encounter.startedAt),
    });
    expect(await reader.encounter(encounter.id, 'all')).toEqual(own);
  });

  it('AS-028 reads the sections of the consultation note that have text, in order, with their names', async () => {
    const prisma = db();
    const reader = new PrismaCodingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { practitioner, encounter } = await anAttention(prisma);
    const id = randomUUID();
    await prisma.clinicalNote.create({
      data: {
        id,
        chainId: id,
        encounterId: encounter.id,
        formCode: '002',
        formVersion: '1',
        content: {
          enfermedadActual: 'Odinofagia de tres días',
          motivoConsulta: 'Dolor de garganta',
          examenFisico: '   ',
          antecedentesNegados: true,
        },
        authorId: practitioner.id,
      },
    });

    expect(await reader.consultationNote(encounter.id)).toEqual({
      id,
      sections: [
        { key: 'motivoConsulta', label: 'Motivo de consulta', text: 'Dolor de garganta' }, // prettier-ignore
        { key: 'enfermedadActual', label: 'Enfermedad o problema actual', text: 'Odinofagia de tres días' }, // prettier-ignore
      ],
    });
  });

  it('AS-027 reads what the person was coded with in other attentions, absorbed chart included, without the annulled, within the sites of the requester', async () => {
    const prisma = db();
    const reader = new PrismaCodingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { site, practitioner, patient, encounter } =
      await anAttention(prisma);
    const absorbed = await createPatient(prisma);
    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: patient.id, mergedAt: new Date() },
    });
    const ids = { siteId: site.id, practitionerId: practitioner.id };
    const before = new Date(encounter.startedAt.getTime() - 30 * DAY_MS);
    const earlier = await createEncounter(prisma, { ...ids, patientId: patient.id, startedAt: before }); // prettier-ignore
    const later = await createEncounter(prisma, { ...ids, patientId: patient.id }); // prettier-ignore
    const onAbsorbed = await createEncounter(prisma, { ...ids, patientId: absorbed.id }); // prettier-ignore
    const annulled = await createEncounter(prisma, { ...ids, patientId: patient.id }); // prettier-ignore
    const hypertension = await whoCode(prisma, 'I10.X', 'Hipertensión esencial (primaria)'); // prettier-ignore
    const diabetes = await whoCode(prisma, 'E11.9', 'Diabetes tipo 2'); // prettier-ignore
    const asthma = await whoCode(prisma, 'J45.9', 'Asma, no especificada'); // prettier-ignore
    await diagnose(prisma, earlier.id, hypertension, 1);
    await diagnose(prisma, later.id, hypertension, 1);
    await diagnose(prisma, onAbsorbed.id, diabetes, 1);
    await diagnose(prisma, annulled.id, asthma, 1);
    // The attention being coded does not count as its own history.
    await diagnose(prisma, encounter.id, asthma, 1);
    await prisma.$executeRaw`
      UPDATE encounter SET status = 'ENTERED_IN_ERROR', ended_at = ${new Date()},
        entered_in_error_reason = 'Paciente equivocado',
        entered_in_error_at = ${new Date()}, entered_in_error_by_id = ${practitioner.userId}::uuid
      WHERE id = ${annulled.id}::uuid`;

    const history = await reader.patientHistory(
      patient.id,
      encounter.id,
      'all',
      10,
    );

    expect(history.map(({ code, times }) => ({ code, times }))).toEqual([
      { code: 'I10.X', times: 2 },
      // The absorbed chart is hers too (PA-055).
      { code: 'E11.9', times: 1 },
    ]);
    expect(history[0]!.lastUsedOn).toBe(clinicalDateOf(later.startedAt));
    // EN-184's reach: an attention of a site the requester cannot read is not
    // in the history; with that site, it is (control).
    const elsewhere = await createSite(prisma, 'Sede Sur');
    const there = await createEncounter(prisma, { siteId: elsewhere.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
    await diagnose(prisma, there.id, asthma, 1);
    const own = await reader.patientHistory(patient.id, encounter.id, [site.id], 10); // prettier-ignore
    expect(own.map(({ code }) => code)).not.toContain('J45.9');
    const both = await reader.patientHistory(patient.id, encounter.id, [site.id, elsewhere.id], 10); // prettier-ignore
    expect(both.map(({ code }) => code)).toContain('J45.9');
    // Control: the codes recorded here are read by `recordedCodes`.
    expect(await reader.recordedCodes(encounter.id)).toEqual(['J45.9']);
    // AS-037. A diagnosis is read only through its own attention.
    const [mine] = await prisma.encounterDiagnosis.findMany({ where: { encounterId: encounter.id } }); // prettier-ignore
    expect(await reader.diagnosisOf(encounter.id, mine!.id)).toEqual({ id: mine!.id, code: 'J45.9', recordedAt: mine!.recordedAt }); // prettier-ignore
    expect(await reader.diagnosisOf(later.id, mine!.id)).toBeNull();
  });

  it('AS-027 the clinic frequency counts since the date it is given, most recorded first', async () => {
    const prisma = db();
    const reader = new PrismaCodingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { site, practitioner, patient } = await anAttention(prisma);
    const ids = { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }; // prettier-ignore
    const now = new Date();
    const since = new Date(now.getTime() - 365 * DAY_MS);
    const old = new Date(now.getTime() - 400 * DAY_MS);
    const flu = await whoCode(prisma, 'J11.1', 'Influenza'); // prettier-ignore
    const cold = await whoCode(prisma, 'J00.X', 'Rinofaringitis aguda'); // prettier-ignore
    for (let i = 0; i < 2; i += 1) {
      const encounter = await createEncounter(prisma, ids);
      await diagnose(prisma, encounter.id, cold, 1);
    }
    for (let i = 0; i < 3; i += 1) {
      const encounter = await createEncounter(prisma, ids);
      await diagnose(prisma, encounter.id, flu, 1, old);
    }
    const recent = await createEncounter(prisma, ids);
    await diagnose(prisma, recent.id, flu, 1);

    const frequency = await reader.clinicFrequency(since, 10);

    // The three of 400 days ago fall outside the window.
    expect(frequency.map(({ code, times }) => ({ code, times }))).toEqual([
      { code: 'J00.X', times: 2 },
      { code: 'J11.1', times: 1 },
    ]);
    // Control: with a window that reaches them, they count.
    const wide = await reader.clinicFrequency(new Date(old.getTime() - DAY_MS), 10); // prettier-ignore
    expect(wide[0]).toMatchObject({ code: 'J11.1', times: 4 });
  });

  it('AS-025 hands the names the note may carry, for the pseudonymizer', async () => {
    const prisma = db();
    const reader = new PrismaCodingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { encounter } = await anAttention(prisma);

    const people = await reader.people(encounter.id);

    expect(people.patient).toEqual(['María', 'Guamán']);
    expect(people.staff).toHaveLength(2);
  });
});
