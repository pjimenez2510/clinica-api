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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DOS GARANTÍAS DISTINTAS, Y ANTES SÓLO SE TOCABA UNA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Esta prueba insertaba `NULL` y afirmaba `rejects.toThrow()` sin patrón:
     * disparaba el `NOT NULL` de la columna y `patient_priority_group_recorded_by_fkey`
     * NO SE CONSULTABA NUNCA. Borrar la clave foránea entera dejaba la prueba
     * en verde, que es tanto como no tenerla.
     *
     * Ahora se ataca cada una por su lado, y se afirma QUÉ objeto rechazó: sin
     * el nombre, un fallo por otra restricción —o por un error de sintaxis—
     * cuenta como éxito.
     */

    // (1) La columna: un registro sin autor no es un registro más débil, es
    // uno inútil.
    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, origin, recorded_by)
        VALUES (${patientId}::uuid, 'DISABILITY', current_date, 'SELF_DECLARED', NULL)
      `,
    ).rejects.toThrow(/recorded_by/);

    // (2) LA CLAVE FORÁNEA, que la prueba anterior no llegaba a tocar: un
    // identificador con forma perfecta que no es ninguna cuenta. Es la forma
    // en que esto ocurre de verdad —una importación, un `psql`— y la que deja
    // un rastro que no se puede responder.
    await expect(
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, origin, recorded_by)
        VALUES (
          ${patientId}::uuid, 'DISABILITY', current_date, 'SELF_DECLARED',
          '00000000-0000-4000-8000-0000000000ff'::uuid
        )
      `,
    ).rejects.toThrow(/patient_priority_group_recorded_by_fkey/);
  });

  it('PA-036 refuses a period that ends before it starts, in the database too', async () => {
    /**
     * `patient_priority_group_period_valid`, que hasta ahora no violaba nadie:
     * cero referencias en `src/` y en `test/`. Un CHECK sin prueba es una
     * intención.
     *
     * Se ataca por SQL directo porque es como llega de verdad —una
     * importación, una migración de datos— y porque el DTO no está en ese
     * camino. Los dos extremos son inclusivos: el mismo día vale.
     */
    const insertPeriod = (startsOn: string, endsOn: string) =>
      prisma.$executeRaw`
        INSERT INTO patient_priority_group
          (patient_id, group_code, starts_on, ends_on, origin, recorded_by)
        VALUES (
          ${patientId}::uuid, 'DISABILITY', ${startsOn}::date, ${endsOn}::date,
          'SELF_DECLARED', ${medicoUserId}::uuid
        )
      `;

    await expect(insertPeriod('2026-03-10', '2026-03-09')).rejects.toThrow(
      /patient_priority_group_period_valid/,
    );

    // Y el límite que NO debe rechazar: empieza y acaba el mismo día.
    await expect(insertPeriod('2026-03-10', '2026-03-10')).resolves.toBe(1);
  });

  it('PA-039 refuses a closure that says when but not who, and the other way round', async () => {
    /**
     * `patient_priority_group_closure_complete`, la otra restricción que nadie
     * violaba. PA-039 aplicado al cierre: quién y cuándo van juntos o no van.
     * Una fila con `closed_at` y sin `closed_by` diría que se cerró sin decir
     * quién — que es exactamente lo que el requisito impide.
     */
    const created = await recordGroup({
      group: 'DISABILITY',
      startsOn: daysFromToday(-30),
      origin: 'SELF_DECLARED',
    }).expect(201);
    const recordId = (created.body as PriorityGroupBody).id;

    await expect(
      prisma.$executeRaw`
        UPDATE patient_priority_group
        SET ends_on = current_date, closed_at = now(), closed_by = NULL
        WHERE id = ${recordId}::uuid
      `,
    ).rejects.toThrow(/patient_priority_group_closure_complete/);

    await expect(
      prisma.$executeRaw`
        UPDATE patient_priority_group
        SET ends_on = current_date, closed_at = NULL, closed_by = ${medicoUserId}::uuid
        WHERE id = ${recordId}::uuid
      `,
    ).rejects.toThrow(/patient_priority_group_closure_complete/);

    // Las dos juntas sí: es el cierre que la ruta escribe.
    await expect(
      prisma.$executeRaw`
        UPDATE patient_priority_group
        SET ends_on = current_date, closed_at = now(), closed_by = ${medicoUserId}::uuid
        WHERE id = ${recordId}::uuid
      `,
    ).resolves.toBe(1);
  });

  it('PA-036 REFUSES closing a record with an end date before its start, with the code the SPEC fixes', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * UN DEFECTO DE CONTRATO QUE DESTAPÓ SONDEAR `_period_valid`.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Cerrar con una fecha anterior a la de inicio respondía `422 CHECK_FAILED`
     * —un código genérico, sin campo— porque `close()` no pasaba por la
     * validación que sí hace el camino de registro: la fecha viajaba hasta el
     * UPDATE y quien contestaba era la restricción de la base. El `SPEC.md`
     * fija `PRIORITY_GROUP_PERIOD_INVALID` para esto, y una frase que no cae
     * bajo ninguna casilla no la puede pintar el formulario que hay que
     * corregir.
     *
     * La regla vale ahora en los DOS caminos, y la base la sigue guardando
     * para lo que no pasa por ninguno.
     */
    const created = await recordGroup({
      group: 'DISABILITY',
      startsOn: daysFromToday(-30),
      origin: 'SELF_DECLARED',
    }).expect(201);
    const recordId = (created.body as PriorityGroupBody).id;

    const response = await closeGroup(recordId, {
      endsOn: daysFromToday(-90),
    }).expect(422);

    const problem = response.body as Problem;
    expect(problem.code).toBe('PRIORITY_GROUP_PERIOD_INVALID');
    expect(problem.errors?.[0]).toMatchObject({
      field: 'endsOn',
      code: 'PRIORITY_GROUP_PERIOD_INVALID',
    });

    // Y no escribió nada: la fila sigue abierta.
    const row = await prisma.patientPriorityGroup.findUniqueOrThrow({
      where: { id: recordId },
      select: { endsOn: true, closedAt: true, closedById: true },
    });
    expect(row.endsOn).toBeNull();
    expect(row.closedAt).toBeNull();
    expect(row.closedById).toBeNull();
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

  // -------------------------------------------------------------------------
  // Donde el permiso POR FILA (P3) y el alcance POR FUSIÓN (P4) se componen
  // -------------------------------------------------------------------------

  /**
   * Una ficha absorbida por `patientId`, con una valoración ya escrita en ella.
   *
   * LA FUSIÓN SE HACE CON UN `UPDATE` Y NO POR LA RUTA, a propósito: lo que se
   * juzga aquí es la LECTURA compuesta, y `patient:merge` no lo tiene ninguno
   * de los tres roles de esta suite —ni debe (D-030)—. Que la ruta de fusión
   * escriba bien el enlace y su rastro es de `patient-merge.spec.ts`; lo que
   * hace falta aquí es el estado que deja, y `trg_patient_sync_merged` se
   * dispara igual.
   */
  async function absorbedChartWithGroup(groupCode: string): Promise<string> {
    const absorbida = await createPatient(prisma, {
      birthDate: new Date('1990-03-15'),
    });
    await prisma.patientPriorityGroup.create({
      data: {
        patientId: absorbida.id,
        groupCode,
        startsOn: new Date(`${daysFromToday(-30)}T00:00:00Z`),
        origin: 'SELF_DECLARED',
        recordedById: medicoUserId,
      },
    });
    await prisma.patient.update({
      where: { id: absorbida.id },
      data: { mergedIntoId: patientId, mergedAt: new Date() },
    });
    return absorbida.id;
  }

  it('PA-034 keeps a restricted group of an ABSORBED chart hidden from whoever lacks the second key', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL ÚNICO PUNTO DONDE UN FILTRO POR PERMISO Y UN ALCANCE POR FUSIÓN SE
     * COMPONEN — Y SOBRE EL DATO DONDE EQUIVOCARSE CUESTA MÁS
     * ═══════════════════════════════════════════════════════════════════════
     *
     * PA-055 hizo que la superviviente lea la historia de las absorbidas, y
     * D-027 exige que «víctima de violencia doméstica» sólo la vea quien tenga
     * `patient:priority:protected`. Cada mitad tenía su prueba; la composición
     * no tenía ninguna, y es donde una fuga no se parecería a un defecto de
     * ninguna de las dos: el filtro se aplica sobre la lista YA ampliada por el
     * enlace, así que basta con que alguien reordene esas dos líneas para que
     * la fila restringida de la absorbida salga por la ficha vigente.
     *
     * Aquí la consecuencia no es la privacidad: es la seguridad de una persona.
     *
     * LAS TRES AFIRMACIONES HACEN FALTA, y la primera es la que impide que esto
     * pase en verde por la razón equivocada —si la fila no se viera desde `B`
     * en absoluto, «no se ve sin la llave» sería cierto y no probaría nada—.
     */
    await absorbedChartWithGroup('DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM');

    // 1. CON el segundo nivel se ve, y se ve POR EL ENLACE (PA-055).
    const conLlave = await groupsOf(trabajoSocial).expect(200);
    expect(
      (conLlave.body as { items: PriorityGroupBody[] }).items.map(
        (i) => i.group,
      ),
    ).toEqual(['DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM']);

    // 2. SIN él, lista vacía desde la superviviente — no un 403, que
    //    confirmaría que existe (D-027) — y ni el código asoma en la respuesta.
    const sinLlave = await groupsOf(medico).expect(200);
    expect((sinLlave.body as { items: PriorityGroupBody[] }).items).toEqual([]);
    expect(JSON.stringify(sinLlave.body)).not.toContain('VIOLENCE');

    // 3. Y el ORDEN sí llega, hasta a recepción: es la equiparación del
    //    artículo 35, y la fusión no la cambia porque es la misma persona.
    expect(await priorityOf(patientId)).toBe(1);
  });

  it('PA-040 names the ABSORBED chart in the access trail when its reason was revealed', async () => {
    /**
     * «¿QUIÉN LEYÓ POR QUÉ ERA PRIORITARIA LA FICHA A?» TIENE QUE TENER UNA
     * FILA QUE NOMBRE A `A` (REQ-110).
     *
     * El motivo se lee por el enlace y la fila conserva el `patient_id` de la
     * absorbida (D-031), así que una bitácora que sólo nombrara la ficha de la
     * URL diría que se leyó la superviviente mientras se revelaba un dato de
     * salud escrito en otra — y la pregunta de arriba se quedaría sin respuesta
     * justo en el caso en que una investigación la hace.
     *
     * LAS DOS FILAS, no una en lugar de la otra: el acceso ocurrió POR `B` y
     * reveló contenido DE `A`.
     */
    const absorbida = await absorbedChartWithGroup('CATASTROPHIC_ILLNESS');

    await groupsOf(medico).expect(200);

    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient_priority_group', action: 'READ' },
      select: { resourceId: true, userId: true },
    });
    expect(trail.map((row) => row.resourceId).sort()).toEqual(
      [absorbida, patientId].sort(),
    );
    expect(new Set(trail.map((row) => row.userId))).toEqual(
      new Set([medicoUserId]),
    );
  });

  it('PA-040 names the ABSORBED chart when a record of it is closed from the surviving chart', async () => {
    // PA-037 cierra fechando, y `closePriorityGroup` alcanza la fila por el
    // alcance (PA-055): la valoración modificada vive en la absorbida, así que
    // el rastro del `UPDATE` tiene que nombrarla igual que el de la lectura.
    const absorbida = await absorbedChartWithGroup('CATASTROPHIC_ILLNESS');
    const record = await prisma.patientPriorityGroup.findFirstOrThrow({
      where: { patientId: absorbida },
      select: { id: true },
    });

    await closeGroup(record.id, { endsOn: today() }).expect(200);

    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient_priority_group', action: 'UPDATE' },
      select: { resourceId: true },
    });
    expect(trail.map((row) => row.resourceId).sort()).toEqual(
      [absorbida, patientId].sort(),
    );
  });

  it('PA-040 writes NO trail row for an absorbed chart whose only reason stayed hidden', async () => {
    /**
     * LA OTRA MITAD, Y SIN ELLA LA BITÁCORA SERÍA EL ORÁCULO QUE D-027 EVITA.
     *
     * Si la fila se escribiera por el ALCANCE CONSULTADO en vez de por lo que
     * de verdad se reveló, quien audita vería que la lectura de `B` tocó `A`
     * —y con ello que `A` guarda algo— aunque quien leyó no viera nada. El
     * rastro dice lo que se leyó, ni más ni menos.
     */
    const absorbida = await absorbedChartWithGroup('CHILD_ABUSE_VICTIM');

    const sinLlave = await groupsOf(medico).expect(200);
    expect((sinLlave.body as { items: PriorityGroupBody[] }).items).toEqual([]);

    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient_priority_group', resourceId: absorbida },
    });
    expect(trail).toHaveLength(0);

    // Y quien SÍ la lee deja su fila, que es lo que hace la aserción anterior
    // una ausencia significativa y no una tabla vacía.
    await groupsOf(trabajoSocial).expect(200);
    const conLlave = await prisma.accessAudit.findMany({
      where: { resourceType: 'patient_priority_group', resourceId: absorbida },
    });
    expect(conLlave).toHaveLength(1);
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
