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
  items: { line: number; genericName: string; quantity: number }[];
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
      ? await prisma.practitioner.create({ data: { userId: user.id } })
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
    presentation: 'Cápsula',
    concentration: '500 mg',
    routeCode: 'ORAL',
    quantity: 20,
    doseText: '1 cápsula',
    frequencyText: 'Cada 8 horas',
    durationDays: 7,
    ...overrides,
  });

  async function composeAsDoctor(items = [aLine()]): Promise<ComposedBody> {
    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      doctorToken,
      { items },
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

  it('PR-009 rechaza una línea fuera del CNMB sin justificación, por campo', async () => {
    const response = await post(
      `/encounters/${encounterId}/prescriptions`,
      doctorToken,
      { items: [aLine({ conceptId: undefined, genericName: 'Amoxicilina' })] },
    ).expect(422);

    const problem = response.body as Problem;
    expect(
      problem.errors?.some((e) =>
        e.field.endsWith('offFormularyJustification'),
      ),
    ).toBe(true);
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
    ).expect(409);
    expect((refused.body as Problem).code).toBe('PRESCRIPTION_NOT_EDITABLE');

    await post(
      `/prescriptions/${composed.prescription.id}/issue`,
      doctorToken,
    ).expect(200);
    const cancelled = await post(
      `/prescriptions/${composed.prescription.id}/cancel`,
      doctorToken,
    ).expect(200);

    expect((cancelled.body as PrescriptionBody).status).toBe('CANCELLED');
    // Nada se borra: contar es la única forma de demostrarlo.
    expect(await prisma.prescription.count()).toBe(1);
  });

  it('PR-011 descarta el borrador equivocado, y exige el motivo por campo', async () => {
    // La salida que faltaba. Y el motivo es obligatorio porque SE GUARDA:
    // `discard_reason` es una columna, así que pedirlo es una promesa que el
    // sistema cumple —al revés que en la anulación, donde no hay dónde
    // guardarlo y por eso no se pide.
    const composed = await composeAsDoctor();

    const refused = await post(
      `/prescriptions/${composed.prescription.id}/discard`,
      doctorToken,
      {},
    ).expect(422);
    const problem = refused.body as Problem;
    expect(problem.errors?.[0]?.field).toBe('reason');

    const discarded = await post(
      `/prescriptions/${composed.prescription.id}/discard`,
      doctorToken,
      { reason: 'Se tecleó en la atención equivocada' },
    ).expect(200);

    const body = discarded.body as PrescriptionBody;
    expect(body.status).toBe('DISCARDED');
    expect(body.discardReason).toBe('Se tecleó en la atención equivocada');
    expect(body.discardedAt).not.toBeNull();
    // Nada se borra: el borrador sigue en la ficha, distinguible de la
    // medicación que el paciente sí toma.
    expect(await prisma.prescription.count()).toBe(1);
    expect(await prisma.prescriptionItem.count()).toBe(1);
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
});
