import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { seedBilling } from '../../prisma/seed-billing.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * BI-110 to BI-115: the tariff on the wall (LOS art. 184), over HTTP and
 * against PostgreSQL.
 *
 * ⚠️ THE PUBLIC ROUTE IS ASKED WITHOUT ANY CREDENTIAL, and every assertion
 * about what it exposes is made on the body a stranger receives. Two real
 * sessions besides: the administrator, who publishes from the factory role
 * (D-049), and the cashier, who reads and cannot publish.
 */
const PASSWORD = 'el caballo come alfalfa';
const AGREEMENT_AMOUNT = '777.77';

interface Problem {
  status: number;
  code: string;
  title: string;
}
interface PublicTariff {
  version: number;
  effectiveFrom: string;
  establishmentName: string | null;
  items: { categoryName: string; name: string; amount: string; taxPercentage: string | null }[]; // prettier-ignore
}
interface Overview {
  items: { id: string; version: number; lineCount: number }[];
  latest: {
    id: string;
    version: number;
    differences: {
      kind: string;
      billableServiceId: string;
      published: { amount: string } | null;
      current: { amount: string } | null;
    }[];
  } | null;
}

describe('el tarifario de la pared por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let adminToken: string;
  let cashierToken: string;
  let selfPayId: string;
  let agreementPayerId: string;
  let agreementListId: string;
  let serviceId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();
    if (!app) {
      app = await buildApp(prisma, { throttled: false });
      registry = app.get(RolePermissionRegistry);
    }
    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    registry.invalidate();
    const site = await createSite(prisma);

    selfPayId = (await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } })).id; // prettier-ignore
    const agreement = await prisma.payer.findUniqueOrThrow({
      where: { code: 'IESS' },
      select: { id: true, priceLists: { select: { id: true } } },
    });
    agreementPayerId = agreement.id;
    agreementListId = agreement.priceLists[0]!.id;
    serviceId = (await prisma.billableService.findUniqueOrThrow({ where: { code: 'CONS-MG-PV' } })).id; // prettier-ignore

    // Clinic-wide, as `assertClinicWideScope` demands for the tariff (D-023).
    adminToken = await signIn(prisma, app, 'admin@clinica.ec', 'ADMIN', null, '1710034065'); // prettier-ignore
    cashierToken = await signIn(prisma, app, 'caja@clinica.ec', 'CAJA', site.id, '0919176818'); // prettier-ignore
  }

  const api = () => request(app.getHttpServer());
  const wall = () => api().get('/api/v1/public/tariff');
  const today = () => clinicalDateOf(new Date());

  function publish(token = adminToken) {
    return api()
      .post('/api/v1/billing/tariff-publications')
      .set('Authorization', `Bearer ${token}`);
  }
  async function overview(): Promise<Overview> {
    const response = await api()
      .get('/api/v1/billing/tariff-publications')
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    return response.body as Overview;
  }
  async function setPrice(payerId: string, amount: string): Promise<void> {
    await api()
      .post(`/api/v1/billing/payers/${payerId}/prices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ billableServiceId: serviceId, amount, effectiveFrom: today() })
      .expect(201);
  }
  async function selfPayAmountToday(): Promise<string> {
    const day = new Date(`${today()}T00:00:00Z`);
    const row = await prisma.price.findFirstOrThrow({
      where: {
        billableServiceId: serviceId,
        priceList: { payerId: selfPayId },
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gt: day } }],
      },
    });
    return row.amount.toFixed(2);
  }

  it('BI-110 BI-112 BI-114 sin sesión y sin publicación dice que no hay tarifario; publicado, lo enseña con versión y vigencia', async () => {
    const before = await wall().expect(404);
    expect((before.body as Problem).code).toBe('TARIFF_PUBLICATION_NOT_FOUND');
    expect((before.body as Problem).title).toBe(
      'La clínica todavía no ha publicado su tarifario',
    );

    await publish().expect(201);
    const response = await wall().expect(200);
    const body = response.body as PublicTariff;

    expect(body.version).toBe(1);
    expect(body.effectiveFrom).toBe(today());
    expect(body.establishmentName).toBe('Clínica de Pruebas S.A.');
    expect(body.items.length).toBeGreaterThan(0);
    const consultation = body.items.find((item) =>
      item.name.startsWith('Consulta de medicina general'),
    );
    expect(consultation?.amount).toBe(await selfPayAmountToday());

    // BI-114: by category, then name, as the sheet is read.
    const order = body.items.map((item) => [item.categoryName, item.name]);
    const sorted = [...order].sort(
      ([ca, na], [cb, nb]) =>
        ca!.localeCompare(cb!, 'es') || na!.localeCompare(nb!, 'es'),
    );
    expect(order).toEqual(sorted);
  });

  it('BI-112 la respuesta pública lleva exactamente lo publicado: ni ids, ni códigos, ni autor, ni pagador', async () => {
    await publish().expect(201);
    const response = await wall().expect(200);
    const body = response.body as PublicTariff;
    const text = JSON.stringify(body);

    expect(Object.keys(body).sort()).toEqual([
      'effectiveFrom',
      'establishmentName',
      'items',
      'version',
    ]);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'amount',
        'categoryName',
        'name',
        'taxPercentage',
      ]);
    }
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).not.toContain('Cedeño');
    expect(text).not.toContain('CONS-MG-PV');
    expect(text).not.toContain('IESS');
  });

  it('BI-111 ningún parámetro la desvía a la lista de un convenio', async () => {
    // Positive control: the agreement's price exists and the staff can read it.
    await setPrice(agreementPayerId, AGREEMENT_AMOUNT);
    const agreementList = await api()
      .get(`/api/v1/billing/payers/${agreementPayerId}/prices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(JSON.stringify(agreementList.body)).toContain(AGREEMENT_AMOUNT);

    await publish().expect(201);
    const plain = await wall().expect(200);
    const steered = await api()
      .get('/api/v1/public/tariff')
      .query({
        payerId: agreementPayerId,
        priceListId: agreementListId,
        payer: 'IESS',
        version: '0',
      })
      .expect(200);

    expect(JSON.stringify(plain.body)).not.toContain(AGREEMENT_AMOUNT);
    expect(steered.body).toEqual(plain.body);
  });

  it('BI-113 cada publicación es una versión nueva, la anterior se conserva y se lee tal como se copió', async () => {
    const first = (await publish().expect(201)).body as { id: string; version: number }; // prettier-ignore
    const old = await selfPayAmountToday();
    await setPrice(selfPayId, '41.25');
    const second = (await publish().expect(201)).body as { version: number };

    expect([first.version, second.version]).toEqual([1, 2]);
    expect((await overview()).items.map((item) => item.version)).toEqual([2, 1]); // prettier-ignore

    const kept = await api()
      .get(`/api/v1/billing/tariff-publications/${first.id}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    const line = (kept.body as { items: { billableServiceId: string; amount: string }[] }).items.find(
      (item) => item.billableServiceId === serviceId,
    ); // prettier-ignore
    expect(line?.amount).toBe(old);

    const audit = await prisma.accessAudit.count({
      where: { resourceType: 'tariff_publication', action: 'CREATE' },
    });
    expect(audit).toBe(2);
  });

  it('BI-113 publicar exige tariff:publish: caja lo lee y no lo publica', async () => {
    // Positive control: the cashier reaches the same resource for reading.
    await overview();
    const refused = await publish(cashierToken).expect(403);
    expect((refused.body as Problem).status).toBe(403);
    expect(await prisma.tariffPublication.count()).toBe(0);
  });

  it('BI-115 cambiar un precio la deja desactualizada, no la cambia sola, y publicar otra vez la pone al día', async () => {
    await publish().expect(201);
    const published = await selfPayAmountToday();
    expect((await overview()).latest?.differences).toEqual([]);

    await setPrice(selfPayId, '43.10');

    const stale = (await overview()).latest;
    expect(stale?.version).toBe(1);
    expect(stale?.differences).toEqual([
      expect.objectContaining({
        kind: 'PRICE_CHANGED',
        billableServiceId: serviceId,
        published: expect.objectContaining({ amount: published }),
        current: expect.objectContaining({ amount: '43.10' }),
      }),
    ]);
    const still = (await wall().expect(200)).body as PublicTariff;
    expect(JSON.stringify(still)).not.toContain('43.10');

    await publish().expect(201);
    expect((await overview()).latest?.differences).toEqual([]);
    expect(JSON.stringify((await wall().expect(200)).body)).toContain('43.10');
  });

  it('BI-111 sin prestaciones activas con precio no publica un cartel vacío (TARIFF_PUBLICATION_EMPTY)', async () => {
    await publish().expect(201); // positive control: the same route publishes
    await prisma.billableService.updateMany({ data: { active: false } });

    const refused = await publish().expect(409);
    expect((refused.body as Problem).code).toBe('TARIFF_PUBLICATION_EMPTY');
    expect((refused.body as Problem).title).toBe(
      'No hay prestaciones activas con precio particular vigente que publicar',
    );
    expect(await prisma.tariffPublication.count()).toBe(1);
  });

  it('BI-113 la base no deja reescribir ni borrar lo publicado', async () => {
    await publish().expect(201);
    // Positive control: the rows exist, so an UPDATE that fails is the trigger.
    expect(await prisma.tariffPublicationItem.count()).toBeGreaterThan(0);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "tariff_publication_item" SET "amount" = 0`,
      ),
    ).rejects.toThrow(/tariff_publication_immutable/);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "tariff_publication" SET "version" = 9`),
    ).rejects.toThrow(/tariff_publication_immutable/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "tariff_publication_item"`),
    ).rejects.toThrow(/tariff_publication_immutable/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "tariff_publication"`),
    ).rejects.toThrow(/tariff_publication_immutable/);
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE "tariff_publication_item"`),
    ).rejects.toThrow(/tariff_publication_immutable/);
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE "tariff_publication" CASCADE`),
    ).rejects.toThrow(/tariff_publication_immutable/);
  });

  it('BI-113 dos administradores publicando a la vez reciben versiones consecutivas, no un rechazo', async () => {
    const [first, second] = await Promise.all([publish(), publish()]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const versions = [first, second]
      .map((response) => (response.body as { version: number }).version)
      .sort();
    expect(versions).toEqual([1, 2]);
  });

  it('BI-113 publicar exige el permiso en toda la clínica, no en una sede', async () => {
    const site = await prisma.site.findFirstOrThrow();
    const siteAdmin = await signIn(prisma, app, 'sede@clinica.ec', 'ADMIN', site.id, '1713175071'); // prettier-ignore

    const refused = await publish(siteAdmin).expect(403);
    expect((refused.body as Problem).code).toBe('SITE_SCOPE_DENIED');
    // Positive control: the clinic-wide administrator publishes.
    await publish().expect(201);
  });

  it('BI-113 la bitácora dice quién publicó y desde dónde', async () => {
    const published = (await publish().set('User-Agent', 'pantalla-de-prueba').expect(201)).body as { id: string }; // prettier-ignore
    const entry = await prisma.accessAudit.findFirstOrThrow({
      where: { resourceType: 'tariff_publication', resourceId: published.id },
    });
    expect(entry.action).toBe('CREATE');
    expect(entry.userAgent).toBe('pantalla-de-prueba');
  });

  it('BI-113 la base no admite dos publicaciones con la misma versión', async () => {
    const published = (await publish().expect(201)).body as { id: string };
    const row = await prisma.tariffPublication.findUniqueOrThrow({
      where: { id: published.id },
    });

    await expect(
      prisma.tariffPublication.create({
        data: {
          version: row.version,
          effectiveFrom: row.effectiveFrom,
          publishedAt: row.publishedAt,
          publishedById: row.publishedById,
          priceListId: row.priceListId,
        },
      }),
    ).rejects.toThrow();
    // Positive control: the next version goes in.
    await prisma.tariffPublication.create({
      data: {
        version: row.version + 1,
        effectiveFrom: row.effectiveFrom,
        publishedAt: row.publishedAt,
        publishedById: row.publishedById,
        priceListId: row.priceListId,
      },
    });
  });
});

describe('el tarifario de la pared con su límite de peticiones', () => {
  const db = useDatabase();
  let app: NestExpressApplication;

  afterAll(async () => {
    await closeApp(app);
  });

  it('BI-112 la ruta pública admite 30 peticiones por minuto y responde 429 a la siguiente', async () => {
    app ??= await buildApp(db(), { throttled: true });
    const server = app.getHttpServer();

    // Positive control: the first thirty are answered (404: nothing published).
    for (let index = 0; index < 30; index += 1) {
      await request(server).get('/api/v1/public/tariff').expect(404);
    }
    await request(server).get('/api/v1/public/tariff').expect(429);
  });
});

async function buildApp(
  prisma: PrismaClient,
  options: { throttled: boolean },
): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma);
  if (!options.throttled) {
    // The STORE is replaced, not the guard, like the other HTTP suites.
    builder = builder.overrideProvider(ThrottlerStorage).useValue({
      increment: () =>
        Promise.resolve({
          totalHits: 1,
          timeToExpire: 1,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await listenForTests(app);
  return app;
}

async function signIn(
  prisma: PrismaClient,
  app: NestExpressApplication,
  email: string,
  roleCode: string,
  grantedSiteId: string | null,
  cedula: string,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      firstName: 'Rosa',
      lastName: 'Cedeño',
      // Synthetic cedula with a COMPUTED check digit, never a real person's.
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
  await prisma.userRoleGrant.create({
    data: { userId: user.id, roleId: role.id, siteId: grantedSiteId },
  });
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}
