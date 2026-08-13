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
import {
  createPatient,
  createPractitioner,
  createRoom,
} from './setup/fixtures';

/**
 * The configuration module (C3) as the browser consumes it, against a real
 * PostgreSQL 18.
 *
 * What these prove that the unit suites cannot:
 *
 *   - CF-061 in BOTH scopes. `holiday_date_scope_unique` is
 *     `UNIQUE NULLS NOT DISTINCT`, and the whole reason it is written that way
 *     is the «todas las sedes» row, which a plain unique index would leave
 *     unconstrained. A double cannot demonstrate an index exists, and the
 *     ordinary index would pass every unit test.
 *   - CF-062: the defaults of D-001 are written BY THE DATABASE when a site is
 *     created, whoever creates it. The trigger is the guarantee; a service
 *     doing it would leave an imported site unparametrised.
 *   - CF-064: changing a parameter does not touch one single existing
 *     `agenda_entry` row. Proved by comparing the rows before and after,
 *     because "the service does not call the agenda" is a statement about code
 *     and this is a statement about data.
 *   - CF-065 refused by the BASE and not only by Zod, by writing the value
 *     straight through SQL.
 *   - CF-063, the negative requirement: neither the table nor the endpoint
 *     admits a switch for a guarantee.
 */
const PASSWORD = 'el caballo come alfalfa';
const ADMIN_EMAIL = 'gerencia@clinica.ec';
const RECEPCION_EMAIL = 'recepcion@clinica.ec';

/** Synthetic cedulas with a COMPUTED check digit; never a real person's. */
const ADMIN_CEDULA = '1710034065';
const RECEPCION_CEDULA = '0926687856';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

interface HolidayBody {
  id: string;
  date: string;
  name: string;
  siteId: string | null;
}

