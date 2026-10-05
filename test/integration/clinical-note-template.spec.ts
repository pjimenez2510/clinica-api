import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { builtInTemplate } from '../../src/modules/encounter/domain/note-template';
import { PrismaClinicalNoteRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-note.repository';
import { PrismaNoteTemplateRepository } from '../../src/modules/encounter/infrastructure/prisma-note-template.repository';
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
 * EN-200, EN-203, EN-204 against a real PostgreSQL.
 *
 * The append-only template and the fixed template of a note are triggers, and
 * a trigger nobody attacks from the database is an intention. Each refusal
 * has its positive control beside it: the INSERT that must pass.
 */
const db = useDatabase();

const asPrisma = (prisma: PrismaClient) => prisma as unknown as PrismaService;

const SECTIONS = builtInTemplate('002').sections;

async function publish(
  prisma: PrismaClient,
  specialtyId: string | null = null,
) {
  const author = await createUser(prisma);
  return new PrismaNoteTemplateRepository(asPrisma(prisma)).publish({
    formCode: '002',
    specialtyId,
    sections: SECTIONS,
    publishedById: author.id,
    publishedAt: new Date(),
  });
}

async function failsWith(promise: Promise<unknown>, fragment: string) {
  await expect(promise).rejects.toThrow(new RegExp(fragment));
}

async function aDraft(prisma: PrismaClient, templateId: string | null) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return new PrismaClinicalNoteRepository(asPrisma(prisma)).createDraft({
    encounterId: encounter.id,
    formCode: '002',
    formVersion: '1',
    templateId,
    content: {},
    authorId: practitioner.id,
    authorUserId: practitioner.userId,
    sites: [site.id],
  });
}

describe('las versiones de la plantilla de nota', () => {
  it('EN-200 publicar numera las versiones de cada plantilla por separado', async () => {
    const prisma = db();
    const pediatria = await prisma.specialty.create({
      data: { code: 'pediatria', name: 'Pediatría' },
    });

    const first = await publish(prisma);
    const second = await publish(prisma);
    const ofPediatrics = await publish(prisma, pediatria.id);

    expect([first.version, second.version, ofPediatrics.version]).toEqual([
      1, 2, 1,
    ]);
  });

  it('EN-200 la base rechaza modificar, borrar o vaciar una versión publicada', async () => {
    const prisma = db();
    const published = await publish(prisma);

    await failsWith(
      prisma.$executeRaw`UPDATE clinical_note_template SET version = 9 WHERE id = ${published.id}::uuid`,
      'insert-only',
    );
    await failsWith(
      prisma.$executeRaw`DELETE FROM clinical_note_template WHERE id = ${published.id}::uuid`,
      'insert-only',
    );
    await failsWith(
      prisma.$executeRawUnsafe('TRUNCATE clinical_note_template CASCADE'),
      'insert-only',
    );
  });

  it('EN-200 la base rechaza dos versiones con el mismo número, también en la de la clínica', async () => {
    const prisma = db();
    const author = await createUser(prisma);
    const row = (version: number) =>
      prisma.$executeRaw`
        INSERT INTO clinical_note_template
          (form_code, specialty_id, version, sections, published_at, published_by_id)
        VALUES ('002', NULL, ${version}, '[{"key":"motivoConsulta"}]'::jsonb, now(), ${author.id}::uuid)
      `;

    // Control positivo: la primera entra.
    await row(1);
    await failsWith(row(1), 'clinical_note_template_version_unique');
  });
});

describe('la plantilla de cada nota', () => {
  it('EN-204 la base no deja cambiar la plantilla de una nota, ni en borrador', async () => {
    const prisma = db();
    const first = await publish(prisma);
    const second = await publish(prisma);
    // Control positivo: la nota nace con su plantilla.
    const note = await aDraft(prisma, first.id);
    expect(note.templateId).toBe(first.id);

    await failsWith(
      prisma.$executeRaw`UPDATE clinical_note SET template_id = ${second.id}::uuid WHERE id = ${note.id}::uuid`,
      'cannot change',
    );
  });

  it('EN-204 la base no acepta en una nota la plantilla de otro formulario', async () => {
    const prisma = db();
    const published = await publish(prisma);
    const note = await aDraft(prisma, null);

    await failsWith(
      prisma.$executeRaw`
        INSERT INTO clinical_note (chain_id, form_code, encounter_id, content, author_id, template_id)
        SELECT gen_random_uuid(), '005', encounter_id, '{}'::jsonb, author_id, ${published.id}::uuid
          FROM clinical_note WHERE id = ${note.id}::uuid
      `,
      'is not a template of form',
    );
  });
});

describe('la especialidad de la atención', () => {
  it('EN-203 sin cita, la especialidad es la principal del profesional', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const [general, pediatria] = await Promise.all([
      prisma.specialty.create({ data: { code: 'general', name: 'General' } }),
      prisma.specialty.create({
        data: { code: 'pediatria', name: 'Pediatría' },
      }),
    ]);
    await prisma.practitionerSpecialty.createMany({
      data: [
        { practitionerId: practitioner.id, specialtyId: general.id },
        {
          practitionerId: practitioner.id,
          specialtyId: pediatria.id,
          isPrimary: true,
        },
      ],
    });
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });

    await expect(
      new PrismaNoteTemplateRepository(asPrisma(prisma)).specialtyOfEncounter(
        encounter.id,
      ),
    ).resolves.toBe(pediatria.id);
  });
});
