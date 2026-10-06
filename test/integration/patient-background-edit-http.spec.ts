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

import { useDatabase } from './setup/database';
import { createPatient, createSite } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * EN-224, EN-225 and EN-226 as the browser (and, D-127.5, an assistant)
 * reaches them: the routes, their permissions with a REAL session, and the
 * exact `code` of every refusal under RFC 9457.
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface AllergyBody {
  id: string;
  substanceConceptId: string | null;
  substanceText: string;
  reaction: string | null;
  criticality: string;
  refutedAt: string | null;
  refutedNotes: string | null;
  changedAt: string | null;
  changedBy: { id: string; name: string } | null;
}

describe('alergias y antecedentes editables por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let patientId: string;
  let doctorToken: string;
  let nurseToken: string;

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
    doctorToken = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    nurseToken = await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283'); // prettier-ignore
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /** Synthetic cedulas with a computed check digit, never a real person's. */
  async function signIn(roleCode: string, email: string, cedula: string) {
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
    await prisma.practitioner.create({ data: { userId: user.id } });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId },
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const send =
    (method: 'post' | 'patch') =>
    (path: string, token: string, body?: object) =>
      request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {});
  const post = send('post');
  const patch = send('patch');
  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  async function anAllergy(
    substanceText = 'Penisilina',
    criticality: 'LOW' | 'HIGH' | 'UNABLE_TO_ASSESS' = 'LOW',
    substanceConceptId?: string,
  ): Promise<string> {
    const response = await post(
      `/patients/${patientId}/allergies`,
      nurseToken,
      { substanceText, criticality, substanceConceptId },
    ).expect(201);
    return (response.body as { id: string }).id;
  }

  async function aHistoryEntry(): Promise<string> {
    const response = await post(`/patients/${patientId}/history`, nurseToken, {
      kind: 'PERSONAL',
      description: 'Asma',
    }).expect(201);
    return (response.body as { id: string }).id;
  }

  it('EN-224 descarta una alergia y un antecedente sin motivo, y guarda el de la lista cuando se envía', async () => {
    const allergyId = await anAllergy();
    const otherId = await anAllergy('Látex');
    const historyId = await aHistoryEntry();

    const silent = await post(
      `/patients/${patientId}/allergies/${allergyId}/refute`,
      doctorToken,
    ).expect(200);
    const reasoned = await post(
      `/patients/${patientId}/allergies/${otherId}/refute`,
      doctorToken,
      { notes: 'Tolera la sustancia' },
    ).expect(200);
    const history = await post(
      `/patients/${patientId}/history/${historyId}/refute`,
      doctorToken,
      {},
    ).expect(200);

    expect((silent.body as AllergyBody).refutedNotes).toBeNull();
    expect((silent.body as AllergyBody).refutedAt).not.toBeNull();
    expect((reasoned.body as AllergyBody).refutedNotes).toBe('Tolera la sustancia'); // prettier-ignore
    expect((history.body as { refutedNotes: string | null }).refutedNotes).toBeNull(); // prettier-ignore
  });

  it('EN-224 el motivo admite hasta 2000 caracteres, y uno más se rechaza por campo', async () => {
    const allergyId = await anAllergy();
    const otherId = await anAllergy('Látex');

    const refused = await post(
      `/patients/${patientId}/allergies/${allergyId}/refute`,
      doctorToken,
      { notes: 'x'.repeat(2001) },
    ).expect(422);
    expect((refused.body as Problem).errors?.[0]?.field).toBe('notes');

    // Control positivo: 2000 entran.
    await post(
      `/patients/${patientId}/allergies/${otherId}/refute`,
      doctorToken,
      { notes: 'x'.repeat(2000) },
    ).expect(200);
  });

  it('EN-224 reactiva lo descartado por error, y reactivar lo vigente responde 409', async () => {
    const allergyId = await anAllergy();
    const historyId = await aHistoryEntry();

    const notRefuted = await post(
      `/patients/${patientId}/allergies/${allergyId}/reactivate`,
      nurseToken,
    ).expect(409);
    expect((notRefuted.body as Problem).code).toBe('ALLERGY_NOT_REFUTED');
    const historyNotRefuted = await post(
      `/patients/${patientId}/history/${historyId}/reactivate`,
      nurseToken,
    ).expect(409);
    expect((historyNotRefuted.body as Problem).code).toBe(
      'HISTORY_NOT_REFUTED',
    );

    await post(`/patients/${patientId}/allergies/${allergyId}/refute`, doctorToken).expect(200); // prettier-ignore
    await post(`/patients/${patientId}/history/${historyId}/refute`, doctorToken).expect(200); // prettier-ignore

    // Enfermería reactiva: devolverla a activa es registrar lo que el
    // paciente declara (`background:write`), no descartar.
    const back = await post(
      `/patients/${patientId}/allergies/${allergyId}/reactivate`,
      nurseToken,
    ).expect(200);
    await post(
      `/patients/${patientId}/history/${historyId}/reactivate`,
      nurseToken,
    ).expect(200);
    expect((back.body as AllergyBody).refutedAt).toBeNull();

    const versions = await get(
      `/patients/${patientId}/allergies/${allergyId}/versions`,
      doctorToken,
    ).expect(200);
    const items = (versions.body as { items: { allergy: AllergyBody }[] }).items; // prettier-ignore
    expect(items).toHaveLength(2);
    expect(items[0]?.allergy.refutedAt).not.toBeNull();
  });

  it('EN-225 edita una alergia en su fila y sirve la versión anterior', async () => {
    const allergyId = await anAllergy('Penisilina', 'HIGH');

    // Editar cambia lo que se comprueba al recetar: es juicio clínico, como
    // descartar (`record:write`). Control positivo: el médico sí.
    await patch(`/patients/${patientId}/allergies/${allergyId}`, nurseToken, {
      substanceText: 'Penicilina',
    }).expect(403);
    const edited = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      {
        substanceText: 'Penicilina',
        reaction: 'Anafilaxia',
        criticality: 'LOW',
      },
    ).expect(200);

    expect(edited.body).toMatchObject({
      id: allergyId,
      substanceText: 'Penicilina',
      reaction: 'Anafilaxia',
      criticality: 'LOW',
    });
    expect((edited.body as AllergyBody).changedAt).not.toBeNull();

    const versions = await get(
      `/patients/${patientId}/allergies/${allergyId}/versions`,
      doctorToken,
    ).expect(200);
    expect(versions.body).toMatchObject({
      items: [
        {
          version: 1,
          replacedBy: { name: 'Ana Villacís' },
          allergy: { substanceText: 'Penisilina', criticality: 'HIGH' },
        },
      ],
    });
  });

  it('EN-225 rechaza editar una alergia descartada, un campo que no existe y el concepto sin su nombre', async () => {
    const allergyId = await anAllergy();

    const unknown = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      { patientId },
    ).expect(422);
    expect((unknown.body as Problem).code).not.toBe('ALLERGY_ALREADY_REFUTED');
    const conceptAlone = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      { substanceConceptId: patientId },
    ).expect(422);
    expect((conceptAlone.body as Problem).errors?.[0]?.field).toBe('substanceText'); // prettier-ignore

    await post(`/patients/${patientId}/allergies/${allergyId}/refute`, doctorToken).expect(200); // prettier-ignore
    const refuted = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      { criticality: 'LOW' },
    ).expect(409);
    expect((refuted.body as Problem).code).toBe('ALLERGY_ALREADY_REFUTED');
    expect((refuted.body as Problem).title).toContain('reactívela');
  });

  it('EN-225 edita un antecedente en su fila, y el familiar sigue pidiendo parentesco', async () => {
    const historyId = await aHistoryEntry();

    const orphan = await patch(
      `/patients/${patientId}/history/${historyId}`,
      doctorToken,
      { kind: 'FAMILY' },
    ).expect(422);
    expect((orphan.body as Problem).errors?.[0]?.field).toBe('relative');

    // Control positivo: con parentesco entra.
    const edited = await patch(
      `/patients/${patientId}/history/${historyId}`,
      doctorToken,
      { kind: 'FAMILY', relative: 'Padre', description: 'Asma bronquial' },
    ).expect(200);
    expect(edited.body).toMatchObject({
      kind: 'FAMILY',
      relative: 'Padre',
      description: 'Asma bronquial',
    });

    const versions = await get(
      `/patients/${patientId}/history/${historyId}/versions`,
      doctorToken,
    ).expect(200);
    expect(versions.body).toMatchObject({
      items: [{ version: 1, entry: { kind: 'PERSONAL', description: 'Asma' } }],
    });
  });

  it('EN-226 descarta las activas y afirma en un paso; sin descartarlas todas sigue el freno', async () => {
    const allergyId = await anAllergy();
    const otherId = await anAllergy('Látex');

    // El freno sigue: afirmar sin descartar.
    const plain = await post(
      `/patients/${patientId}/allergies/none-known`,
      doctorToken,
    ).expect(409);
    expect((plain.body as Problem).code).toBe('CHART_HAS_ALLERGIES');
    // Y descartando sólo una.
    const partial = await post(
      `/patients/${patientId}/allergies/none-known/refuting-active`,
      doctorToken,
      { allergyIds: [allergyId] },
    ).expect(409);
    expect((partial.body as Problem).code).toBe('CHART_HAS_ALLERGIES');
    // Descartar es juicio clínico: enfermería no.
    await post(
      `/patients/${patientId}/allergies/none-known/refuting-active`,
      nurseToken,
      { allergyIds: [allergyId, otherId] },
    ).expect(403);

    const asserted = await post(
      `/patients/${patientId}/allergies/none-known/refuting-active`,
      doctorToken,
      { allergyIds: [allergyId, otherId] },
    ).expect(201);
    expect(asserted.body).toMatchObject({ assertedByName: 'Ana Villacís' });

    const listed = await get(`/patients/${patientId}/allergies`, doctorToken).expect(200); // prettier-ignore
    const list = listed.body as {
      items: AllergyBody[];
      noKnownAllergies: object | null;
    };
    expect(list.items.every((a) => a.refutedAt !== null)).toBe(true);
    expect(list.items.map((a) => a.refutedNotes)).toEqual([
      'Descartada al afirmar sin alergias conocidas',
      'Descartada al afirmar sin alergias conocidas',
    ]);
    expect(
      new Set((asserted.body as { refutedAllergyIds: string[] }).refutedAllergyIds), // prettier-ignore
    ).toEqual(new Set([allergyId, otherId]));
    expect(list.noKnownAllergies).not.toBeNull();
  });

  it('EN-226 retira la afirmación hecha por error, y una segunda vez no hay nada que retirar', async () => {
    await post(`/patients/${patientId}/allergies/none-known`, nurseToken).expect(201); // prettier-ignore

    await post(
      `/patients/${patientId}/allergies/none-known/retract`,
      nurseToken,
    ).expect(204);
    const listed = await get(`/patients/${patientId}/allergies`, doctorToken).expect(200); // prettier-ignore
    expect((listed.body as { noKnownAllergies: unknown }).noKnownAllergies).toBeNull(); // prettier-ignore

    const again = await post(
      `/patients/${patientId}/allergies/none-known/retract`,
      nurseToken,
    ).expect(409);
    expect((again.body as Problem).code).toBe(
      'NO_KNOWN_ALLERGIES_NOT_STANDING',
    );
    expect(await prisma.patientAllergyAbsence.count()).toBe(1);
  });
  it('EN-224 una alergia de criticidad alta sin motivo responde 422 REFUTATION_REASON_REQUIRED en notes, y con motivo se descarta (D-140.1)', async () => {
    const allergyId = await anAllergy('Penicilina', 'HIGH');

    const refused = await post(
      `/patients/${patientId}/allergies/${allergyId}/refute`,
      doctorToken,
      { notes: '   ' },
    ).expect(422);
    expect((refused.body as Problem).code).toBe('REFUTATION_REASON_REQUIRED');
    expect((refused.body as Problem).errors?.[0]).toMatchObject({
      field: 'notes',
      code: 'REFUTATION_REASON_REQUIRED',
    });

    // Control positivo: el mismo camino, con motivo.
    const refuted = await post(
      `/patients/${patientId}/allergies/${allergyId}/refute`,
      doctorToken,
      { notes: 'Descartada al emitir una receta: Prueba negativa' },
    ).expect(200);
    expect((refuted.body as AllergyBody).refutedNotes).toBe(
      'Descartada al emitir una receta: Prueba negativa',
    );
  });

  it('EN-225 EN-084 un PATCH sin substanceConceptId conserva el principio activo; un null explícito lo vacía', async () => {
    const system = await prisma.catalogSystem.upsert({
      where: { code: 'CNMB' },
      create: { code: 'CNMB', name: 'Catálogo CNMB' },
      update: {},
    });
    const concept = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'J01CA04',
        display: 'Amoxicilina',
        validFrom: new Date(Date.now() - 365 * 86_400_000),
      },
    });
    const allergyId = await anAllergy('Amoxicilna', 'LOW', concept.id);

    const retyped = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      { substanceText: 'Amoxicilina' },
    ).expect(200);
    expect(retyped.body).toMatchObject({
      substanceText: 'Amoxicilina',
      substanceConceptId: concept.id,
    });

    // Control: el null explícito sí lo vacía.
    const cleared = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      { substanceConceptId: null },
    ).expect(200);
    expect((cleared.body as AllergyBody).substanceConceptId).toBeNull();
  });

  it('EN-225 la respuesta dice quién corrigió la alergia y cuándo', async () => {
    const allergyId = await anAllergy();
    const listed = await get(`/patients/${patientId}/allergies`, doctorToken).expect(200); // prettier-ignore
    expect((listed.body as { items: AllergyBody[] }).items[0]?.changedBy).toBeNull(); // prettier-ignore

    const edited = await patch(
      `/patients/${patientId}/allergies/${allergyId}`,
      doctorToken,
      { reaction: 'Rash' },
    ).expect(200);
    expect((edited.body as AllergyBody).changedBy).toMatchObject({
      name: 'Ana Villacís',
    });
    expect((edited.body as AllergyBody).changedAt).not.toBeNull();
  });

  it('EN-226 una alergia de criticidad alta no entra en «descartar estas y afirmar»: 409 ALLERGY_REFUTED_ALONE y no se descarta ninguna (D-140.3)', async () => {
    const lowId = await anAllergy('Látex');
    const highId = await anAllergy('Penicilina', 'HIGH');

    const refused = await post(
      `/patients/${patientId}/allergies/none-known/refuting-active`,
      doctorToken,
      { allergyIds: [lowId, highId] },
    ).expect(409);
    expect((refused.body as Problem).code).toBe('ALLERGY_REFUTED_ALONE');
    const listed = await get(`/patients/${patientId}/allergies`, doctorToken).expect(200); // prettier-ignore
    expect(
      (listed.body as { items: AllergyBody[] }).items.every((a) => a.refutedAt === null), // prettier-ignore
    ).toBe(true);

    // Control positivo: descartada la alta una a una, con motivo, el paso entra.
    await post(
      `/patients/${patientId}/allergies/${highId}/refute`,
      doctorToken,
      { notes: 'Prueba negativa' },
    ).expect(200);
    const asserted = await post(
      `/patients/${patientId}/allergies/none-known/refuting-active`,
      doctorToken,
      { allergyIds: [lowId] },
    ).expect(201);
    expect((asserted.body as { refutedAllergyIds: string[] }).refutedAllergyIds).toEqual([lowId]); // prettier-ignore
  });
});
