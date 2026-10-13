import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { seedSpecialties } from '../../prisma/seed-specialties.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * B23 (BI-306 to BI-309, D-262): the «próximo número» over HTTP, with two real
 * sessions — administration fixes it, caja reads it and cannot — against a
 * real PostgreSQL 18, where the floor is checked under the point's lock.
 */
const PASSWORD = 'contraseña de prueba larga';
/** Synthetic cedulas with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';
const CAJA_CEDULA = '0926687856';

interface Problem {
  status: number;
  code: string;
  errors?: { field: string; code: string }[];
}

interface NumberingBody {
  emissionPointId: string;
  emissionPointCode: string;
  documentType: '01' | '04';
  usedUpTo: number;
  nextSequential: number | null;
  previousSystemLast: number | null;
  nextToIssue: number;
  belowPreviousSystem: boolean;
  lastChange: {
    at: string;
    by: { id: string; name: string };
    reason: string;
  } | null;
}

describe('B23 el próximo número de cada punto de emisión', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let adminToken: string;
  let adminUserId: string;
  let cajaToken: string;
  let siteId: string;
  let otherSiteId: string;
  let pointId: string;
  let otherPointId: string;

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
    await seedSpecialties(prisma);
    await seedBilling(prisma);

    siteId = (await createSite(prisma)).id;
    otherSiteId = (await createSite(prisma, 'Sede Norte')).id;
    pointId = (
      await prisma.emissionPoint.create({
        data: { siteId, code: '001', description: 'Caja principal' },
      })
    ).id;
    otherPointId = (
      await prisma.emissionPoint.create({
        data: { siteId: otherSiteId, code: '001', description: 'Norte' },
      })
    ).id;

    const admin = await signIn('gerencia@clinica.ec', 'ADMIN', ADMIN_CEDULA);
    adminToken = admin.token;
    adminUserId = admin.userId;
    cajaToken = (await signIn('caja@clinica.ec', 'CAJA', CAJA_CEDULA)).token;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'CAJA',
    cedula: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: roleCode === 'ADMIN' ? 'Gabriela' : 'Rosa',
        lastName: roleCode === 'ADMIN' ? 'Mera' : 'Cedeño',
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      token: (response.body as { accessToken: string }).accessToken,
      userId: user.id,
    };
  }

  const path = (site = siteId) => `/api/v1/billing/sites/${site}/numbering`;
  const list = (token = adminToken, site = siteId) =>
    request(app.getHttpServer())
      .get(path(site))
      .set('Authorization', `Bearer ${token}`);
  const fix = (
    body: Record<string, unknown>,
    options: {
      token?: string;
      point?: string;
      type?: string;
      site?: string;
    } = {},
  ) =>
    request(app.getHttpServer())
      .put(
        `${path(options.site)}/${options.point ?? pointId}/${options.type ?? '01'}`,
      )
      .set('Authorization', `Bearer ${options.token ?? adminToken}`)
      .send({
        nextSequential: null,
        previousSystemLast: null,
        reason: 'Venimos de otro sistema de facturación',
        ...body,
      });

  /** An invoice of this point with the given number, as an issuance leaves it. */
  async function usedUpTo(sequential: number): Promise<void> {
    const patient = await createPatient(prisma);
    const payer = await prisma.payer.findUniqueOrThrow({
      where: { code: 'PARTICULAR' },
    });
    const priceList = await prisma.priceList.findFirstOrThrow({
      where: { payerId: payer.id },
    });
    const account = await prisma.patientAccount.create({
      data: {
        patientId: patient.id,
        siteId,
        payerId: payer.id,
        priceListId: priceList.id,
      },
    });
    await prisma.invoice.create({
      data: {
        accountId: account.id,
        siteId,
        emissionPointId: pointId,
        sequential: String(sequential).padStart(9, '0'),
        buyerIdentificationType: '05',
        buyerIdentification: '1710034065',
        buyerName: 'Guamán Andrade, María José',
        subtotalTaxed: '0.00',
        subtotalUntaxed: '0.00',
        taxTotal: '0.00',
        total: '0.00',
        status: 'ISSUED',
        issuedAt: new Date(),
        issuedById: adminUserId,
      },
    });
  }

  const row = (body: { items: NumberingBody[] }, type: '01' | '04') =>
    body.items.find(
      (item) => item.emissionPointId === pointId && item.documentType === type,
    )!;

  it('BI-309 sirve cada punto con su factura y su nota de crédito, y lo que saldrá', async () => {
    await usedUpTo(18);

    const response = await list().expect(200);
    const body = response.body as { items: NumberingBody[] };

    expect(body.items).toHaveLength(2);
    expect(row(body, '01')).toMatchObject({
      emissionPointCode: '001',
      usedUpTo: 18,
      nextSequential: null,
      nextToIssue: 19,
      belowPreviousSystem: false,
      lastChange: null,
    });
    expect(row(body, '04')).toMatchObject({ usedUpTo: 0, nextToIssue: 1 });
  });

  it('BI-306 administración fija el próximo número con motivo, y queda quién y por qué', async () => {
    const response = await fix({ nextSequential: 100 }).expect(200);

    expect(response.body).toMatchObject({
      documentType: '01',
      nextSequential: 100,
      nextToIssue: 100,
      lastChange: {
        by: { id: adminUserId, name: 'Gabriela Mera' },
        reason: 'Venimos de otro sistema de facturación',
      },
    });
  });

  it('BI-306 caja lee la numeración pero no la fija', async () => {
    // Positive control first: the same session reads it.
    await list(cajaToken).expect(200);

    const refused = await fix({ nextSequential: 100 }, { token: cajaToken });
    expect(refused.status).toBe(403);

    const stored = await prisma.emissionPointNumbering.count();
    expect(stored).toBe(0);
  });

  it('BI-306 sin motivo se rechaza con NUMBERING_REASON_REQUIRED', async () => {
    const refused = await fix({ nextSequential: 100, reason: '   ' });

    expect(refused.status).toBe(422);
    expect((refused.body as Problem).code).toBe('NUMBERING_REASON_REQUIRED');
    expect((refused.body as Problem).errors?.[0]?.field).toBe('reason');
  });

  it('BI-306 un número fuera de 1 a 999999999 se rechaza nombrando el campo', async () => {
    const refused = await fix({ nextSequential: 1_000_000_000 });

    expect(refused.status).toBe(422);
    expect(
      (refused.body as Problem).errors?.map((error) => error.field),
    ).toContain('nextSequential');
  });

  it('BI-306 un punto de otra sede, o un tipo que no se numera, no existe', async () => {
    const otherSite = await fix(
      { nextSequential: 100 },
      { point: otherPointId },
    );
    expect(otherSite.status).toBe(404);
    expect((otherSite.body as Problem).code).toBe(
      'NUMBERING_EMISSION_POINT_NOT_FOUND',
    );

    const otherType = await fix({ nextSequential: 100 }, { type: '07' });
    expect(otherType.status).toBe(404);

    // Positive control: the same point in its own site.
    await fix(
      { nextSequential: 100 },
      { point: otherPointId, site: otherSiteId },
    ).expect(200);
  });

  it('BI-307 no deja fijarlo hasta el mayor usado, y dice cuál es', async () => {
    await usedUpTo(18);

    const refused = await fix({ nextSequential: 18 });
    expect(refused.status).toBe(409);
    expect((refused.body as Problem).code).toBe('NUMBERING_BELOW_USED');
    expect(JSON.stringify(refused.body)).toContain('18');

    // Positive control: the largest used plus one.
    await fix({ nextSequential: 19 }).expect(200);
  });

  it('BI-309 avisa cuando lo que saldrá no supera lo emitido en el sistema anterior', async () => {
    const below = await fix({ nextSequential: 100, previousSystemLast: 150 });
    expect(below.status).toBe(200);
    expect(below.body).toMatchObject({ belowPreviousSystem: true });

    const above = await fix({ nextSequential: 151, previousSystemLast: 150 });
    expect(above.body).toMatchObject({ belowPreviousSystem: false });
  });

  it('BI-306 sin motivo en el cuerpo, el mismo NUMBERING_REASON_REQUIRED', async () => {
    const refused = await request(app.getHttpServer())
      .put(`${path()}/${pointId}/01`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nextSequential: 100, previousSystemLast: null });
    expect(refused.status).toBe(422);
    expect((refused.body as Problem).code).toBe('NUMBERING_REASON_REQUIRED');
  });

  it('BI-307 un próximo número ya superado no impide anotar el último del sistema anterior', async () => {
    await fix({ nextSequential: 10 }).expect(200);
    await usedUpTo(18); // the floor 10 is overtaken

    const kept = await fix({ nextSequential: 10, previousSystemLast: 15 });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({
      nextSequential: 10,
      previousSystemLast: 15,
      nextToIssue: 19,
    });
    // Control: MOVING it to another overtaken number is refused.
    expect((await fix({ nextSequential: 12 })).status).toBe(409);
  });

  it('BI-306 guarda en record_version la numeración anterior', async () => {
    await fix({ nextSequential: 100 }).expect(200);
    await fix({ nextSequential: 200, reason: 'Más holgura' }).expect(200);

    const versions = await prisma.$queryRaw<{ next: number; reason: string }[]>`
      SELECT ("data" ->> 'next_sequential')::int AS "next", "data" ->> 'reason' AS "reason"
        FROM "record_version" WHERE "resource_type" = 'emission_point_numbering'`;
    expect(versions).toEqual([
      { next: 100, reason: 'Venimos de otro sistema de facturación' },
    ]);
  });
});
