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
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aTariffConcept } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createExamService, createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The form 024 as the browser consumes it (EN-152 to EN-154, BI-256, BI-257):
 * the medical direction marks the service, the doctor registers its procedure
 * with the signed paper or the exception, records a refusal with its witness
 * and revokes a signed consent — with the roles the seed ships, signed in for
 * real. What the database guarantees underneath is
 * `procedure-consent.spec.ts`.
 */
const PASSWORD = 'el caballo come alfalfa';
const HOUR = 3_600_000;

interface Problem {
  code: string;
  errors?: { field: string; code: string }[];
}

interface ServiceBody {
  id: string;
  procedureConcept: { id: string } | null;
  writtenConsent: {
    required: boolean;
    setAt: string | null;
    setBy: { id: string; name: string } | null;
  };
}

interface ConsentBody {
  id: string;
  kind: string;
  signer: string | null;
  exceptionReason: string | null;
  informedBy: { id: string } | null;
  revocation: { signer: string; revokedBy: { id: string } } | null;
}

interface ProcedureBody {
  id: string;
  consent: ConsentBody | null;
}

describe('el consentimiento 024 por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let patientId: string;
  let doctor: { token: string; userId: string; practitionerId: string };
  let adminToken: string;
  let directorToken: string;

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
    siteId = (await createSite(prisma)).id;
    patientId = (await createPatient(prisma)).id;

    doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065', siteId);
    adminToken = (await signIn('ADMIN', 'admin@clinica.ec', '1104637283', null)).token; // prettier-ignore
    // D-199.1. No shipped role carries the key: the clinic makes one.
    const direction = await prisma.role.create({
      data: {
        code: 'DIRECCION_MEDICA',
        name: 'Dirección médica',
        permissions: {
          create: [
            { permissionCode: 'record:consent-rule' },
            { permissionCode: 'billing:read' },
          ],
        },
      },
    });
    registry.invalidate();
    directorToken = (
      await signIn(direction.code, 'direccion@clinica.ec', '0926687856', null)
    ).token;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    grantSiteId: string | null,
  ): Promise<{ token: string; userId: string; practitionerId: string }> {
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
    const practitioner = await prisma.practitioner.create({ data: { userId: user.id } }); // prettier-ignore
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } }); // prettier-ignore
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grantSiteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
      practitionerId: practitioner.id,
    };
  }

  const send = (
    method: 'post' | 'patch',
    path: string,
    token: string,
    body?: object,
  ) =>
    // prettier-ignore
    request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});
  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  async function openEncounter(): Promise<string> {
    const response = await send('post', '/encounters', doctor.token, {
      siteId,
      practitionerId: doctor.practitionerId,
      patientId,
      startedAt: new Date(Date.now() - HOUR).toISOString(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    });
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  }

  /** A procedure-kind service and its tariff concept, untied. */
  async function aProcedureService() {
    const concept = await aTariffConcept(prisma);
    const service = await createExamService(prisma, {
      code: `P-${concept.code}`,
      name: 'Biopsia de piel',
      kind: 'PROCEDURE',
    });
    return { concept, service };
  }

  /** BI-257 then BI-256, through the routes. */
  async function aMarkedConcept(): Promise<string> {
    const { concept, service } = await aProcedureService();
    // `billing:price-manage` is the ADMIN's; the tie is economic.
    await send('patch', `/billing/services/${service.id}`, adminToken, {
      procedureConceptId: concept.id,
    }).expect(200);
    await send('post', `/billing/services/${service.id}/written-consent`, directorToken, { required: true }).expect(200); // prettier-ignore
    return concept.id;
  }

  it('BI-257 BI-256 la dirección médica marca la prestación atada a su procedimiento; quien administra precios, no', async () => {
    const { concept, service } = await aProcedureService();

    // Sin atadura no hay a qué aplicar la marca.
    const untied = await send('post', `/billing/services/${service.id}/written-consent`, directorToken, { required: true }); // prettier-ignore
    expect(untied.status).toBe(422);
    expect((untied.body as Problem).code).toBe('SERVICE_NOT_A_PROCEDURE');

    const tied = await send('patch', `/billing/services/${service.id}`, adminToken, { procedureConceptId: concept.id }); // prettier-ignore
    expect(tied.status).toBe(200);
    expect((tied.body as ServiceBody).procedureConcept?.id).toBe(concept.id);
    // D-179. Un dato, un sitio: el código del tarifario es el del procedimiento.
    expect((tied.body as { tariffCode: string | null }).tariffCode).toBe(
      concept.code,
    );
    expect((tied.body as ServiceBody).writtenConsent).toEqual({ required: false, setAt: null, setBy: null }); // prettier-ignore

    // ADMIN administra precios, pero la llave del 024 no es suya (D-199.1).
    await send('post', `/billing/services/${service.id}/written-consent`, adminToken, { required: true }).expect(403); // prettier-ignore

    const marked = await send('post', `/billing/services/${service.id}/written-consent`, directorToken, { required: true }); // prettier-ignore
    expect(marked.status).toBe(200);
    const body = marked.body as ServiceBody;
    expect(body.writtenConsent.required).toBe(true);
    expect(body.writtenConsent.setBy?.name).toBe('Ana Villacís');
    expect(body.writtenConsent.setAt).not.toBeNull();

    // Marcada, ni se desata, ni se cambia, ni se borra con la llave de precios.
    const untie = await send('patch', `/billing/services/${service.id}`, adminToken, { procedureConceptId: null }); // prettier-ignore
    expect(untie.status).toBe(409);
    expect((untie.body as Problem).code).toBe('SERVICE_CONSENT_TIE_LOCKED');
    const other = await aTariffConcept(prisma);
    const retie = await send('patch', `/billing/services/${service.id}`, adminToken, { procedureConceptId: other.id }); // prettier-ignore
    expect((retie.body as Problem).code).toBe('SERVICE_CONSENT_TIE_LOCKED');
    const removed = await request(app.getHttpServer())
      .delete(`/api/v1/billing/services/${service.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect((removed.body as Problem).code).toBe('SERVICE_CONSENT_TIE_LOCKED');

    // La bitácora tiene la prestación antes y después.
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'billable_service', resourceId: service.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(trail.at(-1)?.after).toMatchObject({ requiresWrittenConsent: true });
  });

  it('EN-151 EN-152 sin la marca no se pide nada; con ella, sin 024 se rechaza y con la firma o la excepción se registra', async () => {
    const encounterId = await openEncounter();
    const { concept: plain } = await aProcedureService();

    await expect(
      get(`/encounters/${encounterId}/procedure-consent-requirement?conceptId=${plain.id}`, doctor.token).then((r) => r.body as unknown), // prettier-ignore
    ).resolves.toEqual({ required: false });
    await send('post', `/encounters/${encounterId}/procedures`, doctor.token, { conceptId: plain.id, quantity: 1 }).expect(201); // prettier-ignore

    const marked = await aMarkedConcept();
    await expect(
      get(`/encounters/${encounterId}/procedure-consent-requirement?conceptId=${marked}`, doctor.token).then((r) => r.body as unknown), // prettier-ignore
    ).resolves.toEqual({ required: true });

    const missing = await send('post', `/encounters/${encounterId}/procedures`, doctor.token, { conceptId: marked, quantity: 1 }); // prettier-ignore
    expect(missing.status).toBe(422);
    expect((missing.body as Problem).code).toBe('CONSENT_024_REQUIRED');

    const late = await send('post', `/encounters/${encounterId}/procedures`, doctor.token, {
      conceptId: marked,
      quantity: 1,
      performedAt: new Date(Date.now() - HOUR / 2).toISOString(),
      consent: { kind: 'SIGNED', signer: 'PATIENT', signedAt: new Date().toISOString() },
    }); // prettier-ignore
    expect(late.status).toBe(422);
    expect((late.body as Problem).code).toBe('CONSENT_SIGNED_AFTER_PROCEDURE');

    const signed = await send('post', `/encounters/${encounterId}/procedures`, doctor.token, {
      conceptId: marked,
      quantity: 1,
      consent: {
        kind: 'SIGNED',
        signer: 'REPRESENTATIVE',
        representative: { name: 'Rosa Cedeño', relationship: 'MOTHER' },
      },
    }); // prettier-ignore
    expect(signed.status).toBe(201);
    const consent = (signed.body as ProcedureBody).consent;
    expect(consent).toMatchObject({ kind: 'SIGNED', signer: 'REPRESENTATIVE', informedBy: { id: doctor.userId } }); // prettier-ignore

    const exception = await send('post', `/encounters/${encounterId}/procedures`, doctor.token, {
      conceptId: marked,
      quantity: 1,
      consent: { kind: 'EXCEPTION', exceptionKind: 'EMERGENCY', reason: 'Paciente inconsciente, sin familiares' },
    }); // prettier-ignore
    expect(exception.status).toBe(201);
    expect((exception.body as ProcedureBody).consent).toMatchObject({ kind: 'EXCEPTION', exceptionReason: 'Paciente inconsciente, sin familiares' }); // prettier-ignore

    // La hoja de la atención los sirve con su 024.
    const sheet = await get(`/encounters/${encounterId}/procedures`, doctor.token).expect(200); // prettier-ignore
    const items = (sheet.body as { items: ProcedureBody[] }).items;
    expect(items.map((item) => item.consent?.kind ?? null)).toEqual([null, 'SIGNED', 'EXCEPTION']); // prettier-ignore
  });

  it('EN-152 EN-246 el procedimiento quitado y restaurado conserva su 024', async () => {
    const encounterId = await openEncounter();
    const marked = await aMarkedConcept();
    const signed = await send('post', `/encounters/${encounterId}/procedures`, doctor.token, {
      conceptId: marked,
      quantity: 1,
      consent: { kind: 'SIGNED', signer: 'PATIENT' },
    }).expect(201); // prettier-ignore
    const { id, consent } = signed.body as ProcedureBody;

    await send('post', `/encounters/${encounterId}/procedures/${id}/retract`, doctor.token, { reason: 'Registrado por error' }).expect(204); // prettier-ignore
    const restored = await send('post', `/encounters/${encounterId}/procedures/${id}/restore`, doctor.token).expect(200); // prettier-ignore
    expect((restored.body as ProcedureBody).id).not.toBe(id);
    expect((restored.body as ProcedureBody).consent?.id).toBe(consent?.id);
  });

  it('EN-153 la negativa sin firma pide el testigo; con él se registra y la atención sigue abierta', async () => {
    const encounterId = await openEncounter();
    const marked = await aMarkedConcept();

    const noWitness = await send('post', `/encounters/${encounterId}/procedure-refusals`, doctor.token, { conceptId: marked, signer: 'NONE' }); // prettier-ignore
    expect(noWitness.status).toBe(422);
    expect((noWitness.body as Problem).code).toBe('CONSENT_WITNESS_REQUIRED');

    const refused = await send('post', `/encounters/${encounterId}/procedure-refusals`, doctor.token, {
      conceptId: marked,
      signer: 'NONE',
      witness: { name: 'Luis Andrade', document: '1710034065' },
    }); // prettier-ignore
    expect(refused.status).toBe(201);
    expect(refused.body).toMatchObject({ signer: 'NONE', witness: { name: 'Luis Andrade' }, informedBy: { id: doctor.userId } }); // prettier-ignore

    const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
    expect(encounter.status).toBe('OPEN');
    const sheet = await get(`/encounters/${encounterId}/procedures`, doctor.token).expect(200); // prettier-ignore
    expect((sheet.body as { items: unknown[]; refusals: unknown[] }).items).toEqual([]); // prettier-ignore
    expect((sheet.body as { refusals: unknown[] }).refusals).toHaveLength(1);
  });

  it('EN-154 revoca un consentimiento firmado una vez; el original queda como estaba y la excepción no se revoca', async () => {
    const encounterId = await openEncounter();
    const marked = await aMarkedConcept();
    const signed = (
      await send('post', `/encounters/${encounterId}/procedures`, doctor.token, {
        conceptId: marked,
        quantity: 1,
        consent: { kind: 'SIGNED', signer: 'PATIENT' },
      }).expect(201)
    ).body as ProcedureBody; // prettier-ignore
    const exception = (
      await send('post', `/encounters/${encounterId}/procedures`, doctor.token, {
        conceptId: marked,
        quantity: 1,
        consent: { kind: 'EXCEPTION', exceptionKind: 'UNEXPECTED_DURING_PROCEDURE', reason: 'Hallazgo durante la intervención' },
      }).expect(201)
    ).body as ProcedureBody; // prettier-ignore
    const before = await prisma.procedureConsent.findUniqueOrThrow({ where: { id: signed.consent!.id } }); // prettier-ignore

    const revoked = await send('post', `/encounters/${encounterId}/procedure-consents/${signed.consent!.id}/revoke`, doctor.token, { signer: 'PATIENT' }); // prettier-ignore
    expect(revoked.status).toBe(200);
    expect((revoked.body as ConsentBody).revocation).toMatchObject({ signer: 'PATIENT', revokedBy: { id: doctor.userId } }); // prettier-ignore
    expect(await prisma.procedureConsent.findUniqueOrThrow({ where: { id: signed.consent!.id } })).toEqual(before); // prettier-ignore

    const twice = await send('post', `/encounters/${encounterId}/procedure-consents/${signed.consent!.id}/revoke`, doctor.token, { signer: 'PATIENT' }); // prettier-ignore
    expect(twice.status).toBe(409);
    expect((twice.body as Problem).code).toBe('CONSENT_NOT_REVOCABLE');
    const ofException = await send('post', `/encounters/${encounterId}/procedure-consents/${exception.consent!.id}/revoke`, doctor.token, { signer: 'PATIENT' }); // prettier-ignore
    expect(ofException.status).toBe(409);

    // El procedimiento sigue en la atención, con su 024 y la revocación.
    const sheet = await get(`/encounters/${encounterId}/procedures`, doctor.token).expect(200); // prettier-ignore
    const items = (sheet.body as { items: ProcedureBody[] }).items;
    expect(items[0]?.consent?.revocation?.signer).toBe('PATIENT');
  });
});
