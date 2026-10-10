import { createHmac } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  SAMPLE_REGISTRY_FILE,
  importSriRucRegistry,
} from '../../prisma/import-sri-ruc.mts';
import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { closeApp, listenForTests } from './setup/http-server';
import { IDENTITY_LOOKUP_TEST_DIGEST_KEY } from './setup/test-env';

/**
 * D-206 by HTTP against a real PostgreSQL 18: the switch, the imported SRI
 * registry, the trail and who may ask. The provider is absent here on purpose
 * (test-env.ts): it is tested against a local double in its own spec.
 */
const PASSWORD = 'el caballo come alfalfa';

/** Synthetic cedulas with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';
const RECEPCION_CEDULA = '0926687856';
const CAJA_CEDULA = '1104680135';
/** In `prisma/catastro/sri-ruc-muestra.csv`, invented. */
const IN_REGISTRY = '1701000018';
const COMPOUND = '1701000026';
/** Valid, and in no source. */
const NOWHERE = '1701000109';

interface ProposalBody {
  proposal: null | (Record<string, unknown> & { lookedUpAt: string });
}
interface ProblemBody {
  code: string;
  errors?: { field: string }[];
}

const digestOf = (cedula: string) =>
  createHmac('sha256', IDENTITY_LOOKUP_TEST_DIGEST_KEY)
    .update(cedula)
    .digest('hex');

describe('proposing names by cedula, by HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let admin: string;
  let recepcion: string;
  let recepcionId: string;

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

    admin = (await signIn('gerencia@clinica.ec', 'ADMIN', ADMIN_CEDULA)).token;
    const desk = await signIn('recepcion@clinica.ec', 'RECEPCION', RECEPCION_CEDULA); // prettier-ignore
    recepcion = desk.token;
    recepcionId = desk.userId;
    await importSriRucRegistry(prisma, {
      file: SAMPLE_REGISTRY_FILE,
      now: new Date(),
    });
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'RECEPCION' | 'CAJA',
    cedula: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } }); // prettier-ignore
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id } }); // prettier-ignore
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  const propose = (body: unknown, token = recepcion) =>
    request(app.getHttpServer())
      .post('/api/v1/identity-lookup/proposals')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  const setEnabled = (externalSourcesEnabled: boolean, token = admin) =>
    request(app.getHttpServer())
      .put('/api/v1/identity-lookup/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ externalSourcesEnabled });

  const lookupTrail = () =>
    prisma.accessAudit.findMany({
      where: { resourceType: { startsWith: 'identity_lookup:' } },
      orderBy: { id: 'asc' },
    });

  it('IL-002 proposes nothing and asks nothing while the switch was never turned on', async () => {
    const response = await propose({ cedula: IN_REGISTRY }).expect(200);

    expect(response.body).toEqual({ proposal: null });
    expect(await lookupTrail()).toEqual([]);
    // Positive control: the very same request with the switch on proposes.
    await setEnabled(true).expect(200);
    expect(((await propose({ cedula: IN_REGISTRY }).expect(200)).body as ProposalBody).proposal).not.toBeNull(); // prettier-ignore
  });

  it('IL-001 IL-005 proposes the registry name split by the order of the cedula, marked for review', async () => {
    await setEnabled(true).expect(200);

    const body = (await propose({ cedula: COMPOUND }).expect(200)).body as ProposalBody; // prettier-ignore

    expect(body.proposal).toMatchObject({
      source: 'SRI_RUC_REGISTRY',
      sourceName: 'DE LA TORRE ALBA LUIS FERNANDO',
      familyName: 'DE LA TORRE',
      secondFamilyName: 'ALBA',
      givenName: 'LUIS',
      secondGivenName: 'FERNANDO',
      birthDate: null,
      orderToReview: true,
    });
    expect(Number.isNaN(Date.parse(body.proposal!.lookedUpAt))).toBe(false);
  });

  it('IL-001 answers 200 with no proposal for a valid cedula no source has', async () => {
    await setEnabled(true).expect(200);
    expect((await propose({ cedula: NOWHERE }).expect(200)).body).toEqual({ proposal: null }); // prettier-ignore
  });

  it('IL-006 leaves who, when, the source and the digest in the trail — never the cedula nor the name', async () => {
    await setEnabled(true).expect(200);
    await propose({ cedula: IN_REGISTRY }).expect(200);
    await propose({ cedula: NOWHERE }).expect(200);

    const trail = await lookupTrail();
    expect(
      trail.map((row) => [
        row.resourceType,
        row.resourceId,
        row.userId,
        row.action,
      ]),
    ).toEqual([
      // prettier-ignore
      ['identity_lookup:sri_ruc_registry', digestOf(IN_REGISTRY), recepcionId, 'READ'], // prettier-ignore
      ['identity_lookup:sri_ruc_registry', digestOf(NOWHERE), recepcionId, 'READ'], // prettier-ignore
    ]);
    const written = JSON.stringify(trail, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)); // prettier-ignore
    expect(written).not.toContain(IN_REGISTRY);
    expect(written).not.toContain('GUAMAN');
  });

  it('IL-004 refuses an invalid cedula with 422 on the field, and asks nothing', async () => {
    await setEnabled(true).expect(200);

    const response = await propose({ cedula: '1701000019' }).expect(422);

    const problem = response.body as ProblemBody;
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors).toEqual([
      expect.objectContaining({ field: 'cedula' }),
    ]);
    expect(await lookupTrail()).toEqual([]);
  });

  it('IL-011 takes ONE cedula: a list is refused, not half-read', async () => {
    await setEnabled(true).expect(200);
    await propose({ cedula: IN_REGISTRY, cedulas: [COMPOUND] }).expect(422);
    await propose({ cedula: [IN_REGISTRY, COMPOUND] }).expect(422);
    expect(await lookupTrail()).toEqual([]);
  });

  it('IL-011 demands patient:write: the cashier is refused where reception is answered', async () => {
    await setEnabled(true).expect(200);
    const caja = (await signIn('caja@clinica.ec', 'CAJA', CAJA_CEDULA)).token;

    await propose({ cedula: IN_REGISTRY }, caja).expect(403);
    await propose({ cedula: IN_REGISTRY }).expect(200);
  });

  it('IL-010 reads the switch and the sources, and records who changed it from what to what', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/identity-lookup/settings')
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(before.body).toMatchObject({
      externalSourcesEnabled: false,
      registry: { fileName: 'sri-ruc-muestra.csv', people: 6 },
      providerConfigured: false,
      digestKeyConfigured: true,
    });

    const after = await setEnabled(true).expect(200);
    expect((after.body as { externalSourcesEnabled: boolean }).externalSourcesEnabled).toBe(true); // prettier-ignore
    await setEnabled(false).expect(200);

    const changes = await prisma.accessAudit.findMany({
      where: { resourceType: 'configuration', resourceId: 'identity-lookup' },
      orderBy: { id: 'asc' },
    });
    expect(changes.map((c) => [c.action, c.before, c.after])).toEqual([
      ['UPDATE', { externalSourcesEnabled: false }, { externalSourcesEnabled: true }], // prettier-ignore
      ['UPDATE', { externalSourcesEnabled: true }, { externalSourcesEnabled: false }], // prettier-ignore
    ]);
  });

  it('IL-010 lets reception neither read nor change the switch', async () => {
    await setEnabled(true, recepcion).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/identity-lookup/settings')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(403);
    // Positive control: the administrator can.
    await setEnabled(true).expect(200);
  });
});
