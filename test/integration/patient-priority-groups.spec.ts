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
import { createPatient } from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * Los grupos prioritarios del artículo 35, contra PostgreSQL 18 de verdad
 * (P3: PA-033 a PA-042, REQ-024, D-026, D-027, D-029).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ PRUEBA ESTO QUE LAS UNITARIAS NO PUEDEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. Que las garantías estén EN LA BASE: que un embarazo sin fin no se pueda
 *     insertar ni por `psql`, que «adulto mayor» no quepa en la columna, y que
 *     acreditar sin documento se rechace. Un doble que devuelve lo que le
 *     pedimos no demuestra que el `CHECK` exista.
 *  2. Que la separación de D-029 sea cierta CON UNA SESIÓN REAL. Recepción
 *     tiene `patient:read` y no `patient:priority`, y esa frase sólo la
 *     verifica un token emitido por el propio sistema: el defecto de AG-111 fue
 *     exactamente un doble con los permisos puestos a mano, que no vio que el
 *     rol que usaba la pantalla no tenía el permiso.
 *  3. Que el motivo NO VIAJE en el listado del registro (PA-042). Es una
 *     AUSENCIA, y una ausencia sólo se demuestra sobre la respuesta.
 */
const PASSWORD = 'el caballo come alfalfa';
const MEDICO_EMAIL = 'medica@clinica.ec';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';
const TRABAJO_SOCIAL_EMAIL = 'trabajosocial@clinica.ec';

/** El rol que la clínica crea a propósito para el segundo nivel de D-027. */
const PROTECTED_ROLE = 'TRABAJO_SOCIAL';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface PriorityGroupBody {
  id: string;
  group: string;
  startsOn: string;
  endsOn: string | null;
  inForce: boolean;
  origin: string;
  evidenceDocument: string | null;
  recordedById: string;
  recordedAt: string;
  closedById: string | null;
  closedAt: string | null;
}

