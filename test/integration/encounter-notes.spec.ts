import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaClinicalNoteRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-note.repository';
import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import {
  contentHashOf,
  type NoteContent,
} from '../../src/modules/encounter/domain/clinical-note';
import {
  NoteAlreadySignedError,
  NoteNotAmendableError,
} from '../../src/modules/encounter/domain/encounter.errors';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * The clinical note against a real PostgreSQL: the heart of REQ-005.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY ONE OF THESE HAS TO BE AN INTEGRATION TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They are all NEGATIVES about the database, and a double cannot state a
 * negative: it refuses what it was told to refuse. What has to be shown is
 * that PostgreSQL itself refuses an `UPDATE` of a signed note's content, a
 * second current version in one chain, a `DELETE` and a `TRUNCATE` — because
 * those are the things that also stop a `psql`, an import, and a use case
 * somebody writes in two years without reading the spec. A service that «does
 * not edit signed notes» is a custom.
 */
const db = useDatabase();

const COMPLETE_002: NoteContent = {
  motivoConsulta: 'Dolor abdominal de dos días',
  antecedentes: 'Sin antecedentes patológicos de importancia',
  enfermedadActual: 'Dolor en epigastrio, sin irradiación',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Abdomen blando, doloroso a la palpación',
  planTratamiento: 'Dieta blanda y control en 72 horas',
};

const SIGNED_AT = new Date('2026-08-14T15:00:00Z');

const notesOf = (prisma: PrismaClient) =>
  new PrismaClinicalNoteRepository(prisma as unknown as PrismaService);

async function aDraft(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);

  const encounter = await new PrismaEncounterRepository(
    prisma as unknown as PrismaService,
  ).open({
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    startedAt: new Date('2026-08-14T14:00:00Z'),
    careModality: 'MORBIDITY',
    careSetting: 'INTRAMURAL',
    visitSequence: 'FIRST_TIME',
  });

  const note = await notesOf(prisma).createDraft({
    encounterId: encounter.id,
    formCode: '002',
    formVersion: '1',
    content: COMPLETE_002,
    authorId: practitioner.id,
    sites: [site.id],
  });

  return { site, practitioner, patient, encounter, note };
}

/** Signs the draft through the adapter, discharging the attention with it. */
async function sign(
  prisma: PrismaClient,
  ids: { site: { id: string }; practitioner: { id: string } },
  encounterId: string,
  noteId: string,
) {
  return notesOf(prisma).sign(
    { encounterId, noteId, sites: [ids.site.id] },
    (note) => ({
      signedById: ids.practitioner.id,
      signedAt: SIGNED_AT,
      contentHash: contentHashOf({
        content: note.content,
        signedById: ids.practitioner.id,
        signedAt: SIGNED_AT,
      }),
      dischargesTheEncounter: true,
      dischargeCondition: 'ALIVE',
    }),
  );
}

/** The error PostgreSQL raises, whatever Prisma wraps it in. */
async function failsWith(promise: Promise<unknown>, fragment: string) {
  await expect(promise).rejects.toThrow(
    expect.objectContaining({
      message: expect.stringContaining(fragment) as unknown as string,
    }),
  );
}

