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
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * BI-270 and BI-271 (D-205 §4): what «Emitir factura» is offered, read from
 * the invoices PostgreSQL really holds — issued through the route, voided and
 * returned by SQL, one at another site and one of a chart merged into this one.
 * Every buyer that must NOT be proposed sits beside one that must.
 */
const PASSWORD = 'el caballo come alfalfa';

/** Synthetic identifications with a computed check digit, never a person's. */
const PATIENT_CEDULA = '1710034065';
const FATHER_CEDULA = '0919176818';
const SPOUSE_CEDULA = '1104637283';
const VOIDED_RUC = '1793189906001';
const RETURNED_CEDULA = '1714616123';
const OTHER_SITE_CEDULA = '0102030400';
const MERGED_CEDULA = '0102030400';

interface Proposal {
  patientId: string | null;
  identification: string | null;
  email: string | null;
  frequentBuyers: {
    identificationType: string;
    identification: string;
    name: string;
    email: string | null;
  }[];
}

describe('la propuesta del receptor con el correo de la ficha (BI-270, BI-271)', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let siteId: string;
  let otherSiteId: string;
  let patientId: string;
  let payerId: string;
  let serviceId: string;
  const emissionPoints = new Map<string, string>();

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

    await seedBilling(prisma);
    await syncAuthorisation(prisma);
    registry.invalidate();

    siteId = (await createSite(prisma)).id;
    otherSiteId = (await createSite(prisma, 'Sede Sur')).id;
    patientId = (await createPatient(prisma)).id;
    await prisma.patientIdentifier.create({
      data: { patientId, type: 'CEDULA', value: PATIENT_CEDULA },
    });
    payerId = (
      await prisma.payer.findUniqueOrThrow({ where: { code: 'PARTICULAR' } })
    ).id;
    serviceId = (
      await prisma.billableService.findUniqueOrThrow({
        where: { code: 'CONS-MG-PV' },
      })
    ).id;
    emissionPoints.clear();
    for (const site of [siteId, otherSiteId]) {
      const point = await prisma.emissionPoint.create({
        data: { siteId: site, code: '001', description: 'Caja principal' },
      });
      emissionPoints.set(site, point.id);
    }
    token = await signIn();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** CAJA at BOTH sites, so the other site's invoice can be issued at all. */
  async function signIn(): Promise<string> {
    const email = 'caja@clinica.ec';
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Rosa',
        lastName: 'Cedeño',
        cedula: '1710034065',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'CAJA' },
    });
    for (const site of [siteId, otherSiteId]) {
      await prisma.userRoleGrant.create({
        data: { userId: user.id, roleId: role.id, siteId: site },
      });
    }
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const api = () => request(app.getHttpServer());

  async function openAccount(site: string, patient: string): Promise<string> {
    const response = await api()
      .post(`/api/v1/billing/sites/${site}/accounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId: patient, payerId })
      .expect(201);
    return (response.body as { id: string }).id;
  }

  /** One charge and its invoice, to whoever is named; returns the invoice. */
  async function invoiceTo(
    site: string,
    accountId: string,
    receiver: object,
  ): Promise<string> {
    await api()
      .post(`/api/v1/billing/sites/${site}/accounts/${accountId}/charges`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        billableServiceId: serviceId,
        serviceDate: clinicalDateOf(new Date()),
      })
      .expect(201);
    const response = await api()
      .post(`/api/v1/billing/sites/${site}/invoices`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId,
        emissionPointId: emissionPoints.get(site),
        paymentMethod: '01',
        receiver,
      })
      .expect(201);
    return (response.body as { id: string }).id;
  }

  const buyer = (
    identificationType: string,
    identification: string,
    name: string,
    email?: string,
  ) => ({ identificationType, identification, name, ...(email ? { email } : {}) }); // prettier-ignore

  const proposalFor = async (accountId: string): Promise<Proposal> =>
    (
      await api()
        .get(
          `/api/v1/billing/sites/${siteId}/accounts/${accountId}/invoice-receiver`,
        )
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as Proposal;

  it('BI-270 propone el correo y el identificador de la ficha, y una ficha sin correo propone null', async () => {
    const accountId = await openAccount(siteId, patientId);

    const without = await proposalFor(accountId);
    expect(without).toMatchObject({
      patientId,
      identification: PATIENT_CEDULA,
      email: null,
      frequentBuyers: [],
    });

    await prisma.patient.update({
      where: { id: patientId },
      data: { email: 'maria.guaman@correo.ec' },
    });
    expect(await proposalFor(accountId)).toMatchObject({
      patientId,
      email: 'maria.guaman@correo.ec',
    });
  });

  it('BI-270 de una ficha unificada propone el correo y el identificador de la vigente', async () => {
    const absorbed = await createPatient(prisma);
    const accountId = await openAccount(siteId, absorbed.id);
    await prisma.patient.update({
      where: { id: patientId },
      data: { email: 'vigente@correo.ec' },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE patient SET email = 'absorbida@correo.ec', merged_into_id = $2::uuid, merged_at = now() WHERE id = $1::uuid`,
      absorbed.id,
      patientId,
    );

    expect(await proposalFor(accountId)).toMatchObject({
      patientId,
      email: 'vigente@correo.ec',
    });
  });

  it('BI-271 propone los compradores de sus facturas de la sede, del más reciente, sin el paciente, ni consumidor final, ni anuladas, ni devueltas, ni de otra sede', async () => {
    const accountId = await openAccount(siteId, patientId);

    // In: the father twice (the LATEST name and e-mail win), and the spouse.
    await invoiceTo(siteId, accountId, buyer('05', FATHER_CEDULA, 'Guamán Pérez, Luis', 'viejo@correo.ec')); // prettier-ignore
    await invoiceTo(siteId, accountId, buyer('05', SPOUSE_CEDULA, 'Andrade Mora, Ana', 'ana@correo.ec')); // prettier-ignore
    await invoiceTo(siteId, accountId, buyer('05', FATHER_CEDULA, 'Guamán Pérez, Luis Alberto', 'luis@correo.ec')); // prettier-ignore

    // Out, each beside the ones that are in.
    await invoiceTo(siteId, accountId, buyer('05', PATIENT_CEDULA, 'Guamán, María')); // prettier-ignore
    await invoiceTo(siteId, accountId, { finalConsumer: { confirmed: true } });
    const voided = await invoiceTo(siteId, accountId, buyer('04', VOIDED_RUC, 'Empresa Equivocada S.A.')); // prettier-ignore
    await prisma.$executeRawUnsafe(
      `UPDATE invoice SET status = 'VOIDED' WHERE id = $1::uuid`,
      voided,
    );
    const returned = await invoiceTo(siteId, accountId, buyer('05', RETURNED_CEDULA, 'Cédula Mal Puesta')); // prettier-ignore
    await prisma.$executeRawUnsafe(
      `UPDATE invoice SET status = 'REJECTED' WHERE id = $1::uuid`,
      returned,
    );
    const otherAccount = await openAccount(otherSiteId, patientId);
    await invoiceTo(otherSiteId, otherAccount, buyer('05', OTHER_SITE_CEDULA, 'De Otra Sede, Pedro')); // prettier-ignore

    const { frequentBuyers } = await proposalFor(accountId);

    expect(frequentBuyers).toEqual([
      {
        identificationType: '05',
        identification: FATHER_CEDULA,
        name: 'Guamán Pérez, Luis Alberto',
        email: 'luis@correo.ec',
      },
      {
        identificationType: '05',
        identification: SPOUSE_CEDULA,
        name: 'Andrade Mora, Ana',
        email: 'ana@correo.ec',
      },
    ]);
  });

  it('BI-271 trae también los compradores de una ficha que se le unificó, y como mucho cinco', async () => {
    const absorbed = await createPatient(prisma);
    const absorbedAccount = await openAccount(siteId, absorbed.id);
    await invoiceTo(siteId, absorbedAccount, buyer('05', MERGED_CEDULA, 'Lema Cando, Rosa')); // prettier-ignore
    await prisma.$executeRawUnsafe(
      `UPDATE patient SET merged_into_id = $2::uuid, merged_at = now() WHERE id = $1::uuid`,
      absorbed.id,
      patientId,
    );
    const accountId = await openAccount(siteId, patientId);

    expect((await proposalFor(accountId)).frequentBuyers).toEqual([
      expect.objectContaining({ identification: MERGED_CEDULA }),
    ]);

    // Six more buyers through passports (no shape to compute): five come back.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await invoiceTo(siteId, accountId, buyer('06', `PAS00${n}`, `Pasaporte ${n}`)); // prettier-ignore
    }
    const { frequentBuyers } = await proposalFor(accountId);
    expect(frequentBuyers.map((b) => b.identification)).toEqual([
      'PAS006',
      'PAS005',
      'PAS004',
      'PAS003',
      'PAS002',
    ]);
  });
});