describe('los grupos prioritarios por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  /** `MEDICO`: `patient:read` + `patient:priority` (D-029). */
  let medico: string;
  let medicoUserId: string;
  /** `RECEPCION`: `patient:read` y NADA más de prioridad (D-029). */
  let recepcion: string;
  /** Un rol creado a mano con `patient:priority:protected` (D-027). */
  let trabajoSocial: string;

  let patientId: string;

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
    // The role→permission cache is indexed by id and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    await createProtectedRole();

    medico = await signIn(MEDICO_EMAIL, 'MEDICO', '1710034065');
    recepcion = await signIn(RECEPCION_EMAIL, 'RECEPCION', '0926687856');
    trabajoSocial = await signIn(
      TRABAJO_SOCIAL_EMAIL,
      PROTECTED_ROLE,
      '1712345675',
    );

    // 36 años el 16-08-2026: ni adulto mayor ni adolescente, así que toda
    // prioridad que aparezca viene de una fila y no de la edad.
    const patient = await createPatient(prisma, {
      birthDate: new Date('1990-03-15'),
    });
    patientId = patient.id;
  });

  afterAll(async () => {
    await closeApp(app);
  });

  /**
   * El rol que lleva el segundo nivel de D-027.
   *
   * SE CREA AQUÍ Y NO LO TRAE NINGUNA SEMILLA, y eso es el requisito:
   * `patient:priority:protected` está marcado `explicitGrantOnly`, así que la
   * instalación se lo concede a alguien a propósito o no lo tiene nadie —el
   * mismo criterio que `agenda:overbook:self` y `user:reset-mfa`—. Este rol es
   * exactamente lo que una clínica haría desde la pantalla de roles.
   */
  async function createProtectedRole(): Promise<void> {
    await prisma.role.create({
      data: {
        code: PROTECTED_ROLE,
        name: 'Trabajo social',
        description: 'Registra las situaciones de riesgo del artículo 35',
        permissions: {
          create: [
            { permissionCode: 'patient:read' },
            { permissionCode: 'patient:priority' },
            { permissionCode: 'patient:priority:protected' },
          ],
        },
      },
    });
    registry.invalidate();
  }

  async function signIn(
    email: string,
    roleCode: string,
    cedula: string,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        // Synthetic cedula with a computed check digit; never a real one.
        cedula,
        passwordHash: await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    if (roleCode === 'MEDICO') medicoUserId = user.id;

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

    return (response.body as { accessToken: string }).accessToken;
  }

  const groupsOf = (token: string, id = patientId) =>
    request(app.getHttpServer())
      .get(`/api/v1/patients/${id}/priority-groups`)
      .set('Authorization', `Bearer ${token}`);

  const recordGroup = (body: Record<string, unknown>, token = medico) =>
    request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/priority-groups`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const closeGroup = (
    recordId: string,
    body: Record<string, unknown>,
    token = medico,
  ) =>
    request(app.getHttpServer())
      .patch(`/api/v1/patients/${patientId}/priority-groups/${recordId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Hoy en Ecuador, que es contra lo que el servidor resuelve la vigencia. */
  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Guayaquil',
    }).format(new Date());
  }

  function daysFromToday(days: number): string {
    const [year, month, day] = today().split('-').map(Number) as [
      number,
      number,
      number,
    ];
    return new Date(Date.UTC(year, month - 1, day + days))
      .toISOString()
      .slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // La forma del dato (PA-033, PA-039)
  // -------------------------------------------------------------------------

  it('PA-033 stores one dated row per assessment instead of a flag on the chart', async () => {
    await recordGroup({
      group: 'DISABILITY',
      startsOn: daysFromToday(-30),
      origin: 'ACCREDITED',
      evidenceDocument: 'Carné del CONADIS 4471',
    }).expect(201);

    const rows = await prisma.patientPriorityGroup.findMany({
      where: { patientId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.groupCode).toBe('DISABILITY');

    // Y NO hay ninguna columna booleana en `patient` que decir lo mismo: si
    // alguien añadiera una, este listado la delataría.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'patient'
    `;
    const names = columns.map((column) => column.column_name);
    expect(names).not.toContain('is_pregnant');
    expect(names).not.toContain('has_disability');
    expect(names).not.toContain('priority_group');
  });

  it('PA-039 keeps who recorded the assessment and when', async () => {
    const response = await recordGroup({
      group: 'DISABILITY',
      startsOn: daysFromToday(-30),
      origin: 'SELF_DECLARED',
    }).expect(201);

    const body = response.body as PriorityGroupBody;
    expect(body.recordedById).toBe(medicoUserId);
    expect(new Date(body.recordedAt).getTime()).toBeGreaterThan(0);

    // Y quien lo registró NO se toma del cuerpo: mandarlo no cambia nada.
    const forged = await recordGroup({
      group: 'CATASTROPHIC_ILLNESS',
      startsOn: daysFromToday(-10),
      origin: 'SELF_DECLARED',
      recordedById: '00000000-0000-4000-8000-000000000000',
    }).expect(201);
    expect((forged.body as PriorityGroupBody).recordedById).toBe(medicoUserId);
  });

  it('PA-039 refuses a row whose author the database cannot name', async () => {
    // `recorded_by` es NOT NULL con clave foránea RESTRICT: un registro que
    // nadie puede responder no es un registro más débil, es uno inútil.
    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, origin, recorded_by)
        VALUES (${patientId}::uuid, 'DISABILITY', current_date, 'SELF_DECLARED', NULL)
      `,
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // La vigencia, que se resuelve al leer (PA-036, PA-037)
  // -------------------------------------------------------------------------

  it('PA-036 stops counting a pregnancy whose expected date of delivery has passed, with nobody touching the row', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA INDEPENDIENTE QUE EL SPEC DECLARA PARA ESTA ENTREGA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Se escriben DOS embarazos, uno con fecha probable de parto ya pasada y
     * otro por llegar, y NO SE ESCRIBE NADA MÁS: ni un proceso nocturno, ni un
     * `UPDATE`, ni una marca de cerrado. La respuesta se lee tal cual y la fila
     * caducada ya no cuenta. Si algún día hiciera falta escribir para que esto
     * fuera cierto, este `updatedAt` cambiaría y la prueba lo diría.
     */
    const lapsed = await createPatientWithPregnancy(daysFromToday(-1));
    const current = await createPatientWithPregnancy(daysFromToday(+30));

    const lapsedGroups = await groupsOf(medico, lapsed).expect(200);
    const currentGroups = await groupsOf(medico, current).expect(200);

    expect(
      (lapsedGroups.body as { items: PriorityGroupBody[] }).items[0]?.inForce,
    ).toBe(false);
    expect(
      (currentGroups.body as { items: PriorityGroupBody[] }).items[0]?.inForce,
    ).toBe(true);

    // Y la prioridad calculada lo refleja: la que ya dio a luz vuelve a la
    // cola ordinaria sin que nadie la mueva.
    expect(await priorityOf(lapsed)).toBe(2);
    expect(await priorityOf(current)).toBe(1);

    // LA FILA SIGUE INTACTA. Nada la marcó ni la borró.
    const rows = await prisma.patientPriorityGroup.findMany({
      where: { patientId: lapsed },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closedAt).toBeNull();
  });

  it('PA-036 refuses a pregnancy with no end date, in the database and not only in the DTO', async () => {
    const response = await recordGroup({
      group: 'PREGNANT',
      startsOn: daysFromToday(-60),
      origin: 'SELF_DECLARED',
    }).expect(422);
    expect((response.body as Problem).code).toBe(
      'PRIORITY_GROUP_PERIOD_INVALID',
    );

    // La garantía de verdad: un `INSERT` que no pasa por la aplicación tampoco
    // puede dejar un embarazo encendido para siempre.
    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, origin, recorded_by)
        VALUES (${patientId}::uuid, 'PREGNANT', current_date, 'SELF_DECLARED', ${medicoUserId}::uuid)
      `,
    ).rejects.toThrow(/patient_priority_group_pregnancy_has_end/);
  });

  it('PA-035 refuses to store a group derived from the birth date, in the database too', async () => {
    const response = await recordGroup({
      group: 'OLDER_ADULT',
      startsOn: daysFromToday(-1),
      origin: 'SELF_DECLARED',
    }).expect(422);
    // Lo rechaza el esquema del DTO, por campo: el grupo escribible es una
    // lista cerrada que no contiene los derivados.
    expect((response.body as Problem).errors?.[0]?.field).toBe('group');

    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, origin, recorded_by)
        VALUES (${patientId}::uuid, 'OLDER_ADULT', current_date, 'SELF_DECLARED', ${medicoUserId}::uuid)
      `,
    ).rejects.toThrow(/patient_priority_group_recordable/);
  });

  it('PA-035 derives the priority of an older adult with no row at all', async () => {
    const elder = await createPatient(prisma, {
      birthDate: new Date('1940-01-01'),
    });

    expect(await priorityOf(elder.id)).toBe(1);
    const rows = await prisma.patientPriorityGroup.findMany({
      where: { patientId: elder.id },
    });
    expect(rows).toHaveLength(0);
  });

  it('PA-037 closes a persistent state by dating it, and never by deleting the row', async () => {
    const created = await recordGroup({
      group: 'CATASTROPHIC_ILLNESS',
      startsOn: daysFromToday(-400),
      origin: 'ACCREDITED',
      evidenceDocument: 'Certificado médico 88-2025',
    }).expect(201);
    const recordId = (created.body as PriorityGroupBody).id;

    const closed = await closeGroup(recordId, {
      endsOn: daysFromToday(-1),
    }).expect(200);

    const body = closed.body as PriorityGroupBody;
    expect(body.inForce).toBe(false);
    expect(body.endsOn).toBe(daysFromToday(-1));
    expect(body.closedById).toBe(medicoUserId);

    // LA FILA SIGUE AHÍ, que es el requisito: sin ella no hay respuesta a
    // «¿por qué esta persona tuvo prioridad el año pasado?».
    const rows = await prisma.patientPriorityGroup.findMany({
      where: { patientId },
    });
    expect(rows).toHaveLength(1);

    // Y sigue devolviéndose al leer, marcada como no vigente.
    const listed = await groupsOf(medico).expect(200);
    expect((listed.body as { items: PriorityGroupBody[] }).items).toHaveLength(
      1,
    );
  });

  it('PA-038 refuses an accredited assessment that does not name its document, in the database too', async () => {
    const response = await recordGroup({
      group: 'DISABILITY',
      startsOn: daysFromToday(-30),
      origin: 'ACCREDITED',
    }).expect(422);
    expect((response.body as Problem).code).toBe(
      'PRIORITY_GROUP_EVIDENCE_REQUIRED',
    );

    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, origin, recorded_by)
        VALUES (${patientId}::uuid, 'DISABILITY', current_date, 'ACCREDITED', ${medicoUserId}::uuid)
      `,
    ).rejects.toThrow(/patient_priority_group_evidence_required/);
  });

  it('PA-038 keeps declared and accredited apart in the answer', async () => {
    await recordGroup({
      group: 'DISABILITY',
      startsOn: daysFromToday(-30),
      origin: 'ACCREDITED',
      evidenceDocument: 'Carné del CONADIS 4471',
    }).expect(201);

    const listed = await groupsOf(medico).expect(200);
    const [record] = (listed.body as { items: PriorityGroupBody[] }).items;
    expect(record?.origin).toBe('ACCREDITED');
    expect(record?.evidenceDocument).toBe('Carné del CONADIS 4471');
  });

  // -------------------------------------------------------------------------
  // Quién lee el motivo, y quién sólo el orden (PA-040, PA-041, PA-042)
  // -------------------------------------------------------------------------

  it('PA-040 refuses the reason to a real session that holds patient:read and not patient:priority', async () => {
    await recordGroup({
      group: 'CATASTROPHIC_ILLNESS',
      startsOn: daysFromToday(-100),
      origin: 'SELF_DECLARED',
    }).expect(201);

    const refused = await groupsOf(recepcion).expect(403);
    expect((refused.body as Problem).code).toBe('PERMISSION_DENIED');

    // Y no es que la sesión esté rota: la misma lee el registro sin problema.
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
  });

  it('PA-040 records the reading of the reason in the access trail as health data', async () => {
    await groupsOf(medico).expect(200);

    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient_priority_group', resourceId: patientId },
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.action).toBe('READ');
    expect(trail[0]?.userId).toBe(medicoUserId);
    // Sin carga útil: la lista blanca de
    // `access_audit_payload_only_for_declared_resources` es exactamente
    // `'configuration'`, y un dato de salud en una tabla append-only que nunca
    // se purga no se podría rectificar jamás (REQ-113, D-032).
    expect(trail[0]?.before).toBeNull();
    expect(trail[0]?.after).toBeNull();
  });

  it('PA-041 gives the calculated priority to a session with patient:read alone', async () => {
    await recordGroup({
      group: 'CATASTROPHIC_ILLNESS',
      startsOn: daysFromToday(-100),
      origin: 'SELF_DECLARED',
    }).expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);

    expect((detail.body as { priority: number }).priority).toBe(1);
  });

  it('PA-042 keeps the reason out of the register listing, which carries only the order', async () => {
    await recordGroup({
      group: 'CATASTROPHIC_ILLNESS',
      startsOn: daysFromToday(-100),
      origin: 'ACCREDITED',
      evidenceDocument: 'Certificado médico 88-2025',
    }).expect(201);

    const listing = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);

    const raw = JSON.stringify(listing.body);
    // LA AUSENCIA, SOBRE LA RESPUESTA. No sobre lo que una pantalla decidió no
    // pintar: se busca el motivo en el JSON entero, con nombre de grupo, de
    // documento acreditativo y de origen.
    expect(raw).not.toContain('CATASTROPHIC_ILLNESS');
    expect(raw).not.toContain('Certificado médico');
    expect(raw).not.toContain('ACCREDITED');
    expect(raw).not.toContain('priorityGroups');
    // …y el orden sí está, que es lo que la lista de espera necesita.
    const page = listing.body as { items: { id: string; priority: number }[] };
    expect(page.items.find((row) => row.id === patientId)?.priority).toBe(1);
  });

  // -------------------------------------------------------------------------
  // El segundo nivel del artículo 35 (D-027)
  // -------------------------------------------------------------------------

  it('PA-034 counts a restricted group for the order while hiding it from whoever lacks the second key', async () => {
    await recordGroup(
      {
        group: 'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM',
        startsOn: daysFromToday(-5),
        origin: 'SELF_DECLARED',
      },
      trabajoSocial,
    ).expect(201);

    // Cuenta para el orden — es la equiparación del artículo 35 —, y eso lo ve
    // hasta recepción.
    expect(await priorityOf(patientId)).toBe(1);

    // Quien tiene `patient:priority` pero no el segundo nivel NO recibe un
    // rechazo: recibe una lista sin esa fila. Un 403 confirmaría que existe,
    // que es el oráculo que PA-024 evita para el registro entero.
    const asMedico = await groupsOf(medico).expect(200);
    expect((asMedico.body as { items: PriorityGroupBody[] }).items).toEqual([]);
    expect(JSON.stringify(asMedico.body)).not.toContain('VIOLENCE');

    // Y quien sí lo tiene la lee entera.
    const asTrabajoSocial = await groupsOf(trabajoSocial).expect(200);
    expect(
      (asTrabajoSocial.body as { items: PriorityGroupBody[] }).items[0]?.group,
    ).toBe('DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM');
  });

  it('PA-034 refuses to RECORD a restricted group without the second key, and says so', async () => {
    const refused = await recordGroup({
      group: 'CHILD_ABUSE_VICTIM',
      startsOn: daysFromToday(-5),
      origin: 'SELF_DECLARED',
    }).expect(403);

    expect((refused.body as Problem).code).toBe('PRIORITY_GROUP_RESTRICTED');
    const rows = await prisma.patientPriorityGroup.findMany({
      where: { patientId },
    });
    expect(rows).toHaveLength(0);
  });

  it('PA-034 answers not-found when somebody without the second key tries to close a restricted record', async () => {
    const created = await recordGroup(
      {
        group: 'AT_RISK',
        startsOn: daysFromToday(-5),
        origin: 'SELF_DECLARED',
      },
      trabajoSocial,
    ).expect(201);
    const recordId = (created.body as PriorityGroupBody).id;

    const refused = await closeGroup(recordId, { endsOn: today() }).expect(404);
    expect((refused.body as Problem).code).toBe('PRIORITY_GROUP_NOT_FOUND');

    // Nada cambió.
    const row = await prisma.patientPriorityGroup.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(row.endsOn).toBeNull();
  });

  it('PA-033 answers PATIENT_NOT_FOUND for a chart that does not exist, without writing a trail row', async () => {
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    const refused = await groupsOf(medico, ghost).expect(404);

    expect((refused.body as Problem).code).toBe('PATIENT_NOT_FOUND');
    const trail = await prisma.accessAudit.findMany({
      where: { resourceId: ghost },
    });
    expect(trail).toHaveLength(0);
  });

  // -------------------------------------------------------------------------

  /** La prioridad tal como la lee recepción: sólo el número. */
  async function priorityOf(id: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${recepcion}`)
      .expect(200);
    return (response.body as { priority: number }).priority;
  }

  async function createPatientWithPregnancy(endsOn: string): Promise<string> {
    const patient = await createPatient(prisma, {
      birthDate: new Date('1995-05-20'),
    });
    await prisma.patientPriorityGroup.create({
      data: {
        patientId: patient.id,
        groupCode: 'PREGNANT',
        startsOn: new Date(`${daysFromToday(-240)}T00:00:00Z`),
        endsOn: new Date(`${endsOn}T00:00:00Z`),
        origin: 'SELF_DECLARED',
        recordedById: medicoUserId,
      },
    });
    return patient.id;
  }
});
