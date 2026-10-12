import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaPrescribingContextReader } from '../../src/shared/infrastructure/clinical/prisma-prescribing-context.reader';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createIssuedPrescription,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * AS-064, AS-069, AS-072, AS-074 against PostgreSQL: what the assistant
 * reads of the cuadro and of the attention's receta. Every «not found» has
 * its positive control through the same path.
 */
const db = useDatabase();

async function cnmbSystem(prisma: PrismaClient) {
  return prisma.catalogSystem.upsert({
    where: { code: 'CNMB' },
    create: { code: 'CNMB', name: 'CNMB', hierarchical: false },
    update: {},
  });
}

async function medicine(
  prisma: PrismaClient,
  code: string,
  display: string,
  attributes: Prisma.InputJsonObject,
  validTo?: Date,
) {
  const system = await cnmbSystem(prisma);
  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code,
      display,
      attributes: attributes,
      validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      validTo,
    },
  });
}

const AMOXICILLIN = {
  substances: ['dci:amoxicilina'],
  presentations: [
    {
      form: 'TABLET',
      forms: ['TABLET', 'CAPSULE'],
      concentration: '500 mg',
      label: 'Sólido oral',
      route: 'O - Oral',
    },
    {
      form: 'POWDER_FOR_ORAL_SUSPENSION',
      concentration: '250 mg/5 mL',
      label: 'Sólido oral (polvo)',
    },
  ],
};

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

/** PR-107. A discard says who and when, or the database refuses it. */
async function discarded(prisma: PrismaClient) {
  return {
    discardedAt: new Date(),
    discardedById: (await createUser(prisma)).id,
  };
}

function line(conceptId: string | null, overrides: object = {}) {
  return {
    conceptId,
    genericName: conceptId ? 'Amoxicilina' : 'Fórmula magistral',
    offFormulary: conceptId === null,
    presentation: 'Tableta',
    concentration: '500 mg',
    dosageFormCode: 'TABLET',
    doseAmount: 1,
    doseUnitCode: 'TABLET',
    doseText: '1 tableta',
    routeCode: 'ORAL',
    frequencyCode: 'EVERY_8_HOURS',
    frequencyText: 'Cada 8 horas',
    durationDays: 7,
    quantity: 21,
    ...overrides,
  };
}

describe('the cuadro the assistant searches (AS-064)', () => {
  it('AS-064 finds a medicine by its DCI or name without accents nor case, the exact one first, with its presentations', async () => {
    const prisma = db();
    const reader = new PrismaPrescribingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const today = clinicalDateOf(new Date());
    await medicine(prisma, 'J01CR02', 'Amoxicilina + ácido clavulánico', { substances: ['dci:amoxicilina + acido clavulanico'] }); // prettier-ignore
    const plain = await medicine(prisma, 'J01CA04', 'Amoxicilina', AMOXICILLIN);
    await medicine(prisma, 'N02BE01', 'Paracetamol', { substances: ['dci:paracetamol'] }); // prettier-ignore

    const found = await reader.searchCnmb('AMOXICILÍNA', today, 5);

    expect(found.map((each) => each.code)).toEqual(['J01CA04', 'J01CR02']);
    expect(found[0]).toEqual({
      conceptId: plain.id,
      code: 'J01CA04',
      display: 'Amoxicilina',
      presentations: AMOXICILLIN.presentations,
      controlled: false,
    });
    // Nothing for a blank name, and nothing that is not in the cuadro.
    expect(await reader.searchCnmb('  ', today, 5)).toEqual([]);
    expect(await reader.searchCnmb('Ibuprofeno', today, 5)).toEqual([]);
  });

  it('AS-064 a medicine retired before the clinical date is not offered, and is on a day it was in force', async () => {
    const prisma = db();
    const reader = new PrismaPrescribingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const today = clinicalDateOf(new Date());
    await medicine(prisma, 'N02BE01', 'Paracetamol', { substances: ['dci:paracetamol'] }, new Date(`${addDays(today, -10)}T00:00:00Z`)); // prettier-ignore

    expect(await reader.searchCnmb('paracetamol', today, 5)).toEqual([]);
    const then = await reader.searchCnmb('paracetamol', addDays(today, -20), 5);
    expect(then.map((each) => each.code)).toEqual(['N02BE01']);
  });

  it('AS-064 a LIKE wildcard in the name is a letter, not a pattern', async () => {
    const prisma = db();
    const reader = new PrismaPrescribingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    await medicine(prisma, 'J01CA04', 'Amoxicilina', AMOXICILLIN);
    const today = clinicalDateOf(new Date());

    expect(await reader.searchCnmb('%', today, 5)).toEqual([]);
    expect((await reader.searchCnmb('amox', today, 5)).length).toBe(1);
  });

  it('AS-069 reads the substance keys the issue compares', async () => {
    const prisma = db();
    const reader = new PrismaPrescribingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const concept = await medicine(prisma, 'J01CA04', 'Amoxicilina', { ...AMOXICILLIN, replaces: ['AMOXICILINA'] }); // prettier-ignore

    const keys = await reader.substanceKeys([concept.id]);

    expect(keys.get(concept.id)).toEqual(['J01CA04', 'AMOXICILINA', 'dci:amoxicilina']); // prettier-ignore
  });
});

