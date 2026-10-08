import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { contentHashOf } from '../../src/modules/encounter/domain/clinical-note';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createDiagnosis, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * Referrals and interconsultations through the HTTP door, with REAL SESSIONS
 * of the seeded roles (encounter H8, EN-100 to EN-107, EN-243): what is
 * issued, the 053 or 007 it writes in the same transaction, the «referred»
 * discharge, the annulment and the paper.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

const COMPLETE_002 = {
  motivoConsulta: 'Dolor torácico de dos días',
  antecedentes: 'Hipertensión en tratamiento',
  enfermedadActual: 'Dolor opresivo al esfuerzo',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Ruidos cardiacos rítmicos, sin soplos',
  planTratamiento: 'Referencia a cardiología',
};

const REFERRAL = {
  direction: 'REFERRAL',
  destination: { mspUnicode: '05176', name: 'Hospital General de Chone' },
  priority: 'URGENT',
  reason: 'Dolor torácico al esfuerzo: descartar cardiopatía isquémica',
  summary: 'ECG sin cambios agudos',
};

describe('la referencia y la interconsulta por HTTP, con sesiones reales (EN-100 a EN-107, EN-243)', () => {
  const db = useDatabase();
  let app: NestExpressApplication | undefined;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let patientId: string;
  let doctorToken: string;
  let doctorPractitionerId: string;
  let doctorUserId: string;
  let nurseToken: string;
  let elsewhereDoctorToken: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(ThrottlerStorage)
        .useValue({
          increment: () =>
            Promise.resolve({
              totalHits: 1,
              timeToExpire: 1,
              isBlocked: false,
              timeToBlockExpire: 0,
            }),
        })
        .compile();

      app = moduleRef.createNestApplication<NestExpressApplication>({
        bodyParser: false,
      });
      configureApp(app);
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    registry.invalidate();

    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    siteId = site.id;
    patientId = (await createPatient(prisma)).id;

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065', siteId); // prettier-ignore
    doctorToken = doctor.token;
    doctorPractitionerId = doctor.practitionerId;
    doctorUserId = doctor.userId;
    nurseToken = (await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283', siteId)).token; // prettier-ignore
    elsewhereDoctorToken = (await signIn('MEDICO', 'medico3@clinica.ec', '0926687856', otherSite.id)).token; // prettier-ignore
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    atSite: string,
  ): Promise<{ token: string; practitionerId: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const practitioner = await prisma.practitioner.create({
      data: { userId: user.id },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: atSite },
    });
    const response = await request(app!.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner.id,
      userId: user.id,
    };
  }

  const send = (
    method: 'get' | 'post' | 'put',
    path: string,
    token: string,
    body?: object,
  ) => {
    const call = request(app!.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);
    return body === undefined ? call : call.send(body);
  };

  async function openEncounter(): Promise<string> {
    const response = await send('post', '/encounters', doctorToken, {
      siteId,
      practitionerId: doctorPractitionerId,
      patientId,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    }).expect(201);
    return (response.body as { id: string }).id;
  }

  async function issue(encounterId: string, body: object = REFERRAL) {
    const response = await send('post', `/encounters/${encounterId}/referrals`, doctorToken, body).expect(201); // prettier-ignore
    return response.body as {
      id: string;
      clinicalNoteId: string;
      status: string;
    };
  }

  /** The 002 ready to sign: written, with a diagnosis and the screening. */
  async function readyToSign(encounterId: string): Promise<string> {
    const draft = await send('post', `/encounters/${encounterId}/notes`, doctorToken, { formCode: '002', content: COMPLETE_002 }).expect(201); // prettier-ignore
    await createDiagnosis(prisma, encounterId, 'R07.4', 'Dolor torácico, no especificado'); // prettier-ignore
    await send('put', `/encounters/${encounterId}/screening`, doctorToken, { result: 'NO_SIGNS' }).expect(200); // prettier-ignore
    return (draft.body as { id: string }).id;
  }

  const trail = (resourceType: string, resourceId: string, action: string) =>
    prisma.accessAudit.count({ where: { resourceType, resourceId, action } });

  describe('EN-100 EN-104 emitir con su formulario 053', () => {
    it('EN-100 EN-101 EN-104 EN-106 la referencia nace con su 053 firmado en la misma transacción, con su huella y los diagnósticos del momento', async () => {
      const encounterId = await openEncounter();
      await createDiagnosis(prisma, encounterId, 'R07.4', 'Dolor torácico, no especificado'); // prettier-ignore
      const cardiology = await prisma.specialty.create({
        data: { code: 'CARDIOLOGY_H8', name: 'Cardiología' },
      });

      const issued = await issue(encounterId, { ...REFERRAL, specialtyId: cardiology.id }); // prettier-ignore
      expect(issued.status).toBe('ISSUED');

      const note = await prisma.clinicalNote.findUniqueOrThrow({
        where: { id: issued.clinicalNoteId },
      });
      expect(note).toMatchObject({
        encounterId,
        formCode: '053',
        status: 'SIGNED',
        signedById: doctorPractitionerId,
        signatureMethod: 'CREDENTIAL',
      });
      expect(note.content).toMatchObject({
        tipo: 'Referencia',
        establecimientoDestino: 'Hospital General de Chone (UNICÓDIGO 05176)',
        especialidad: 'Cardiología',
        prioridad: 'Urgente',
        motivo: REFERRAL.reason,
        diagnosticos: 'R07.4 Dolor torácico, no especificado (principal)',
      });
      // EN-027. Content, signer and instant inside the digest.
      expect(note.contentHash).toBe(
        contentHashOf({
          content: note.content as Record<string, unknown>,
          signedById: doctorPractitionerId,
          signedAt: note.signedAt!,
        }),
      );
      expect(await trail('referral', issued.id, 'CREATE')).toBe(1);

      const sheet = await send('get', `/encounters/${encounterId}/referrals`, doctorToken).expect(200); // prettier-ignore
      expect(sheet.body).toMatchObject({
        referrals: [{ id: issued.id, direction: 'REFERRAL', destination: REFERRAL.destination }], // prettier-ignore
        interconsultations: [],
        // REQ-149. The list to name the destination's specialty.
        specialties: expect.arrayContaining([{ id: cardiology.id, name: 'Cardiología' }]), // prettier-ignore
      });
      expect(await trail('referral', encounterId, 'READ')).toBe(1);
    });

    it('EN-101 EN-106 el formulario sin destino o sin motivo se rechaza por campo, y no escribe nada', async () => {
      const encounterId = await openEncounter();

      const noDestination = await send('post', `/encounters/${encounterId}/referrals`, doctorToken, { ...REFERRAL, destination: null }).expect(422); // prettier-ignore
      expect((noDestination.body as Problem).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'destination' })]), // prettier-ignore
      );
      await send('post', `/encounters/${encounterId}/referrals`, doctorToken, { ...REFERRAL, reason: ' ' }).expect(422); // prettier-ignore
      expect(await prisma.referral.count()).toBe(0);
      expect(await prisma.clinicalNote.count({ where: { formCode: '053' } })).toBe(0); // prettier-ignore

      // Positive control.
      await issue(encounterId);
      expect(await prisma.referral.count()).toBe(1);
    });

    it('EN-100 emitir pide record:sign: enfermería recibe 403, y otra sede 404', async () => {
      const encounterId = await openEncounter();

      await send('post', `/encounters/${encounterId}/referrals`, nurseToken, REFERRAL).expect(403); // prettier-ignore
      await send('post', `/encounters/${encounterId}/referrals`, elsewhereDoctorToken, REFERRAL).expect(404); // prettier-ignore
      await send('get', `/encounters/${encounterId}/referrals`, elsewhereDoctorToken).expect(404); // prettier-ignore
      expect(await prisma.referral.count()).toBe(0);

      await issue(encounterId);
      expect(await prisma.referral.count()).toBe(1);
    });

    it('EN-104 la ruta de notas no enmienda ni retracta el 053: se corrige anulando la referencia', async () => {
      const encounterId = await openEncounter();
      const issued = await issue(encounterId);

      const amend = await send('post', `/encounters/${encounterId}/notes/${issued.clinicalNoteId}/amend`, doctorToken, { content: { motivo: 'Otro' }, amendmentReason: 'Corrección' }).expect(422); // prettier-ignore
      expect((amend.body as Problem).code).toBe('UNKNOWN_CLINICAL_FORM');
      await send('post', `/encounters/${encounterId}/notes/${issued.clinicalNoteId}/retract`, doctorToken).expect(422); // prettier-ignore
      await send('post', `/encounters/${encounterId}/notes`, doctorToken, { formCode: '053', content: { motivo: 'x' } }).expect(422); // prettier-ignore

      expect(
        (await prisma.clinicalNote.findUniqueOrThrow({ where: { id: issued.clinicalNoteId } })).status, // prettier-ignore
      ).toBe('SIGNED');
    });
  });

  describe('EN-102 la contrarreferencia', () => {
    it('EN-102 en otra atención del paciente responde a su referencia, que deja de ofrecerse; una segunda respuesta se rechaza', async () => {
      const first = await openEncounter();
      const answered = await issue(first);
      const later = await openEncounter();

      const before = await send('get', `/encounters/${later}/referrals`, doctorToken).expect(200); // prettier-ignore
      expect((before.body as { answerable: { id: string }[] }).answerable.map((r) => r.id)).toEqual([answered.id]); // prettier-ignore

      const counter = {
        direction: 'COUNTER_REFERRAL',
        respondsToId: answered.id,
        reason: 'Retorno con prueba de esfuerzo negativa',
      };
      const response = await issue(later, counter);
      const note = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: response.clinicalNoteId } }); // prettier-ignore
      expect(note.content).toMatchObject({ tipo: 'Contrarreferencia' });
      expect((note.content as { respondeA: string }).respondeA).toContain('Hospital General de Chone'); // prettier-ignore

      const after = await send('get', `/encounters/${later}/referrals`, doctorToken).expect(200); // prettier-ignore
      expect((after.body as { answerable: unknown[] }).answerable).toEqual([]);

      const twice = await send('post', `/encounters/${later}/referrals`, doctorToken, counter).expect(409); // prettier-ignore
      expect((twice.body as Problem).code).toBe('REFERRAL_ALREADY_ANSWERED');
      // Nothing half-written: no second row and no orphan 053.
      expect(await prisma.referral.count()).toBe(2);
      expect(await prisma.clinicalNote.count({ where: { formCode: '053' } })).toBe(2); // prettier-ignore
    });

    it('EN-102 una contrarreferencia sin referencia se rechaza en el formulario y, a una que no existe, en la base', async () => {
      const encounterId = await openEncounter();

      await send('post', `/encounters/${encounterId}/referrals`, doctorToken, { direction: 'COUNTER_REFERRAL', reason: 'Retorno' }).expect(422); // prettier-ignore
      const own = await issue(encounterId, { ...REFERRAL, direction: 'REVERSE_REFERRAL' }); // prettier-ignore
      const refused = await send('post', `/encounters/${encounterId}/referrals`, doctorToken, { direction: 'COUNTER_REFERRAL', respondsToId: own.id, reason: 'Retorno' }).expect(422); // prettier-ignore
      expect((refused.body as Problem).code).toBe('COUNTER_REFERRAL_WITHOUT_REFERRAL'); // prettier-ignore
      expect(await prisma.referral.count()).toBe(1);
    });
  });

  describe('EN-107 anular con motivo', () => {
    it('EN-107 la anulación guarda quién, cuándo y por qué, retira su 053, no borra nada y no se repite', async () => {
      const encounterId = await openEncounter();
      const issued = await issue(encounterId);

      await send('post', `/encounters/${encounterId}/referrals/${issued.id}/cancel`, doctorToken, {}).expect(422); // prettier-ignore
      const cancelled = await send('post', `/encounters/${encounterId}/referrals/${issued.id}/cancel`, doctorToken, { reason: 'Paciente equivocado' }).expect(200); // prettier-ignore
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        cancellation: { reason: 'Paciente equivocado' },
      });

      const row = await prisma.referral.findUniqueOrThrow({ where: { id: issued.id } }); // prettier-ignore
      expect(row).toMatchObject({ cancelledById: doctorPractitionerId, cancellationReason: 'Paciente equivocado' }); // prettier-ignore
      expect(
        (await prisma.clinicalNote.findUniqueOrThrow({ where: { id: issued.clinicalNoteId } })).status, // prettier-ignore
      ).toBe('ENTERED_IN_ERROR');
      expect(await prisma.referral.count()).toBe(1);
      expect(await trail('referral', issued.id, 'UPDATE')).toBe(1);

      const again = await send('post', `/encounters/${encounterId}/referrals/${issued.id}/cancel`, doctorToken, { reason: 'Otra vez' }).expect(409); // prettier-ignore
      expect((again.body as Problem).code).toBe('REFERRAL_ALREADY_CANCELLED');
    });

    it('EN-107 la referencia de otra atención no se anula desde ésta', async () => {
      const own = await openEncounter();
      const other = await openEncounter();
      const issued = await issue(other);

      const refused = await send('post', `/encounters/${own}/referrals/${issued.id}/cancel`, doctorToken, { reason: 'Error' }).expect(404); // prettier-ignore
      expect((refused.body as Problem).code).toBe('REFERRAL_NOT_FOUND');
      // Positive control: from its own attention.
      await send('post', `/encounters/${other}/referrals/${issued.id}/cancel`, doctorToken, { reason: 'Error' }).expect(200); // prettier-ignore
    });
  });

  describe('EN-105 el alta «Referido»', () => {
    it('EN-105 firmar con «Referido» sin referencia se rechaza por campo; con ella firma, y su última referencia ya no se anula', async () => {
      const encounterId = await openEncounter();
      const noteId = await readyToSign(encounterId);

      const refused = await send('post', `/encounters/${encounterId}/notes/${noteId}/sign`, doctorToken, { dischargeCondition: 'REFERRED' }).expect(422); // prettier-ignore
      expect((refused.body as Problem).code).toBe(
        'REFERRAL_REQUIRED_ON_DISCHARGE',
      );
      expect((refused.body as Problem).errors?.[0]?.field).toBe('dischargeCondition'); // prettier-ignore

      const issued = await issue(encounterId);
      await send('post', `/encounters/${encounterId}/notes/${noteId}/sign`, doctorToken, { dischargeCondition: 'REFERRED' }).expect(200); // prettier-ignore

      const last = await send('post', `/encounters/${encounterId}/referrals/${issued.id}/cancel`, doctorToken, { reason: 'Error' }).expect(422); // prettier-ignore
      expect((last.body as Problem).code).toBe(
        'REFERRAL_REQUIRED_ON_DISCHARGE',
      );
      // EN-130. After the discharge nothing new is issued.
      await send('post', `/encounters/${encounterId}/referrals`, doctorToken, REFERRAL).expect(409); // prettier-ignore
    });
  });

  describe('EN-103 la interconsulta', () => {
    it('EN-103 EN-104 la solicitada escribe su 007; la recibida no escribe ninguno y nace contestada por quien la registra', async () => {
      const encounterId = await openEncounter();

      const asked = await send('post', `/encounters/${encounterId}/interconsultations`, doctorToken, { role: 'REQUESTED', reason: 'Valorar soplo sistólico', findings: '¿Soplo funcional?' }).expect(201); // prettier-ignore
      const askedBody = asked.body as { id: string; clinicalNoteId: string; status: string }; // prettier-ignore
      expect(askedBody.status).toBe('REQUESTED');
      const note = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: askedBody.clinicalNoteId } }); // prettier-ignore
      expect(note).toMatchObject({ formCode: '007', status: 'SIGNED' });
      expect(note.content).toMatchObject({ tipo: 'Interconsulta solicitada', motivo: 'Valorar soplo sistólico' }); // prettier-ignore

      const received = await send('post', `/encounters/${encounterId}/interconsultations`, doctorToken, { role: 'RECEIVED', requestedByName: 'Medicina interna, Hospital del IESS', reason: 'Valorar soplo', opinion: 'Soplo funcional, sin tratamiento' }).expect(201); // prettier-ignore
      expect(received.body).toMatchObject({ role: 'RECEIVED', status: 'ANSWERED', clinicalNoteId: null }); // prettier-ignore
      expect(await prisma.clinicalNote.count({ where: { formCode: '007' } })).toBe(1); // prettier-ignore

      await send('post', `/encounters/${encounterId}/interconsultations`, doctorToken, { role: 'RECEIVED', reason: 'Valorar soplo' }).expect(422); // prettier-ignore

      await send('post', `/encounters/${encounterId}/interconsultations/${askedBody.id}/cancel`, doctorToken, { reason: 'Pedida por error' }).expect(200); // prettier-ignore
      expect(
        (await prisma.clinicalNote.findUniqueOrThrow({ where: { id: askedBody.clinicalNoteId } })).status, // prettier-ignore
      ).toBe('ENTERED_IN_ERROR');
      expect(await prisma.interconsultation.count()).toBe(2);
    });
  });

  describe('EN-243 el formulario en PDF', () => {
    it('EN-243 se descarga el 053 compuesto desde su nota, con bitácora; fuera de sede y para una nota 002 no hay documento', async () => {
      await prisma.documentTemplate.create({
        data: {
          kind: 'ENCOUNTER_SUMMARY',
          version: 1,
          accentColour: '#1f6f8b',
          publishedById: doctorUserId,
        },
      });
      const encounterId = await openEncounter();
      const issued = await issue(encounterId);

      const pdf = await send('get', `/documents/clinical-forms/${issued.clinicalNoteId}`, doctorToken) // prettier-ignore
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200); // prettier-ignore
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(await trail('clinical_note', issued.clinicalNoteId, 'PRINT')).toBe(1); // prettier-ignore
      expect(await prisma.documentRender.count()).toBe(0);

      await send('get', `/documents/clinical-forms/${issued.clinicalNoteId}`, elsewhereDoctorToken).expect(404); // prettier-ignore
      const consultation = await send('post', `/encounters/${encounterId}/notes`, doctorToken, { formCode: '002', content: COMPLETE_002 }).expect(201); // prettier-ignore
      await send('get', `/documents/clinical-forms/${(consultation.body as { id: string }).id}`, doctorToken).expect(404); // prettier-ignore
      expect(await trail('clinical_note', issued.clinicalNoteId, 'PRINT')).toBe(1); // prettier-ignore
    });
  });
});