describe('la configuración por HTTP', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;

  let token: string;
  let adminUserId: string;

  beforeEach(async () => {
    enableBigIntSerialisation();
    prisma = db();

    if (!app) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // The storage is replaced, not the guard: `APP_GUARD` also covers the
        // authorisation guard, which is exactly what these tests exercise.
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
      await app.init();
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', ADMIN_CEDULA);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'RECEPCION',
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
    if (roleCode === 'ADMIN') adminUserId = user.id;

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    // GLOBAL grant (siteId null): configuring the clinic is not scoped to one
    // of its sites, and this is how a director is hired.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const base = '/api/v1/configuration';

  const get = (path: string, auth = token) =>
    request(app.getHttpServer())
      .get(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`);

  const post = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .post(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const put = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .put(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const patch = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const destroy = (path: string) =>
    request(app.getHttpServer())
      .delete(`${base}${path}`)
      .set('Authorization', `Bearer ${token}`);

  let siteSequence = 0;
  /** A site written straight to the table: the trigger must fire either way. */
  async function createSite(name = 'Sede Central'): Promise<{ id: string }> {
    siteSequence += 1;
    return prisma.site.create({
      data: {
        mspUnicode: `CFG-${String(siteSequence).padStart(4, '0')}`,
        name,
      },
      select: { id: true },
    });
  }

  describe('los feriados', () => {
    it('CF-060 registra un feriado con fecha, nombre y alcance de todas las sedes', async () => {
      const response = await post('/holidays', {
        date: '2026-01-01',
        name: 'Año Nuevo',
      }).expect(201);

      expect(response.body).toMatchObject({
        date: '2026-01-01',
        name: 'Año Nuevo',
        siteId: null,
      });
    });

    it('CF-060 registra un feriado de una sola sede', async () => {
      const site = await createSite();

      const response = await post('/holidays', {
        date: '2026-07-25',
        name: 'Fundación de Guayaquil',
        siteId: site.id,
      }).expect(201);

      expect((response.body as HolidayBody).siteId).toBe(site.id);
    });

    it('CF-060 conserva el día del calendario sin desplazarlo por el huso', async () => {
      // Un `Date` a medianoche UTC es el 31 de diciembre a las 19:00 en
      // `America/Guayaquil`. Si el feriado viajara como instante, «1 de enero»
      // volvería como 31 de diciembre para todo el país.
      await post('/holidays', { date: '2026-01-01', name: 'Año Nuevo' }).expect(201); // prettier-ignore

      const listed = await get('/holidays?year=2026').expect(200);
      expect((listed.body as { items: HolidayBody[] }).items[0]?.date).toBe(
        '2026-01-01',
      );
    });

    it('CF-060 lista sólo los feriados del año pedido', async () => {
      await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      await post('/holidays', { date: '2027-01-01', name: 'Año Nuevo' }).expect(201); // prettier-ignore

      const response = await get('/holidays?year=2026').expect(200);
      const items = (response.body as { items: HolidayBody[] }).items;

      expect(items.map((holiday) => holiday.name)).toEqual(['Navidad']);
    });

    it('CF-060 al filtrar por sede devuelve también los que valen para todas', async () => {
      // Lo que una sede OBSERVA son sus feriados más los de la clínica entera.
      // Devolver sólo los suyos dejaría reservar el 1 de enero porque la fila
      // que lo prohíbe no es de nadie en particular.
      const site = await createSite();
      const other = await createSite('Sede Norte');

      await post('/holidays', { date: '2026-01-01', name: 'Año Nuevo' }).expect(201); // prettier-ignore
      await post('/holidays', { date: '2026-07-25', name: 'Fundación', siteId: site.id }).expect(201); // prettier-ignore
      await post('/holidays', { date: '2026-11-11', name: 'Independencia de Cuenca', siteId: other.id }).expect(201); // prettier-ignore

      const response = await get(`/holidays?year=2026&siteId=${site.id}`).expect(200); // prettier-ignore
      const items = (response.body as { items: HolidayBody[] }).items;

      expect(items.map((holiday) => holiday.name)).toEqual([
        'Año Nuevo',
        'Fundación',
      ]);
    });

    it('CF-061 rechaza dos feriados en la misma fecha para TODAS las sedes', async () => {
      // El caso que un `UNIQUE (date, site_id)` corriente NO cubre: en
      // PostgreSQL dos NULL no son iguales, así que sin
      // `NULLS NOT DISTINCT` esta segunda inserción pasaría — y es la fila que
      // más daño hace, porque la obedecen todas las sedes.
      await post('/holidays', { date: '2026-05-01', name: 'Día del Trabajo' }).expect(201); // prettier-ignore

      const response = await post('/holidays', {
        date: '2026-05-01',
        name: 'Día del Trabajo (repetido)',
      }).expect(409);

      expect((response.body as Problem).code).toBe('HOLIDAY_DUPLICATE');
    });

    it('CF-061 rechaza dos feriados en la misma fecha para la misma sede', async () => {
      const site = await createSite();
      await post('/holidays', { date: '2026-05-24', name: 'Batalla de Pichincha', siteId: site.id }).expect(201); // prettier-ignore

      const response = await post('/holidays', {
        date: '2026-05-24',
        name: 'Otro nombre',
        siteId: site.id,
      }).expect(409);

      expect((response.body as Problem).code).toBe('HOLIDAY_DUPLICATE');
    });

    it('CF-061 admite la misma fecha en dos alcances distintos: son cosas distintas', async () => {
      // «1 de enero en todas las sedes» y «1 de enero en la sede X» no son el
      // mismo feriado. Si el índice los confundiera, una sede no podría añadir
      // su fiesta local el día de un feriado nacional.
      const site = await createSite();

      await post('/holidays', { date: '2026-01-01', name: 'Año Nuevo' }).expect(201); // prettier-ignore
      await post('/holidays', { date: '2026-01-01', name: 'Cierre de la sede', siteId: site.id }).expect(201); // prettier-ignore

      const listed = await get('/holidays?year=2026').expect(200);
      expect((listed.body as { items: HolidayBody[] }).items).toHaveLength(2);
    });

    it('CF-061 vuelve a rechazar el duplicado cuando se llega a él editando', async () => {
      await post('/holidays', { date: '2026-01-01', name: 'Año Nuevo' }).expect(201); // prettier-ignore
      const second = await post('/holidays', { date: '2026-01-02', name: 'Puente' }).expect(201); // prettier-ignore

      const response = await patch(
        `/holidays/${(second.body as HolidayBody).id}`,
        { date: '2026-01-01' },
      ).expect(409);

      expect((response.body as Problem).code).toBe('HOLIDAY_DUPLICATE');
    });

    it('CF-060 edita el nombre sin tocar el alcance', async () => {
      const site = await createSite();
      const created = await post('/holidays', { date: '2026-08-10', name: 'Primer Grito', siteId: site.id }).expect(201); // prettier-ignore

      const response = await patch(
        `/holidays/${(created.body as HolidayBody).id}`,
        { name: 'Primer Grito de Independencia' },
      ).expect(200);

      expect(response.body).toMatchObject({
        name: 'Primer Grito de Independencia',
        siteId: site.id,
      });
    });

    it('CF-060 borra un feriado y responde 404 la segunda vez', async () => {
      const created = await post('/holidays', { date: '2026-10-09', name: 'Independencia de Guayaquil' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;

      await destroy(`/holidays/${id}`).expect(204);
      const second = await destroy(`/holidays/${id}`).expect(404);

      expect((second.body as Problem).code).toBe('HOLIDAY_NOT_FOUND');
    });

    it('CF-066 deja en la bitácora cada mutación de un feriado, y ninguna lectura', async () => {
      const created = await post('/holidays', { date: '2026-11-02', name: 'Día de los Difuntos' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;
      await patch(`/holidays/${id}`, { name: 'Difuntos' }).expect(200);
      await get('/holidays?year=2026').expect(200);
      await destroy(`/holidays/${id}`).expect(204);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration' },
        orderBy: { occurredAt: 'asc' },
        select: { action: true, resourceId: true, userId: true },
      });

      expect(trail).toEqual([
        { action: 'CREATE', resourceId: id, userId: adminUserId },
        { action: 'UPDATE', resourceId: id, userId: adminUserId },
        { action: 'UPDATE', resourceId: id, userId: adminUserId },
      ]);
    });
  });

  describe('los parámetros de la sede', () => {
    it('CF-062 escribe los valores de D-001 al crear la sede, sin que nadie los pida', async () => {
      const site = await createSite();

      const response = await get(`/sites/${site.id}/parameters`).expect(200);

      expect(response.body).toEqual({
        siteId: site.id,
        minLeadMinutes: 0,
        maxLeadDays: 180,
        overbookingCap: 2,
        cancelledRetention: 'NEVER',
      });
    });

    it('CF-062 los escribe también cuando la sede la crea el módulo de organización', async () => {
      // El disparador es la garantía justamente porque el alta puede venir de
      // cualquier sitio: la pantalla, una importación o un `INSERT` a mano.
      const created = await request(app.getHttpServer())
        .post('/api/v1/organization/sites')
        .set('Authorization', `Bearer ${token}`)
        .send({ mspUnicode: 'CFG-ORG-1', name: 'Sede creada por pantalla' })
        .expect(201);

      const siteId = (created.body as { id: string }).id;
      const stored = await prisma.siteParameter.findUnique({
        where: { siteId },
      });

      expect(stored).toMatchObject({
        minLeadMinutes: 0,
        maxLeadDays: 180,
        overbookingCap: 2,
        cancelledRetention: 'NEVER',
      });
    });

    it('CF-062 responde SITE_PARAMETERS_NOT_FOUND para una sede que no existe', async () => {
      const response = await get(
        '/sites/00000000-0000-7000-8000-000000000000/parameters',
      ).expect(404);

      expect((response.body as Problem).code).toBe('SITE_PARAMETERS_NOT_FOUND');
    });

    it('CF-062 guarda un cambio parcial sin pisar el resto de los parámetros', async () => {
      const site = await createSite();

      const response = await put(`/sites/${site.id}/parameters`, {
        overbookingCap: 5,
      }).expect(200);

      expect(response.body).toMatchObject({
        overbookingCap: 5,
        minLeadMinutes: 0,
        maxLeadDays: 180,
      });
    });

    it('CF-065 rechaza un tope de sobrecupos fuera de rango nombrando el rango', async () => {
      const site = await createSite();

      const response = await put(`/sites/${site.id}/parameters`, {
        overbookingCap: 99,
      }).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PARAM_OUT_OF_RANGE');
      expect(problem.errors?.[0]).toEqual({
        field: 'overbookingCap',
        code: 'PARAM_OUT_OF_RANGE',
        message: 'El tope de sobrecupos va de 0 a 20',
      });
    });

    it('CF-065 lo rechaza LA BASE, no sólo el DTO', async () => {
      // La comprobación de la aplicación responde mejor, pero no protege a la
      // base de un `psql` a las dos de la mañana ni de un script de migración
      // de datos. Se escribe por SQL, saltándose Zod y el servicio enteros.
      const site = await createSite();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE site_parameter SET overbooking_cap = 99 WHERE site_id = $1::uuid`,
          site.id,
        ),
      ).rejects.toThrow(/site_parameter_overbooking_cap_range/);

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE site_parameter SET min_lead_minutes = -1 WHERE site_id = $1::uuid`,
          site.id,
        ),
      ).rejects.toThrow(/site_parameter_min_lead_minutes_range/);

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE site_parameter SET max_lead_days = 0 WHERE site_id = $1::uuid`,
          site.id,
        ),
      ).rejects.toThrow(/site_parameter_max_lead_days_range/);
    });

    it('CF-065 la base también rechaza una ventana de reserva incoherente', async () => {
      const site = await createSite();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE site_parameter SET min_lead_minutes = 10080, max_lead_days = 1 WHERE site_id = $1::uuid`,
          site.id,
        ),
      ).rejects.toThrow(/site_parameter_lead_window_coherent/);
    });

    it('CF-066 deja en la bitácora quién cambió los parámetros y de qué sede', async () => {
      const site = await createSite();
      await put(`/sites/${site.id}/parameters`, { maxLeadDays: 60 }).expect(
        200,
      );
      await get(`/sites/${site.id}/parameters`).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration' },
        select: { action: true, resourceId: true, userId: true },
      });

      expect(trail).toEqual([
        { action: 'UPDATE', resourceId: site.id, userId: adminUserId },
      ]);
    });
  });

  describe('CF-064 · un parámetro rige hacia adelante', () => {
    it('CF-064 no toca ni una sola cita ya reservada al acortar la antelación máxima', async () => {
      const site = await createSite();
      const room = await createRoom(prisma, site.id);
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);

      // Una cita a 120 días vista: perfectamente válida con los 180 de D-001, y
      // fuera de rango en cuanto la máxima baje a 30.
      const startsAt = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
      const entry = await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: patient.id,
          roomId: room.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 20 * 60 * 1000),
          bookingChannel: 'PHONE',
        },
      });

      const before = await prisma.agendaEntry.findMany();

      await put(`/sites/${site.id}/parameters`, {
        maxLeadDays: 30,
        minLeadMinutes: 60,
      }).expect(200);

      const after = await prisma.agendaEntry.findMany();

      // Row for row, column for column, `updated_at` included: not «sigue
      // BOOKED» —que pasaría igual si algo la hubiera reescrito conservando el
      // estado— sino que nada la tocó.
      expect(after).toEqual(before);
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(entry.id);
      expect(after[0]?.status).toBe('BOOKED');

      // Y el historial de estados tampoco creció: una revalidación silenciosa
      // habría dejado una transición aquí.
      const history = await prisma.agendaStatusHistory.count();
      expect(history).toBe(0);
    });
  });

  describe('CF-063 · lo que no se puede configurar', () => {
    it('CF-063 no guarda un interruptor de solapamiento, de historial ni de cierre por defecto', async () => {
      const site = await createSite();

      await put(`/sites/${site.id}/parameters`, {
        overbookingCap: 3,
        allowOverlap: true,
        historyImmutable: false,
        closedByDefault: false,
      }).expect(200);

      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });

      // Lo enviado de más se descartó; lo legítimo se guardó.
      expect(stored.overbookingCap).toBe(3);
      expect(Object.keys(stored)).toEqual([
        'siteId',
        'minLeadMinutes',
        'maxLeadDays',
        'overbookingCap',
        'cancelledRetention',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('CF-063 la tabla de parámetros no tiene ninguna columna que apague una garantía', async () => {
      // La prueba se hace contra `information_schema` y no contra el modelo de
      // Prisma: la columna la crearía una migración, y una migración puede
      // añadir lo que `schema.prisma` no menciona.
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'site_parameter'
         ORDER BY column_name
      `;

      expect(columns.map((column) => column.column_name)).toEqual([
        'cancelled_retention',
        'created_at',
        'max_lead_days',
        'min_lead_minutes',
        'overbooking_cap',
        'site_id',
        'updated_at',
      ]);
    });

    it('CF-063 el no-solapamiento sigue siendo una garantía de la base, no un ajuste', async () => {
      // La otra mitad del requisito: no basta con que no exista el
      // interruptor; lo que apagaría tiene que seguir encendido.
      const site = await createSite();
      const practitioner = await createPractitioner(prisma);
      const patient = await createPatient(prisma);
      const startsAt = new Date('2026-09-14T13:00:00Z');

      const book = () =>
        prisma.agendaEntry.create({
          data: {
            kind: 'APPOINTMENT',
            siteId: site.id,
            practitionerId: practitioner.id,
            patientId: patient.id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 20 * 60 * 1000),
            bookingChannel: 'PHONE',
          },
        });

      await book();
      await expect(book()).rejects.toThrow(
        /agenda_entry_no_practitioner_overlap/,
      );
    });
  });

  describe('quién puede configurar', () => {
    it('CF-060 rechaza a quien no tiene settings:manage al crear un feriado', async () => {
      const receptionToken = await signIn(RECEPCION_EMAIL, 'RECEPCION', RECEPCION_CEDULA); // prettier-ignore

      const response = await post(
        '/holidays',
        { date: '2026-01-01', name: 'Año Nuevo' },
        receptionToken,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });

    it('CF-062 rechaza a quien no tiene settings:read al consultar los parámetros', async () => {
      // Recepción reserva citas; el tope de sobrecupos y la antelación son del
      // administrador (D-002). Que no pueda ni leerlos es la decisión, no un
      // olvido.
      const site = await createSite();
      const receptionToken = await signIn(RECEPCION_EMAIL, 'RECEPCION', RECEPCION_CEDULA); // prettier-ignore

      const response = await get(
        `/sites/${site.id}/parameters`,
        receptionToken,
      ).expect(403);

      expect((response.body as Problem).code).toBe('PERMISSION_DENIED');
    });
  });
});