describe('la nota clínica firmada', () => {
  it('EN-024 nace con la cadena apuntando a su propio identificador', async () => {
    const prisma = db();
    const { note } = await aDraft(prisma);

    // Version 1 IS its own chain, which no INSERT can state about a value the
    // database is generating in the same statement — hence the uuidv7 asked
    // for first.
    expect(note.chainId).toBe(note.id);
    expect(note.version).toBe(1);
    expect(note.status).toBe('DRAFT');
  });

  it('EN-027 ata firmante, instante y resumen: no existe la nota «firmada a medias»', async () => {
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);

    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    expect(signed.status).toBe('SIGNED');
    expect(signed.signedById).toBe(practitioner.id);
    expect(signed.signedAt).toEqual(SIGNED_AT);
    expect(signed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('EN-027 rechaza en la BASE una nota con instante de firma y sin firmante', async () => {
    /**
     * `clinical_note_signature_coherence` ata las tres columnas: `DRAFT` si y
     * sólo si no hay instante de firma, y no hay instante si y sólo si no hay
     * firmante ni hash. No existe la nota «firmada a medias».
     *
     * ⚠️ SE ATACA UN BORRADOR Y NO UNA FIRMADA, y no es comodidad: sobre una
     * nota ya firmada llega ANTES `trg_clinical_note_immutable`, que rechaza
     * cualquier `UPDATE` con `insufficient_privilege`. Un borrador SÍ es
     * mutable, así que es el único camino por el que este `CHECK` puede
     * demostrarse — y es exactamente el camino por el que una importación
     * escribiría una firma incompleta.
     */
    const prisma = db();
    const { note } = await aDraft(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `UPDATE clinical_note SET signed_at = now() WHERE id = $1`,
        note.id,
      ),
      'clinical_note_signature_coherence',
    );
  });

  it('EN-023 rechaza un UPDATE del contenido de una nota firmada hecho por SQL directo', async () => {
    /**
     * ⚠️ LA GARANTÍA MÁS IMPORTANTE DE ESTE MÓDULO, atacada por donde de
     * verdad importa: no por la API, sino por la base.
     * `trg_clinical_note_immutable` es lo único que también detiene un
     * `psql`, una importación o un caso de uso que alguien escriba dentro de
     * dos años sin leer esta spec.
     */
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);
    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    await failsWith(
      prisma.$executeRawUnsafe(
        `UPDATE clinical_note SET content = '{"motivoConsulta":"otra cosa"}'::jsonb WHERE id = $1`,
        signed.id,
      ),
      'is signed and cannot be modified',
    );

    // Y el contenido sigue siendo el que se firmó.
    const stored = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: signed.id },
      select: { content: true },
    });
    expect(stored.content).toEqual(COMPLETE_002);
  });

  it('EN-023 rechaza también editar el borrador desde el servicio una vez firmado', async () => {
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);
    await sign(prisma, { site, practitioner }, encounter.id, note.id);

    await expect(
      notesOf(prisma).updateDraft(
        { encounterId: encounter.id, noteId: note.id, sites: [site.id] },
        { ...COMPLETE_002, planTratamiento: 'Otro plan' },
        (stored) => {
          if (stored.status !== 'DRAFT') throw new NoteAlreadySignedError();
        },
      ),
    ).rejects.toBeInstanceOf(NoteAlreadySignedError);
  });

  it('EN-030 rechaza BORRAR una nota clínica, aunque sea un borrador', async () => {
    const prisma = db();
    const { note } = await aDraft(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(`DELETE FROM clinical_note WHERE id = $1`, note.id), // prettier-ignore
      'clinical notes are never deleted',
    );

    await expect(prisma.clinicalNote.count()).resolves.toBe(1);
  });

  it('EN-030 rechaza VACIAR la tabla, que es el atajo que un DELETE por fila no cubre', async () => {
    /**
     * `TRUNCATE` no dispara los `BEFORE DELETE` por fila, así que sin
     * `trg_clinical_note_no_truncate` la inmutabilidad tenía un agujero del
     * tamaño de una sentencia.
     *
     * El disparador es `FOR EACH STATEMENT`, así que no hay `OLD` que nombrar
     * y el mensaje sale con el identificador en blanco: lo que importa es que
     * la sentencia se ABORTA y la tabla sigue teniendo sus filas, que es lo
     * que se cuenta abajo.
     */
    const prisma = db();
    await aDraft(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(`TRUNCATE TABLE clinical_note CASCADE`),
      'cannot be modified',
    );

    await expect(prisma.clinicalNote.count()).resolves.toBe(1);
  });

  it('EN-024 rechaza una SEGUNDA versión vigente en la misma cadena', async () => {
    /**
     * `clinical_note_one_current_per_chain` es un índice único PARCIAL sobre
     * `chain_id WHERE status IN ('DRAFT','SIGNED')`. Si esto falla, dos
     * médicos abren «la nota actual» del mismo acto clínico y leen cosas
     * distintas.
     */
    const prisma = db();
    const { practitioner, encounter, note } = await aDraft(prisma);

    await failsWith(
      prisma.$executeRawUnsafe(
        `INSERT INTO clinical_note
           (chain_id, version, form_code, form_version, encounter_id,
            status, content, author_id, updated_at)
         VALUES ($1, 2, '002', '1', $2, 'DRAFT', '{}'::jsonb, $3, now())`,
        note.chainId,
        encounter.id,
        practitioner.id,
      ),
      'clinical_note_one_current_per_chain',
    );
  });

  it('EN-025 enmienda dejando la versión anterior LEGIBLE y una sola vigente', async () => {
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);
    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    const corrected = { ...COMPLETE_002, planTratamiento: 'Dieta absoluta' };
    const amended = await notesOf(prisma).amend(
      { encounterId: encounter.id, noteId: signed.id, sites: [site.id] },
      (previous) => ({
        chainId: previous.chainId,
        version: previous.version + 1,
        supersedesId: previous.id,
        amendmentReason: 'Se anotó el plan de la paciente anterior',
        formCode: previous.formCode,
        formVersion: previous.formVersion,
        content: corrected,
        authorId: practitioner.id,
        signature: {
          signedById: practitioner.id,
          signedAt: new Date('2026-08-15T09:00:00Z'),
          contentHash: contentHashOf({
            content: corrected,
            signedById: practitioner.id,
            signedAt: new Date('2026-08-15T09:00:00Z'),
          }),
          dischargesTheEncounter: false,
          dischargeCondition: null,
        },
      }),
    );

    expect(amended.version).toBe(2);
    expect(amended.supersedesId).toBe(signed.id);
    expect(amended.status).toBe('SIGNED');

    // LA ANTERIOR SIGUE SIENDO LEGIBLE, con su contenido, su firmante y su
    // instante intactos: eso es lo que «no se edita, se añade» significa.
    const previous = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: signed.id },
      select: { status: true, content: true, signedById: true, signedAt: true },
    });
    expect(previous.status).toBe('SUPERSEDED');
    expect(previous.content).toEqual(COMPLETE_002);
    expect(previous.signedById).toBe(practitioner.id);
    expect(previous.signedAt).toEqual(SIGNED_AT);

    // Y una sola vigente en la cadena, contado en la base.
    await expect(
      prisma.clinicalNote.count({
        where: { chainId: signed.chainId, status: { in: ['DRAFT', 'SIGNED'] } },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.clinicalNote.count({ where: { chainId: signed.chainId } }),
    ).resolves.toBe(2);
  });

  it('EN-025 rechaza enmendar dos veces la misma versión', async () => {
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);
    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    const amendment = (version: number) => ({
      chainId: signed.chainId,
      version,
      supersedesId: signed.id,
      amendmentReason: 'Corrección',
      formCode: '002',
      formVersion: '1',
      content: COMPLETE_002,
      authorId: practitioner.id,
      signature: {
        signedById: practitioner.id,
        signedAt: new Date('2026-08-15T09:00:00Z'),
        contentHash: 'b'.repeat(64),
        dischargesTheEncounter: false,
        dischargeCondition: null,
      },
    });

    await notesOf(prisma).amend(
      { encounterId: encounter.id, noteId: signed.id, sites: [site.id] },
      () => amendment(2),
    );

    // La segunda ve la versión ya SUPERSEDED y el `decide` la rechaza; sin él,
    // `supersedes_id` es `@unique` y la habría rechazado la base.
    await expect(
      notesOf(prisma).amend(
        { encounterId: encounter.id, noteId: signed.id, sites: [site.id] },
        (previous) => {
          if (previous.status !== 'SIGNED') {
            throw new NoteNotAmendableError(previous.status);
          }
          return amendment(3);
        },
      ),
    ).rejects.toBeInstanceOf(NoteNotAmendableError);
  });

  it('EN-026 retracta sin reemplazo y la nota NO desaparece de la historia', async () => {
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);
    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    const retracted = await notesOf(prisma).retract(
      { encounterId: encounter.id, noteId: signed.id, sites: [site.id] },
      () => undefined,
    );

    expect(retracted.status).toBe('ENTERED_IN_ERROR');
    // Apunta a NADA: así es como se distingue de una enmienda.
    expect(retracted.supersedesId).toBeNull();
    // Y la fila sigue ahí, con su contenido y su firma — contado en la base.
    await expect(prisma.clinicalNote.count()).resolves.toBe(1);
    expect(retracted.content).toEqual(COMPLETE_002);
    expect(retracted.signedById).toBe(practitioner.id);
  });

  it('EN-130 pasa la atención a DISCHARGED en la MISMA transacción que la firma', async () => {
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);

    await sign(prisma, { site, practitioner }, encounter.id, note.id);

    const stored = await prisma.encounter.findUniqueOrThrow({
      where: { id: encounter.id },
      select: { status: true, endedAt: true, dischargeCondition: true },
    });

    expect(stored.status).toBe('DISCHARGED');
    // `encounter_status_matches_ended_at` y
    // `encounter_discharge_states_a_condition` obligan a los tres a la vez.
    expect(stored.endedAt).toEqual(SIGNED_AT);
    expect(stored.dischargeCondition).toBe('ALIVE');
  });

  it('EN-022 ordena las versiones por cadena y versión, no por su propia fecha', async () => {
    /**
     * ⚠️ LA MITAD QUE SE OLVIDA DE EN-022: una enmienda hecha hoy sobre una
     * consulta de marzo tiene que aparecer EN EL LUGAR DE LA ORIGINAL. Ordenada
     * por su propia fecha saldría al final de la historia y quien la lea creería
     * que hubo una consulta hoy.
     */
    const prisma = db();
    const { site, practitioner, encounter, note } = await aDraft(prisma);
    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    // Una segunda cadena, abierta DESPUÉS.
    const second = await notesOf(prisma).createDraft({
      encounterId: encounter.id,
      formCode: '005',
      formVersion: '1',
      content: { evolucion: 'Se retira el vendaje sin incidencias' },
      authorId: practitioner.id,
      sites: [site.id],
    });

    // Y una enmienda de la PRIMERA, escrita al final de todo.
    await notesOf(prisma).amend(
      { encounterId: encounter.id, noteId: signed.id, sites: [site.id] },
      (previous) => ({
        chainId: previous.chainId,
        version: 2,
        supersedesId: previous.id,
        amendmentReason: 'Corrección tardía',
        formCode: previous.formCode,
        formVersion: previous.formVersion,
        content: COMPLETE_002,
        authorId: practitioner.id,
        signature: {
          signedById: practitioner.id,
          signedAt: new Date('2026-08-16T09:00:00Z'),
          contentHash: 'c'.repeat(64),
          dischargesTheEncounter: false,
          dischargeCondition: null,
        },
      }),
    );

    const listed = await notesOf(prisma).listOfEncounter({
      encounterId: encounter.id,
      sites: [site.id],
    });

    // La enmienda va JUNTO a su original, y la segunda cadena después.
    expect(
      listed.map((version) => `${version.chainId === signed.chainId ? 'A' : 'B'}${version.version}`), // prettier-ignore
    ).toEqual(['A1', 'A2', 'B1']);
    expect(listed[2]?.id).toBe(second.id);
  });

  it('EN-031 no toca una nota firmada al corregir la ficha del paciente', async () => {
    /**
     * La nota CITA al paciente por su identificador y no copia su nombre, así
     * que corregir un apellido no la roza. Lo que este requisito prohíbe es el
     * atajo contrario —propagar la corrección al contenido «para que salga
     * bien impresa»—, que reescribiría el pasado.
     */
    const prisma = db();
    const { site, practitioner, patient, encounter, note } =
      await aDraft(prisma);
    const signed = await sign(
      prisma,
      { site, practitioner },
      encounter.id,
      note.id,
    );

    await prisma.patient.update({
      where: { id: patient.id },
      data: { familyName: 'Guamán Cevallos' },
    });

    const after = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: signed.id },
      select: { content: true, contentHash: true, updatedAt: true },
    });
    expect(after.content).toEqual(COMPLETE_002);
    expect(after.contentHash).toBe(signed.contentHash);
  });
});