describe('what the attention already prescribes (AS-072, AS-074)', () => {
  it('AS-072 the codes of the standing recetas of the attention, without the discarded nor the annulled nor other attentions', async () => {
    const prisma = db();
    const reader = new PrismaPrescribingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { site, practitioner, encounter, patient } =
      await anAttention(prisma);
    const amoxicillin = await medicine(prisma, 'J01CA04', 'Amoxicilina', AMOXICILLIN); // prettier-ignore
    const paracetamol = await medicine(prisma, 'N02BE01', 'Paracetamol', {});
    const ibuprofen = await medicine(prisma, 'M01AE01', 'Ibuprofeno', {});
    const base = { encounterId: encounter.id, siteId: site.id, prescriberId: practitioner.id }; // prettier-ignore

    await prisma.prescription.create({ data: { ...base, items: { create: [line(amoxicillin.id)] } } }); // prettier-ignore
    await prisma.prescription.create({ data: { ...base, status: 'DISCARDED', ...(await discarded(prisma)), items: { create: [line(paracetamol.id)] } } }); // prettier-ignore
    await createIssuedPrescription(prisma, { ...base, status: 'CANCELLED', items: { create: [line(ibuprofen.id)] } }); // prettier-ignore
    const other = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
    await prisma.prescription.create({ data: { ...base, encounterId: other.id, items: { create: [line(paracetamol.id)] } } }); // prettier-ignore

    expect(await reader.prescribedCodes(encounter.id)).toEqual(['J01CA04']);
  });

  it('AS-074 reads line n of a receta of the attention in its own order, and nothing of another attention or a discarded one', async () => {
    const prisma = db();
    const reader = new PrismaPrescribingContextReader(prisma as unknown as PrismaService); // prettier-ignore
    const { site, practitioner, encounter, patient } =
      await anAttention(prisma);
    const amoxicillin = await medicine(prisma, 'J01CA04', 'Amoxicilina', AMOXICILLIN); // prettier-ignore
    const base = { encounterId: encounter.id, siteId: site.id, prescriberId: practitioner.id }; // prettier-ignore
    const draft = await prisma.prescription.create({
      data: { ...base, items: { create: [line(null), line(amoxicillin.id, { doseAmount: 2, quantity: 42 })] } }, // prettier-ignore
    });

    expect(await reader.prescriptionLine(encounter.id, draft.id, 2)).toEqual({
      conceptId: amoxicillin.id,
      dosageFormCode: 'TABLET',
      concentration: '500 mg',
      routeCode: 'ORAL',
      doseAmount: 2,
      doseUnitCode: 'TABLET',
      frequencyCode: 'EVERY_8_HOURS',
      frequencyText: 'Cada 8 horas',
      durationDays: 7,
      quantity: 42,
    });
    expect(await reader.prescriptionLine(encounter.id, draft.id, 3)).toBeNull();
    expect(await reader.prescriptionLine(encounter.id, draft.id, 0)).toBeNull();

    const other = await createEncounter(prisma, { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }); // prettier-ignore
    expect(await reader.prescriptionLine(other.id, draft.id, 2)).toBeNull();
    await prisma.prescription.update({ where: { id: draft.id }, data: { status: 'DISCARDED', ...(await discarded(prisma)) } }); // prettier-ignore
    expect(await reader.prescriptionLine(encounter.id, draft.id, 2)).toBeNull();
  });
});
