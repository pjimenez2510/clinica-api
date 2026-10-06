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
import { createPatient, createSite, createUser } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * The prescription as the browser consumes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS OVER `prescription-issue.spec.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That file proves what PostgreSQL guarantees. This one proves everything
 * BETWEEN the browser and the database, and two things in particular that a
 * double cannot show at all:
 *
 * ⚠️ **NURSING DOES NOT PRESCRIBE (art. 168 y 198 de la LOS).** The nurse below
 * signs in for real, with the roles the seed ships, and is refused. «El defecto
 * de AG-111 fue exactamente confiar en un doble con los permisos puestos a
 * mano», and the separation of functions is the kind of rule that has to be
 * shown against the permissions the clinic actually deploys.
 *
 * ⚠️ **AND `prescription:write` NOW CHECKS SOMETHING.** It has been in
 * `permission.catalogue.ts` since authorisation was built and `MEDICO` has
 * carried it since `default-roles.ts` was written, and until this module
 * existed no route asked for it — «una promesa que el sistema no cumple».
 */
const PASSWORD = 'el caballo come alfalfa';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface PrescriptionBody {
  id: string;
  status: string;
  issuedAt: string | null;
  verificationCode: string | null;
  discardedAt: string | null;
  discardReason: string | null;
  cancelledAt: string | null;
  cancelledBy: { id: string; name: string } | null;
  cancelReason: string | null;
  encounterId: string;
  items: { id: string; line: number; genericName: string; quantity: number }[];
}

interface ComposedBody {
  prescription: PrescriptionBody;
  allergyAlerts: { line: number; allergyId: string; match: string }[];
}

interface DocumentBody {
  city: string | null;
  establishment: { name: string; mspUnicode: string };
  validity: { days: number; through: string } | null;
  patient: { fullName: string; age: { text: string } | null };
  diagnoses: { code: string; display: string }[];
  allergies: string[];
  prescriber: { fullName: string; acessRegistration: string | null };
  items: { quantity: number; quantityInWords: string; route: string }[];
}

describe('la receta por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let siteId: string;
  let encounterId: string;
  let conceptId: string;
  let patientId: string;
  let doctorToken: string;
  let nurseToken: string;
  let receptionToken: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // Sin límite de peticiones aquí, por lo mismo que en `encounter-http`:
        // este archivo hace una veintena seguidas. Se sustituye el ALMACÉN, no
        // el guard, que es precisamente lo que estas pruebas comprueban.
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

    await seed();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function seed(): Promise<void> {
    await syncAuthorisation(prisma);
    // La caché de rol→permisos se indexa por id, y al truncar los roles se
    // recrean con ids nuevos: sin esto todas las peticiones responden 403.
    registry.invalidate();

    // PR-021. La ciudad es el CANTÓN de la parroquia de la sede: el art. 5.a.ii
    // la exige y `site` no tiene columna de ciudad.
    const dpa = await prisma.catalogSystem.create({
      data: { code: 'DPA', name: 'DPA', hierarchical: true },
    });
    const canton = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '1701',
        display: 'Quito',
        validFrom: new Date('2010-01-01'),
      },
    });
    const parish = await prisma.catalogConcept.create({
      data: {
        systemId: dpa.id,
        code: '170150',
        display: 'Iñaquito',
        parentId: canton.id,
        validFrom: new Date('2010-01-01'),
      },
    });

    const site = await createSite(prisma);
    await prisma.site.update({
      where: { id: site.id },
      data: { parishConceptId: parish.id },
    });
    siteId = site.id;

    const cnmb = await prisma.catalogSystem.create({
      data: { code: 'CNMB', name: 'Cuadro Nacional de Medicamentos Básicos' },
    });
    conceptId = (
      await prisma.catalogConcept.create({
        data: {
          systemId: cnmb.id,
          code: 'J01CA04',
          display: 'Amoxicilina',
          validFrom: new Date('2019-01-01'),
        },
      })
    ).id;

    // Un lactante: es el caso en que el art. 5.b.ii exige años Y meses.
    const patient = await createPatient(prisma, {
      birthDate: new Date('2025-07-12'),
    });
    patientId = patient.id;

    const doctor = await signIn('MEDICO', 'medico@clinica.ec', '1710034065');
    doctorToken = doctor.token;
    nurseToken = (
      await signIn('ENFERMERIA', 'enfermeria@clinica.ec', '1104637283')
    ).token;
    receptionToken = (
      await signIn('RECEPCION', 'recepcion@clinica.ec', '0926687856', false)
    ).token;

    encounterId = (
      await prisma.encounter.create({
        data: {
          siteId,
          practitionerId: doctor.practitionerId as string,
          patientId,
          startedAt: new Date('2026-09-14T14:00:00Z'),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      })
    ).id;
    await aDiagnosisOn(prisma, encounterId);
  }

  /**
   * One account with one role, granted AT ONE SITE — which is what makes
   * PR-091 checkable at all.
   *
   * Las cédulas son sintéticas con dígito verificador calculado, nunca las de
   * una persona real: `app_user_cedula_valid` rechaza cualquier otra cosa.
   */
  async function signIn(
    roleCode: string,
    email: string,
    cedula: string,
    withPractitioner = true,
  ): Promise<{ token: string; practitionerId?: string }> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Ana',
        lastName: 'Villacís',
        cedula,
        // PR-034. El art. 5.d.ii imprime este número EN el documento.
        acessRegistration: withPractitioner ? `ACESS-${cedula}` : null,
        acessExpiresOn: withPractitioner ? new Date('2030-01-01') : null,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });

    const practitioner = withPractitioner
      ? await prisma.practitioner.create({
          // PR-040. El art. 5.e.vi imprime el teléfono junto a los signos de alarma.
          data: { userId: user.id, emergencyContactPhone: '0991234567' },
        })
      : undefined;

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

    return {
      token: (response.body as { accessToken: string }).accessToken,
      practitionerId: practitioner?.id,
    };
  }

  const post = (path: string, token: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  const get = (path: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  const aLine = (overrides: Record<string, unknown> = {}) => ({
    conceptId,
    dosageForm: 'CAPSULE',
    concentration: '500 mg',
    routeCode: 'ORAL',
    quantity: 20,
    doseAmount: 1,
    doseUnit: 'CAPSULE',
    frequency: 'EVERY_8_HOURS',
    durationDays: 7,
    ...overrides,
  });

  async function composeAsDoctor(items = [aLine()]): Promise<ComposedBody> {
    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      doctorToken,
      {
        // PR-038, PR-039. Art. 5.e, demanded at the issue.
        warningSigns: 'Fiebre mayor de 39 °C o dificultad para respirar',
        nonPharmacologicalAdvice: 'Abundantes líquidos y reposo relativo',
        items,
      },
    ).expect(201);
    return response.body as ComposedBody;
  }

  it('PR-090 el médico compone una receta en borrador', async () => {
    const composed = await composeAsDoctor();

    expect(composed.prescription.status).toBe('DRAFT');
    expect(composed.prescription.issuedAt).toBeNull();
    expect(composed.prescription.items).toHaveLength(1);
    // PR-008. La DCI la congela el sistema desde el CNMB, no el llamador.
    expect(composed.prescription.items[0]?.genericName).toBe('Amoxicilina');
    expect(composed.allergyAlerts).toEqual([]);
  });

  it('PR-080 y PR-081 enfermería NO prescribe', async () => {
    // La separación de funciones del art. 198 de la LOS, comprobada con una
    // sesión real y con los permisos que la clínica despliega de verdad.
    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      nurseToken,
      { items: [aLine()] },
    ).expect(403);

    expect((response.body as Problem).status).toBe(403);
  });

  it('PR-080 recepción tampoco prescribe ni lee la receta', async () => {
    await post(`/encounters/${encounterId}/prescriptions`, receptionToken, {
      items: [aLine()],
    }).expect(403);
    await get(
      `/encounters/${encounterId}/prescriptions`,
      receptionToken,
    ).expect(403);
  });

  it('PR-008 rechaza un nombre genérico enviado junto a un concepto del CNMB', async () => {
    // Descartarlo en silencio dejaría creer al llamador que el nombre que
    // escribió es el que va en la receta. Es el argumento de `BMI_IS_DERIVED`.
    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      doctorToken,
      { items: [aLine({ genericName: 'Otra cosa' })] },
    ).expect(422);

    const problem = response.body as Problem;
    expect(problem.errors?.some((e) => e.field.endsWith('genericName'))).toBe(
      true,
    );
  });

  it('PR-110 una línea fuera del CNMB sin justificación se compone y sale marcada', async () => {
    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      doctorToken,
      { items: [aLine(), aLine({ conceptId: undefined, genericName: 'Amoxicilina' })] }, // prettier-ignore
    ).expect(201);

    const items = (response.body as { prescription: { items: { offFormulary: boolean; offFormularyJustification: string | null }[] } }).prescription.items; // prettier-ignore
    expect(items.map((item) => item.offFormulary)).toEqual([false, true]);
    expect(items[1]?.offFormularyJustification).toBeNull();
  });

  it('PR-095 sin diagnóstico en la atención la receta no se emite y se nombra el campo; con él, sí', async () => {
    const composed = await composeAsDoctor();
    // EN-180. Quitado como lo quita el médico: archivado, no borrado.
    for (const { id } of await prisma.encounterDiagnosis.findMany({
      where: { encounterId },
      select: { id: true },
    })) {
      await post(`/encounters/${encounterId}/diagnoses/${id}/retract`, doctorToken).expect(204); // prettier-ignore
    }
    const path = `/prescriptions/${composed.prescription.id}/issue`;

    const refused = await post(path, doctorToken).expect(422);
    const problem = refused.body as Problem;
    expect(problem.code).toBe('PRESCRIPTION_DIAGNOSIS_REQUIRED');
    expect(problem.errors?.map((e) => e.field)).toEqual(['diagnosis']);
    expect(
      (
        await prisma.prescription.findUniqueOrThrow({
          where: { id: composed.prescription.id },
          select: { status: true },
        })
      ).status,
    ).toBe('DRAFT');

    // Control positivo: con el diagnóstico, el mismo camino emite.
    await aDiagnosisOn(prisma, encounterId);
    await post(path, doctorToken).expect(200);
  });

  it('PR-021 a PR-034 el documento lleva todo lo que el art. 5 exige', async () => {
    const composed = await composeAsDoctor();
    await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(200);

    const response = await get(
      `/prescriptions/${composed.prescription.id}`,
      doctorToken,
    ).expect(200);
    const document = response.body as DocumentBody;

    expect(document.city).toBe('Quito'); // PR-021
    expect(document.establishment.mspUnicode).toMatch(/^U/); // PR-022
    expect(document.validity?.days).toBe(3); // PR-023, PR-050
    expect(document.patient.fullName).toBe('Guamán María'); // PR-024
    // PR-025. Menor de cinco años: en años Y meses.
    expect(document.patient.age?.text).toMatch(/año.* mes/);
    expect(document.allergies).toEqual([]); // PR-027
    expect(document.items[0]?.quantity).toBe(20); // PR-030
    expect(document.items[0]?.quantityInWords).toBe('veinte'); // PR-030
    expect(document.items[0]?.route).toBe('Vía oral'); // PR-029, sin siglas
    expect(document.prescriber.fullName).toBe('Villacís Ana'); // PR-033
    expect(document.prescriber.acessRegistration).toBe('ACESS-1710034065'); // PR-034
  });

  it('PR-105 con «Dosis única» se emite sin duración y el documento no la dice; con duración se rechaza', async () => {
    const refused = await post(`/encounters/${encounterId}/prescriptions`, doctorToken, {
      items: [aLine({ frequency: 'SINGLE_DOSE', durationDays: 1 })],
    }).expect(422); // prettier-ignore
    expect(JSON.stringify(refused.body)).toContain('durationDays');

    const composed = await composeAsDoctor([
      aLine({ frequency: 'SINGLE_DOSE', durationDays: undefined, quantity: 1 }),
    ]);
    await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(200);

    const document = (
      await get(`/prescriptions/${composed.prescription.id}`, doctorToken).expect(200)
    ).body as DocumentBody; // prettier-ignore
    const item = document.items[0] as unknown as { durationDays: number | null; indications: string }; // prettier-ignore
    expect(item.durationDays).toBeNull();
    expect(item.indications).toContain('dosis única');
    expect(item.indications).not.toMatch(/durante|día/);
  });

  it('PR-005 rechaza emitir dos veces, diciendo en qué estado está', async () => {
    const composed = await composeAsDoctor();
    await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(200);

    const response = await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(409);

    const problem = response.body as Problem;
    expect(problem.code).toBe('PRESCRIPTION_NOT_EDITABLE');
    expect(problem.title).toContain('Emitida');
  });

  it('PR-010 rechaza anular un borrador y admite anular la emitida', async () => {
    const composed = await composeAsDoctor();

    // `prescription_issued_coherence` cierra el paso de `DRAFT` a `CANCELLED`,
    // y el art. 70 describe la anulación de la receta EMITIDA.
    const refused = await post(
      `/prescriptions/${composed.prescription.id}/cancel`,
      doctorToken,
      { reason: 'Pérdida' },
    ).expect(409);
    expect((refused.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');

    await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(200);
    const cancelled = await post(
      `/prescriptions/${composed.prescription.id}/cancel`,
      doctorToken,
      { reason: 'Pérdida' },
    ).expect(200);

    expect((cancelled.body as PrescriptionBody).status).toBe('CANCELLED');
    // Nada se borra: contar es la única forma de demostrarlo.
    expect(await prisma.prescription.count()).toBe(1);
  });

  it('PR-108 anular exige el motivo, y la receta anulada dice quién, cuándo y por qué', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);

    // Sin motivo, se nombra la casilla y la receta sigue vigente.
    for (const body of [undefined, { reason: '  ' }]) {
      const missing = await post(`/prescriptions/${id}/cancel`, doctorToken, body).expect(422); // prettier-ignore
      expect((missing.body as Problem).errors?.[0]?.field).toBe('reason');
    }
    expect((await prisma.prescription.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE'); // prettier-ignore

    // Control positivo: con el motivo de la lista, se anula con su registro.
    const cancelled =
      (await post(`/prescriptions/${id}/cancel`, doctorToken, { reason: 'Robo o hurto' }).expect(200)) // prettier-ignore
      .body as PrescriptionBody;
    expect(cancelled.cancelReason).toBe('Robo o hurto');
    expect(cancelled.cancelledBy?.name).toBe('Ana Villacís');
    expect(cancelled.cancelledAt).not.toBeNull();

    // DOC-109. El documento dice cuándo se anuló: la pantalla compara con él
    // el PDF vigente.
    const document = (await get(`/prescriptions/${id}`, doctorToken).expect(200)).body as { cancelledAt: string | null }; // prettier-ignore
    expect(document.cancelledAt).toBe(cancelled.cancelledAt);

    // El registro se lee en la lista de la atención, que es donde se busca.
    const listed = (
      await get(`/encounters/${encounterId}/prescriptions`, doctorToken).expect(200)
    ).body as { items: PrescriptionBody[] }; // prettier-ignore
    expect(listed.items[0]).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Robo o hurto',
      cancelledBy: { name: 'Ana Villacís' },
    });
  });

  it('PR-109 corregir devuelve la anulada y el borrador nuevo con las mismas líneas, en la misma atención', async () => {
    const composed = await composeAsDoctor([aLine(), aLine({ quantity: 10 })]);
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);
    const trail = () =>
      prisma.accessAudit.count({ where: { resourceType: 'prescription' } });
    const before = await trail();

    const response = await post(`/prescriptions/${id}/correct`, doctorToken, {
      reason: 'Error de prescripción',
    }).expect(200);

    const { cancelled, draft } = response.body as {
      cancelled: PrescriptionBody;
      draft: PrescriptionBody;
    };
    expect(cancelled).toMatchObject({
      id,
      status: 'CANCELLED',
      cancelReason: 'Error de prescripción',
    });
    expect(draft.status).toBe('DRAFT');
    expect(draft.encounterId).toBe(encounterId);
    expect(draft.items.map((item) => [item.genericName, item.quantity])).toEqual(
      [['Amoxicilina', 20], ['Amoxicilina', 10]],
    ); // prettier-ignore
    // Dos hechos, dos filas: la anulación y el borrador nuevo.
    expect(await trail()).toBe(before + 2);
    // Y el borrador se emite como cualquier otro.
    await post(`/prescriptions/${draft.id}/issue`, doctorToken).expect(200);
  });

  it('PR-109 sólo su prescriptor corrige: otro médico recibe 403 y la receta sigue vigente', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);
    const colleague = await signIn('MEDICO', 'colega@clinica.ec', '0102030400');
    const reason = { reason: 'Error de prescripción' };

    const refused = await post(`/prescriptions/${id}/correct`, colleague.token, reason).expect(403); // prettier-ignore
    expect((refused.body as Problem).code).toBe('PRESCRIPTION_OF_ANOTHER_PRESCRIBER'); // prettier-ignore
    await post(`/prescriptions/${id}/correct`, receptionToken, reason).expect(
      403,
    );
    await post(`/prescriptions/${id}/correct`, nurseToken, reason).expect(403);
    expect((await prisma.prescription.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE'); // prettier-ignore
    expect(await prisma.prescription.count()).toBe(1);

    // Control positivo: su prescriptor sí.
    await post(`/prescriptions/${id}/correct`, doctorToken, reason).expect(200);
  });

  it('PR-109 sin motivo, sobre un borrador o sobre una anulada no corrige', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    const reason = { reason: 'Error de prescripción' };

    const draft = await post(`/prescriptions/${id}/correct`, doctorToken, reason).expect(409); // prettier-ignore
    expect((draft.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');

    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);
    const missing = await post(`/prescriptions/${id}/correct`, doctorToken).expect(422); // prettier-ignore
    expect((missing.body as Problem).errors?.[0]?.field).toBe('reason');

    // Control positivo, y después la anulada ya no se corrige otra vez.
    await post(`/prescriptions/${id}/correct`, doctorToken, reason).expect(200);
    const twice = await post(`/prescriptions/${id}/correct`, doctorToken, reason).expect(409); // prettier-ignore
    expect((twice.body as Problem).title).toContain('Anulada');
    expect(await prisma.prescription.count()).toBe(2);
  });

  it('PR-109 dos «Corregir» a la vez de la misma receta: gana uno, que abre UN borrador, y el otro recibe 409 PRESCRIPTION_NOT_EDITABLE', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);
    const reason = { reason: 'Error de prescripción' };

    const responses = await Promise.all([
      post(`/prescriptions/${id}/correct`, doctorToken, reason),
      post(`/prescriptions/${id}/correct`, doctorToken, reason),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]); // prettier-ignore
    const winner = responses.find((response) => response.status === 200)!;
    const loser = responses.find((response) => response.status === 409)!;
    expect((loser.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');
    // Exactamente un borrador nuevo: el de la ganadora.
    const drafts = await prisma.prescription.findMany({
      where: { status: 'DRAFT' },
      select: { id: true },
    });
    expect(drafts).toEqual([
      { id: (winner.body as { draft: PrescriptionBody }).draft.id },
    ]);
    // Y un solo registro de la anulación, el de la ganadora.
    expect(
      await prisma.prescription.findUniqueOrThrow({
        where: { id },
        select: { status: true, cancelReason: true },
      }),
    ).toEqual({ status: 'CANCELLED', cancelReason: 'Error de prescripción' });
  });

  it('PR-011 PR-107 descarta el borrador sin pedir motivo, y guarda el que se escriba', async () => {
    // D-126: lo que no salió de la consulta se quita sin preguntar. El motivo
    // sigue siendo una columna, así que si alguien lo escribe se guarda.
    const silent = await composeAsDoctor();
    const discarded = await post(
      `/prescriptions/${silent.prescription.id}/discard`,
      doctorToken,
    ).expect(200);

    const body = discarded.body as PrescriptionBody;
    expect(body.status).toBe('DISCARDED');
    expect(body.discardReason).toBeNull();
    expect(body.discardedAt).not.toBeNull();

    const explained = await composeAsDoctor();
    const kept = await post(
      `/prescriptions/${explained.prescription.id}/discard`,
      doctorToken,
      { reason: 'Se tecleó en la atención equivocada' },
    ).expect(200);
    expect((kept.body as PrescriptionBody).discardReason).toBe(
      'Se tecleó en la atención equivocada',
    );

    // El ancho de la columna se nombra por campo, no como una restricción.
    const third = await composeAsDoctor();
    const tooLong = await post(
      `/prescriptions/${third.prescription.id}/discard`,
      doctorToken,
      { reason: 'x'.repeat(501) },
    ).expect(422);
    expect((tooLong.body as Problem).errors?.[0]?.field).toBe('reason');

    // Nada se borra: los borradores siguen en la ficha, distinguibles de la
    // medicación que el paciente sí toma.
    expect(await prisma.prescription.count()).toBe(3);
    expect(await prisma.prescriptionItem.count()).toBe(3);
  });

  it('PR-107 deshacer devuelve el borrador tal cual, con sus líneas, y deja fila de bitácora', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    const lines = composed.prescription.items.map((item) => item.id);
    await post(`/prescriptions/${id}/discard`, doctorToken, {
      reason: 'Me equivoqué de paciente',
    }).expect(200);
    const trail = await prisma.accessAudit.count({
      where: { resourceType: 'prescription', resourceId: id, action: 'UPDATE' },
    });

    const restored = await post(`/prescriptions/${id}/restore`, doctorToken).expect(200); // prettier-ignore

    const body = restored.body as PrescriptionBody;
    expect(body.id).toBe(id);
    expect(body.status).toBe('DRAFT');
    expect(body.discardedAt).toBeNull();
    expect(body.discardReason).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual(lines);
    const stored = await prisma.prescription.findUniqueOrThrow({ where: { id } }); // prettier-ignore
    expect(stored.discardedById).toBeNull();
    expect(
      await prisma.accessAudit.count({
        where: { resourceType: 'prescription', resourceId: id, action: 'UPDATE' }, // prettier-ignore
      }),
    ).toBe(trail + 1);
    // Y vuelve a ser un borrador de verdad: se emite.
    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);
  });

  it('PR-107 deshacer el descarte exige la atención viva: con la atención anulada o cerrada responde 409 PRESCRIPTION_ENCOUNTER_NOT_OPEN', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    // Positive control: with the attention live, the same door gives it back.
    await post(`/prescriptions/${id}/discard`, doctorToken).expect(200);
    await post(`/prescriptions/${id}/restore`, doctorToken).expect(200);
    await post(`/prescriptions/${id}/discard`, doctorToken).expect(200);

    const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }); // prettier-ignore
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'COMPLETED',
        endedAt: new Date(encounter.startedAt.getTime() + 3_600_000),
        dischargeCondition: 'ALIVE',
      },
    });

    const refused = await post(`/prescriptions/${id}/restore`, doctorToken).expect(409); // prettier-ignore
    expect((refused.body as Problem).code).toBe(
      'PRESCRIPTION_ENCOUNTER_NOT_OPEN',
    );
    const stored = await prisma.prescription.findUniqueOrThrow({ where: { id } }); // prettier-ignore
    expect(stored.status).toBe('DISCARDED');
  });

  it('PR-107 sólo se restaura lo descartado: un borrador vivo o una receta emitida responden 409', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;

    const alive = await post(`/prescriptions/${id}/restore`, doctorToken).expect(409); // prettier-ignore
    expect((alive.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');

    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);
    const issued = await post(`/prescriptions/${id}/restore`, doctorToken).expect(409); // prettier-ignore
    expect((issued.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');

    // Control positivo: por la misma ruta, lo descartado sí vuelve.
    const other = await composeAsDoctor();
    await post(`/prescriptions/${other.prescription.id}/discard`, doctorToken).expect(200); // prettier-ignore
    await post(`/prescriptions/${other.prescription.id}/restore`, doctorToken).expect(200); // prettier-ignore
  });

  it('PR-107 dos «Deshacer» a la vez del mismo descarte: uno lo recupera y el otro recibe 409 PRESCRIPTION_NOT_EDITABLE', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/discard`, doctorToken).expect(200);
    const updates = () =>
      prisma.accessAudit.count({
        where: { resourceType: 'prescription', resourceId: id, action: 'UPDATE' }, // prettier-ignore
      });
    const before = await updates();

    const responses = await Promise.all([
      post(`/prescriptions/${id}/restore`, doctorToken),
      post(`/prescriptions/${id}/restore`, doctorToken),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]); // prettier-ignore
    const winner = responses.find((response) => response.status === 200)!;
    const loser = responses.find((response) => response.status === 409)!;
    expect((winner.body as PrescriptionBody).status).toBe('DRAFT');
    expect((loser.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');
    // Una sola recuperación en la bitácora, y una sola receta.
    expect(await updates()).toBe(before + 1);
    expect(await prisma.prescription.count()).toBe(1);
  });

  it('PR-107 sólo su prescriptor recupera el borrador descartado', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/discard`, doctorToken).expect(200);
    const colleague = await signIn('MEDICO', 'colega@clinica.ec', '0102030400');

    const refused = await post(`/prescriptions/${id}/restore`, colleague.token).expect(403); // prettier-ignore
    expect((refused.body as Problem).code).toBe('PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER'); // prettier-ignore
    await post(`/prescriptions/${id}/restore`, receptionToken).expect(403);

    // Control positivo: su prescriptor sí.
    await post(`/prescriptions/${id}/restore`, doctorToken).expect(200);
  });

  it('PR-107 otro médico no descarta el borrador: sólo su prescriptor', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    const colleague = await signIn('MEDICO', 'colega@clinica.ec', '0102030400');

    const refused = await post(`/prescriptions/${id}/discard`, colleague.token).expect(403); // prettier-ignore
    expect((refused.body as Problem).code).toBe('PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER'); // prettier-ignore
    const untouched = await prisma.prescription.findUniqueOrThrow({ where: { id } }); // prettier-ignore
    expect(untouched).toMatchObject({ status: 'DRAFT', discardedAt: null, discardedById: null }); // prettier-ignore

    // Control positivo: su prescriptor sí.
    await post(`/prescriptions/${id}/discard`, doctorToken).expect(200);
  });

  it('PR-011 no deja descartar dos veces ni descartar lo ya emitido', async () => {
    const composed = await composeAsDoctor();
    await post(
      `/prescriptions/${composed.prescription.id}/discard`,
      doctorToken,
      { reason: 'Borrador equivocado' },
    ).expect(200);

    const twice = await post(
      `/prescriptions/${composed.prescription.id}/discard`,
      doctorToken,
      { reason: 'Otra vez' },
    ).expect(409);
    expect((twice.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');

    const other = await composeAsDoctor();
    await post(`/prescriptions/${other.prescription.id}/issue`, doctorToken).expect(200); // prettier-ignore
    const issued = await post(
      `/prescriptions/${other.prescription.id}/discard`,
      doctorToken,
      { reason: 'Me equivoqué' },
    ).expect(409);
    // Lo emitido se ANULA, que es otro acto: hay papel en la mano de alguien.
    expect((issued.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');
  });

  it('PR-080 recepción no descarta un borrador de receta', async () => {
    const composed = await composeAsDoctor();

    await post(
      `/prescriptions/${composed.prescription.id}/discard`,
      receptionToken,
      { reason: 'Lo vi mal' },
    ).expect(403);
  });

  it('PR-032 rechaza emitir una línea incompleta nombrando el campo y la línea, y nunca el medicamento', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA COMPROBACIÓN DEL ART. 5 NO ES SÓLO DEL DTO, Y ASÍ SE DEMUESTRA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El DTO ya rechaza una línea sin concentración, así que para llegar a la
     * comprobación de la EMISIÓN hay que escribir la fila por otra vía — que es
     * exactamente el llamador que la regla del servicio existe para cubrir: un
     * import, un `psql`, un caso de uso que alguien escriba en dos años.
     */
    const composed = await composeAsDoctor();
    await prisma.prescriptionItem.updateMany({
      where: { prescriptionId: composed.prescription.id },
      data: { concentration: null },
    });

    const response = await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(422);

    const problem = response.body as Problem;
    expect(problem.code).toBe('PRESCRIPTION_ITEM_INCOMPLETE');
    expect(problem.errors?.[0]?.field).toBe('items.0.concentration');
    expect(problem.errors?.[0]?.message).toContain('línea 1');
    // PR-094, SC-036: un fármaco es un diagnóstico dicho de otra forma.
    expect(JSON.stringify(problem)).not.toContain('Amoxicilina');
  });

  it('PR-060 y PR-067 informa al componer e INTERRUMPE al emitir', async () => {
    await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId,
        substanceConceptId: conceptId,
        substanceText: 'Amoxicilina',
        criticality: 'HIGH',
      },
    });

    // PR-067: al componer informa, sin impedir nada.
    const composed = await composeAsDoctor();
    expect(composed.allergyAlerts).toEqual([
      { line: 1, allergyId: expect.any(String), match: 'EXACT' },
    ]);

    // PR-060: al emitir interrumpe, y es la ÚNICA alerta que interrumpe.
    const response = await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(409);

    const problem = response.body as Problem;
    expect(problem.code).toBe('ALLERGY_CONTRAINDICATION');
    // PR-061: la salida es refutar la alergia, y el mensaje lo dice.
    expect(problem.title).toContain('refútela');
    expect(JSON.stringify(problem)).not.toContain('Amoxicilina');
  });

  it('PR-061 la alerta no se salta desde la petición: la única salida es refutar la alergia', async () => {
    const allergy = await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId,
        substanceConceptId: conceptId,
        substanceText: 'Amoxicilina',
        criticality: 'HIGH',
      },
    });
    const composed = await composeAsDoctor();

    // Un motivo para «emitir de todas formas» no tiene dónde guardarse, y la
    // ruta no lo admite: la emisión se interrumpe igual.
    const insisted = await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
      { overrideAllergy: true, reason: 'Desensibilización programada' },
    );
    expect(insisted.status).not.toBe(200);
    expect(insisted.status).not.toBe(201);
    expect(await prisma.prescription.count({ where: { status: 'ACTIVE' } })).toBe(0); // prettier-ignore

    // Control positivo: refutada la alergia, el mismo borrador se emite. Con
    // sello: desde EN-219 refutar también deja su versión.
    const refuter = (await createUser(prisma)).id;
    await prisma.patientAllergy.update({
      where: { id: allergy.id },
      data: {
        refutedAt: new Date(),
        refutedById: refuter,
        refutedNotes: 'Tolerada en tratamiento previo',
        changedById: refuter,
        changedAt: new Date(),
      },
    });
    await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(200);
  });

  it('PR-091 no sirve la receta a un médico de otra sede', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL PERMISO ESTÁ Y LA SEDE NO, QUE ES LA SEGUNDA DIMENSIÓN DE ADR-007
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El médico de la Sede Sur lleva `record:read` igual que el de la Central.
     * Lo que le falta es la sede, y el art. 10 de la norma dice exactamente eso:
     * «en ningún caso pueden ser utilizadas en otros establecimientos de salud».
     *
     * Con una SESIÓN REAL de otra cuenta y no moviendo la concesión de ésta: el
     * alcance viaja resuelto en el testigo, así que reasignar la sede a mitad de
     * sesión no probaría lo que dice probar.
     */
    const composed = await composeAsDoctor();

    const otherSite = await createSite(prisma, 'Sede Sur');
    const outsider = await prisma.user.create({
      data: {
        email: 'medico-sur@clinica.ec',
        firstName: 'Luis',
        lastName: 'Andrade',
        cedula: '1804822136',
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    await prisma.practitioner.create({ data: { userId: outsider.id } });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'MEDICO' },
    });
    await prisma.userRoleGrant.create({
      data: { userId: outsider.id, roleId: role.id, siteId: otherSite.id },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'medico-sur@clinica.ec', password: PASSWORD })
      .expect(200);
    const outsiderToken = (login.body as { accessToken: string }).accessToken;

    const response = await get(
      `/prescriptions/${composed.prescription.id}`,
      outsiderToken,
    ).expect(404);

    // El mismo mensaje que «no existe»: distinguirlas confirmaría recetas
    // ajenas a quien adivina identificadores.
    expect((response.body as Problem).code).toBe('PRESCRIPTION_NOT_FOUND');
  });

  it('PR-092 la lectura del documento deja UNA fila de bitácora y el listado ninguna', async () => {
    const composed = await composeAsDoctor();
    const before = await prisma.accessAudit.count({
      where: { action: 'READ' },
    });

    await get(`/encounters/${encounterId}/prescriptions`, doctorToken).expect(
      200,
    );
    expect(await prisma.accessAudit.count({ where: { action: 'READ' } })).toBe(
      before,
    );

    await get(`/prescriptions/${composed.prescription.id}`, doctorToken).expect(
      200,
    );
    expect(
      await prisma.accessAudit.count({
        where: { action: 'READ', resourceType: 'prescription' },
      }),
    ).toBe(before + 1);
  });

  it('PR-002 rechaza recetar en una atención ya cerrada', async () => {
    await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'COMPLETED',
        endedAt: new Date('2026-09-14T15:00:00Z'),
        dischargeCondition: 'ALIVE',
      },
    });

    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      doctorToken,
      { items: [aLine()] },
    ).expect(409);

    expect((response.body as Problem).code).toBe(
      'PRESCRIPTION_ENCOUNTER_NOT_OPEN',
    );
  });

  const put = (path: string, token: string, body: object) =>
    request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('PR-100 reescribe el borrador entero: conserva su id y sustituye sus líneas', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;

    const response = await put(`/prescriptions/${id}`, doctorToken, {
      warningSigns: 'Fiebre que no cede',
      items: [
        aLine({ concentration: '250 mg', doseAmount: 2 }),
        aLine({ dosageForm: 'ORAL_SUSPENSION', doseAmount: 5, doseUnit: 'MILLILITRE', frequency: undefined, frequencyText: 'después de cada comida' }), // prettier-ignore
      ],
    }).expect(200);

    const body = response.body as ComposedBody;
    expect(body.prescription.id).toBe(id);
    expect(body.prescription.status).toBe('DRAFT');
    const stored = await prisma.prescriptionItem.findMany({
      where: { prescriptionId: id },
      orderBy: { id: 'asc' },
    });
    expect(
      stored.map((item) => [
        item.presentation,
        item.doseText,
        item.frequencyText,
      ]),
    ).toEqual([
      // prettier-ignore
      ['Cápsula', '2 cápsulas', 'Cada 8 horas'],
      ['Suspensión oral', '5 mililitros', 'después de cada comida'],
    ]);
    expect(stored[1]).toMatchObject({ dosageFormCode: 'ORAL_SUSPENSION', doseUnitCode: 'MILLILITRE', frequencyCode: null }); // prettier-ignore
  });

  it('PR-100 una receta emitida no se reescribe, y sus líneas siguen como estaban', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.id;
    await post(`/prescriptions/${id}/issue`, doctorToken).expect(200);

    const refused = await put(`/prescriptions/${id}`, doctorToken, {
      items: [aLine({ concentration: '250 mg' })],
    }).expect(409);

    expect((refused.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');
    const lines = await prisma.prescriptionItem.findMany({ where: { prescriptionId: id } }); // prettier-ignore
    expect(lines.map((line) => line.concentration)).toEqual(['500 mg']);
  });

  it('PR-100 otro médico no reescribe el borrador de un colega; ENFERMERÍA tampoco', async () => {
    const composed = await composeAsDoctor();
    const colleague = await signIn('MEDICO', 'colega@clinica.ec', '0102030400');
    const path = `/prescriptions/${composed.prescription.id}`;

    const refused = await put(path, colleague.token, { items: [aLine()] }).expect(403); // prettier-ignore
    expect((refused.body as Problem).code).toBe('PRESCRIPTION_DRAFT_OF_ANOTHER_PRESCRIBER'); // prettier-ignore
    await put(path, nurseToken, { items: [aLine()] }).expect(403);
  });

  it('PR-101 PR-102 la forma y la unidad salen de la lista, y la frecuencia es una de las dos', async () => {
    const path = `/encounters/${encounterId}/prescriptions`;

    const badForm = await post(path, doctorToken, { items: [aLine({ dosageForm: 'tab' })] }).expect(422); // prettier-ignore
    expect((badForm.body as Problem).errors?.map((e) => e.field)).toContain('items[0].dosageForm'); // prettier-ignore

    const both = await post(path, doctorToken, { items: [aLine({ frequencyText: 'cada 8 h' })] }).expect(422); // prettier-ignore
    expect((both.body as Problem).errors?.map((e) => e.field)).toContain('items[0].frequency'); // prettier-ignore

    await post(path, doctorToken, { items: [aLine()] }).expect(201);
  });

  it('PR-026 EN-182 EN-214 el documento de una receta emitida dice los diagnósticos de su emisión, aunque después se corrijan', async () => {
    const composed = await composeAsDoctor();
    await post(`/prescriptions/${composed.prescription.id}/issue`, doctorToken).expect(200); // prettier-ignore
    const [diagnosis] = await prisma.encounterDiagnosis.findMany({ where: { encounterId } }); // prettier-ignore

    // EN-214: the pharmacy holds a paper that printed it, so it states why.
    await post(`/encounters/${encounterId}/diagnoses/${diagnosis!.id}/retract`, doctorToken, { reason: 'Código mal elegido' }).expect(204); // prettier-ignore

    const document = await get(`/prescriptions/${composed.prescription.id}`, doctorToken).expect(200); // prettier-ignore
    expect(
      (document.body as { diagnoses: { code: string }[] }).diagnoses,
    ).toEqual([expect.objectContaining({ code: 'J029' })]);
  });

  it('PR-101 la dosis admite cuatro decimales y vuelve tal cual; un quinto se rechaza nombrando el campo', async () => {
    const path = `/encounters/${encounterId}/prescriptions`;

    const composed = await post(path, doctorToken, { items: [aLine({ doseAmount: 0.125, doseUnit: 'CAPSULE' })] }).expect(201); // prettier-ignore
    const line = (composed.body as ComposedBody).prescription.items[0] as unknown as { doseAmount: number; doseText: string }; // prettier-ignore
    expect(line.doseAmount).toBe(0.125);
    expect(line.doseText).toBe('0,125 cápsulas');

    const refused = await post(path, doctorToken, { items: [aLine({ doseAmount: 0.12345 })] }).expect(422); // prettier-ignore
    expect((refused.body as Problem).errors?.map((e) => e.field)).toContain('items[0].doseAmount'); // prettier-ignore
  });

  it('PR-101 la BASE exige dosis mayor que cero y con su unidad', async () => {
    const composed = await composeAsDoctor();
    const id = composed.prescription.items[0]!.id;

    await expect(
      prisma.$executeRaw`UPDATE prescription_item SET dose_amount = 0 WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/prescription_item_dose_amount_positive/);
    await expect(
      prisma.$executeRaw`UPDATE prescription_item SET dose_unit_code = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/prescription_item_dose_amount_with_unit/);
    // Positive control: a draft's line changes when the change is coherent.
    await prisma.$executeRaw`UPDATE prescription_item SET dose_amount = 2 WHERE id = ${id}::uuid`;
  });

  it('PR-103 publica las listas con el texto que se imprime', async () => {
    const response = await get('/prescriptions/vocabulary', doctorToken).expect(200); // prettier-ignore
    const body = response.body as {
      dosageForms: { code: string; label: string; doseUnit: string }[];
      routes: { code: string; label: string }[];
    };

    expect(body.dosageForms).toContainEqual({ code: 'TABLET', label: 'Tableta', doseUnit: 'TABLET' }); // prettier-ignore
    expect(body.routes).toContainEqual({ code: 'ORAL', label: 'Vía oral' });
  });

  it('PR-103 PR-104 con el medicamento, publica las presentaciones que el CNMB le declara', async () => {
    await prisma.catalogConcept.update({
      where: { id: conceptId },
      data: { attributes: { presentations: [{ form: 'CAPSULE', concentration: '500 mg' }] } }, // prettier-ignore
    });

    const withConcept = await get(`/prescriptions/vocabulary?conceptId=${conceptId}`, doctorToken).expect(200); // prettier-ignore
    expect(
      (withConcept.body as { presentations: unknown[] }).presentations,
    ).toEqual([{ form: 'CAPSULE', concentration: '500 mg' }]);
    const without = await get('/prescriptions/vocabulary', doctorToken).expect(200); // prettier-ignore
    expect((without.body as { presentations: unknown[] }).presentations).toEqual([]); // prettier-ignore
  });

  it('PR-104 PR-110 una concentración que el CNMB no trae para ese medicamento se receta marcada fuera del cuadro, sin justificación', async () => {
    // The database is rebuilt between tests (`useDatabase`), so the declared
    // presentations do not reach the next one.
    await prisma.catalogConcept.update({
      where: { id: conceptId },
      data: { attributes: { presentations: [{ form: 'CAPSULE', concentration: '500 mg' }] } }, // prettier-ignore
    });
    const path = `/encounters/${encounterId}/prescriptions`;
    type Body = { prescription: { items: { offFormulary: boolean; offFormularyJustification: string | null }[] } }; // prettier-ignore

    // Positive control: the declared presentation passes, and is not marked.
    const declared = await post(path, doctorToken, { items: [aLine()] }).expect(201); // prettier-ignore
    expect((declared.body as Body).prescription.items[0]?.offFormulary).toBe(false); // prettier-ignore

    const outside = await post(path, doctorToken, { items: [aLine({ concentration: '5000 mg' })] }).expect(201); // prettier-ignore
    expect((outside.body as Body).prescription.items[0]).toMatchObject({ offFormulary: true, offFormularyJustification: null }); // prettier-ignore

    // If a reason is sent anyway, it is kept.
    const justified = await post(path, doctorToken, {
      items: [aLine({ concentration: '5000 mg', offFormularyJustification: 'Dosis de carga indicada por especialista' })], // prettier-ignore
    }).expect(201);
    expect((justified.body as Body).prescription.items[0]).toMatchObject({ offFormulary: true, offFormularyJustification: 'Dosis de carga indicada por especialista' }); // prettier-ignore
  });
});

/**
 * PR-095. The diagnosis art. 5.b.iii prints: without one the receta is not
 * issued. One CIE-10 concept per database, found or created.
 */
async function aDiagnosisOn(prisma: PrismaClient, encounterId: string) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: 'CIE10' },
    create: { code: 'CIE10', name: 'CIE-10' },
    update: {},
  });
  const concept =
    (await prisma.catalogConcept.findFirst({
      where: { systemId: system.id, code: 'J029' },
    })) ??
    (await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'J029',
        display: 'Faringitis aguda, no especificada',
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    }));
  await prisma.encounterDiagnosis.create({
    data: {
      encounterId,
      conceptId: concept.id,
      cie10Code: 'J029',
      cie10Display: 'Faringitis aguda, no especificada',
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      rank: 1,
    },
  });
}
