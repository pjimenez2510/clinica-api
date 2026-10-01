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
  establishmentId,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

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
  /** AG-092. Las sedes que trabajan ese feriado. */
  workedBySiteIds: string[];
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
      await listenForTests(app);
      registry = app.get(RolePermissionRegistry);
    }

    await syncAuthorisation(prisma);
    // The role→permission cache is indexed by id, and truncation recreates the
    // roles with fresh ids: without this every request answers 403.
    registry.invalidate();

    token = await signIn(ADMIN_EMAIL, 'ADMIN', ADMIN_CEDULA);
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function signIn(
    email: string,
    roleCode: 'ADMIN' | 'RECEPCION',
    cedula: string,
    /** CF-067: a grant confined to ONE site. Absent = clinic-wide. */
    grantedSiteId?: string,
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
    // Only the clinic-wide administrator authors the audit assertions; a
    // site-scoped one must not take the name from underneath them.
    if (roleCode === 'ADMIN' && grantedSiteId === undefined) {
      adminUserId = user.id;
    }

    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    // GLOBAL grant (siteId null): configuring the clinic is not scoped to one
    // of its sites, and this is how a director is hired. CF-067 is what
    // happens when the grant is NOT global.
    await prisma.userRoleGrant.create({
      data: { userId: user.id, roleId: role.id, siteId: grantedSiteId },
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

  const patch = (path: string, body: Record<string, unknown>, auth = token) =>
    request(app.getHttpServer())
      .patch(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);

  const destroy = (path: string, auth = token) =>
    request(app.getHttpServer())
      .delete(`${base}${path}`)
      .set('Authorization', `Bearer ${auth}`);

  let siteSequence = 0;
  /** A site written straight to the table: the trigger must fire either way. */
  async function createSite(name = 'Sede Central'): Promise<{ id: string }> {
    siteSequence += 1;
    return prisma.site.create({
      data: {
        mspUnicode: `CFG-${String(siteSequence).padStart(4, '0')}`,
        name,
        establishmentId: await establishmentId(prisma),
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

    it('AG-092 marca una sede como laborable en un feriado nacional y lo deshace', async () => {
      /**
       * EL REQUISITO LITERAL: «admitir marcar un feriado como laborable para
       * una sede concreta: una clínica con urgencias atiende el 25 de
       * diciembre». Antes de esto la tabla existía y sólo la leía la agenda:
       * la única forma de que urgencias abriera era borrar el feriado
       * nacional, y entonces abrían todas las sedes.
       */
      const urgencias = await createSite('Sede Urgencias');
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;

      // El feriado nace sin excepciones y lo dice.
      expect((created.body as HolidayBody).workedBySiteIds).toEqual([]);

      const marked = await put(`/holidays/${id}/worked-by/${urgencias.id}`, {}).expect(200); // prettier-ignore
      expect(marked.body).toMatchObject({
        // El feriado SIGUE siendo nacional: la excepción no le cambia el
        // alcance, que es la diferencia entre esto y borrarlo.
        siteId: null,
        workedBySiteIds: [urgencias.id],
      });

      // Y el listado del año lo cuenta, sin que nadie pregunte sede a sede.
      const listed = await get('/holidays?year=2026').expect(200);
      expect(
        (listed.body as { items: HolidayBody[] }).items[0]?.workedBySiteIds,
      ).toEqual([urgencias.id]);

      // La fila que queda es EXACTAMENTE el par que la agenda lee. La otra
      // mitad del requisito —que con esa fila la sede conserve sus cupos y las
      // demás sigan cerradas— se prueba en `agenda-holidays.spec.ts`, contra
      // esta misma tabla y contra la misma base.
      expect(
        await prisma.holidaySiteException.findMany({
          select: { holidayId: true, siteId: true },
        }),
      ).toEqual([{ holidayId: id, siteId: urgencias.id }]);

      const unmarked = await destroy(`/holidays/${id}/worked-by/${urgencias.id}`).expect(200); // prettier-ignore
      expect((unmarked.body as HolidayBody).workedBySiteIds).toEqual([]);
    });

    it('AG-092 admite marcar dos veces la misma sede sin inventarse un conflicto', async () => {
      // La clave primaria ES el par: decirlo dos veces no significa nada
      // distinto, así que el segundo clic merece «hecho» y no un 409.
      const site = await createSite('Sede Urgencias');
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;

      await put(`/holidays/${id}/worked-by/${site.id}`, {}).expect(200);
      const second = await put(`/holidays/${id}/worked-by/${site.id}`, {}).expect(200); // prettier-ignore

      expect((second.body as HolidayBody).workedBySiteIds).toEqual([site.id]);
      expect(await prisma.holidaySiteException.count()).toBe(1);
    });

    it('AG-092 responde HOLIDAY_NOT_FOUND al marcar un feriado que no existe', async () => {
      const site = await createSite();

      const response = await put(
        `/holidays/00000000-0000-7000-8000-000000000000/worked-by/${site.id}`,
        {},
      ).expect(404);

      expect((response.body as Problem).code).toBe('HOLIDAY_NOT_FOUND');
    });

    it('AG-092 responde SITE_NOT_FOUND cuando la sede indicada no existe', async () => {
      // Lo arbitra la clave foránea, no una lectura previa: el código es de
      // `organization`, dueña de la sede, y este módulo sólo traduce el
      // rechazo de PostgreSQL.
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;

      const response = await put(
        `/holidays/${id}/worked-by/00000000-0000-7000-8000-000000000000`,
        {},
      ).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('SITE_NOT_FOUND');
      expect(problem.errors?.[0]).toMatchObject({ field: 'siteId' });
    });

    it('AG-092 desmarcar una sede que no trabajaba el feriado deja el estado que se pidió', async () => {
      // Idempotente a propósito: quien pide «esta sede NO trabaja este
      // feriado» y ya no lo trabajaba obtuvo lo que pedía.
      const site = await createSite();
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;

      const response = await destroy(`/holidays/${id}/worked-by/${site.id}`).expect(200); // prettier-ignore

      expect((response.body as HolidayBody).workedBySiteIds).toEqual([]);
    });

    it('AG-092 responde HOLIDAY_NOT_FOUND al desmarcar un feriado que no existe', async () => {
      const site = await createSite();

      const response = await destroy(
        `/holidays/00000000-0000-7000-8000-000000000000/worked-by/${site.id}`,
      ).expect(404);

      expect((response.body as Problem).code).toBe('HOLIDAY_NOT_FOUND');
    });

    it('AG-092 borra la excepción con el feriado, sin dejar filas colgando', async () => {
      // `ON DELETE CASCADE`, y por eso se comprueba contra la base: la fila no
      // es evidencia clínica y no significa nada sin su feriado.
      const site = await createSite();
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;
      await put(`/holidays/${id}/worked-by/${site.id}`, {}).expect(200);

      await destroy(`/holidays/${id}`).expect(204);

      expect(await prisma.holidaySiteException.count()).toBe(0);
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

    it('AG-097 · CF-066 la bitácora dice desde qué valor cambió el feriado', async () => {
      // D-017. `before` is the half that lets somebody reconstruct why the
      // agenda behaved one way in March and another in April; without it the
      // trail answers «quién y cuándo» and stops there.
      const created = await post('/holidays', { date: '2026-11-02', name: 'Día de los Difuntos' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;
      await patch(`/holidays/${id}`, { name: 'Difuntos' }).expect(200);
      await destroy(`/holidays/${id}`).expect(204);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration' },
        // By id and not by instant: BIGSERIAL is strictly increasing, and two
        // requests in the same microsecond would order arbitrarily.
        orderBy: { id: 'asc' },
        select: { action: true, before: true, after: true },
      });

      const difuntos = {
        id,
        date: '2026-11-02',
        name: 'Día de los Difuntos',
        siteId: null,
        workedBySiteIds: [],
      };

      expect(trail).toEqual([
        // Nothing was replaced, so there is no previous value to state.
        { action: 'CREATE', before: null, after: difuntos },
        {
          action: 'UPDATE',
          before: difuntos,
          after: { ...difuntos, name: 'Difuntos' },
        },
        // Deleting leaves what disappeared and nothing after it.
        { action: 'UPDATE', before: { ...difuntos, name: 'Difuntos' }, after: null }, // prettier-ignore
      ]);
    });

    it('AG-092 · CF-066 la bitácora dice qué sedes trabajaban el feriado antes', async () => {
      const site = await createSite();
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;

      await put(`/holidays/${id}/worked-by/${site.id}`, {}).expect(200);
      await destroy(`/holidays/${id}/worked-by/${site.id}`).expect(200);

      const trail = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration', action: 'UPDATE' },
        orderBy: { id: 'asc' },
        select: { before: true, after: true },
      });

      expect(trail.map((row) => [row.before, row.after])).toEqual([
        [
          expect.objectContaining({ workedBySiteIds: [] }),
          expect.objectContaining({ workedBySiteIds: [site.id] }),
        ],
        [
          expect.objectContaining({ workedBySiteIds: [site.id] }),
          expect.objectContaining({ workedBySiteIds: [] }),
        ],
      ]);
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * CF-067 — EL FERIADO NACIONAL ES UN ACTO DE ALCANCE GLOBAL (D-023)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Las rutas de escritura declaraban `global` mientras el alcance del
     * feriado viajaba en el CUERPO, donde el guard no mira. Y ese alcance no
     * es una etiqueta: un feriado con `site_id IS NULL` CIERRA LA AGENDA DE
     * TODAS LAS SEDES (AG-015, AG-090), incluidas las que se abran después.
     * Crearlo, moverlo o borrarlo es por tanto un acto de clínica entera, y el
     * único alcance que lo contiene es tener `settings:manage` concedido a
     * nivel de clínica.
     */
    describe('el alcance por sede de los feriados (CF-067)', () => {
      const SEDE_ADMIN_EMAIL = 'admin.feriados@clinica.ec';
      /** Cédula sintética con dígito verificador calculado. */
      const SEDE_ADMIN_CEDULA = '0904123353';

      async function scopedTo(siteId: string): Promise<string> {
        return signIn(SEDE_ADMIN_EMAIL, 'ADMIN', SEDE_ADMIN_CEDULA, siteId);
      }

      it('CF-067 quien sólo administra Norte no puede crear el feriado de Sur', async () => {
        const norte = await createSite('Sede Norte');
        const sur = await createSite('Sede Sur');
        const scoped = await scopedTo(norte.id);

        const response = await post(
          '/holidays',
          { date: '2026-08-10', name: 'Primer Grito', siteId: sur.id },
          scoped,
        ).expect(403);

        expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
        expect(await prisma.holiday.count()).toBe(0);
        // La negativa no confirma que ese identificador sea una sede.
        expect(JSON.stringify(response.body)).not.toContain(sur.id);
      });

      it('CF-067 tampoco puede crear un feriado NACIONAL: cerraría la agenda de todas', async () => {
        const norte = await createSite('Sede Norte');
        await createSite('Sede Sur');
        const scoped = await scopedTo(norte.id);

        // Sin `siteId`, que es como se declara «todas las sedes» (CF-060).
        const response = await post(
          '/holidays',
          { date: '2026-08-10', name: 'Primer Grito' },
          scoped,
        ).expect(403);

        expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
        expect(await prisma.holiday.count()).toBe(0);
      });

      it('CF-067 tampoco puede EDITAR un feriado nacional, ni para renombrarlo', async () => {
        const norte = await createSite('Sede Norte');
        const created = await post('/holidays', { date: '2026-11-02', name: 'Difuntos' }).expect(201); // prettier-ignore
        const { id } = created.body as HolidayBody;
        const scoped = await scopedTo(norte.id);

        const response = await patch(
          `/holidays/${id}`,
          { name: 'Día de los Difuntos' },
          scoped,
        ).expect(403);

        expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
        const kept = await prisma.holiday.findUniqueOrThrow({ where: { id } });
        expect(kept.name).toBe('Difuntos');
      });

      it('CF-067 tampoco puede ASCENDER su feriado a nacional: cerraría la agenda de las demás', async () => {
        const norte = await createSite('Sede Norte');
        const created = await post('/holidays', {
          date: '2026-09-24',
          name: 'Fiestas de Norte',
          siteId: norte.id,
        }).expect(201);
        const { id } = created.body as HolidayBody;
        const scoped = await scopedTo(norte.id);

        const response = await patch(
          `/holidays/${id}`,
          { siteId: null },
          scoped,
        ).expect(403);

        expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
        const kept = await prisma.holiday.findUniqueOrThrow({ where: { id } });
        expect(kept.siteId).toBe(norte.id);
      });

      it('CF-067 tampoco puede DEGRADAR a su sede un feriado nacional: el otro extremo', async () => {
        // El alcance que llega sí es suyo, así que mirar sólo eso dejaría pasar
        // lo contrario del caso anterior: quedarse Norte el feriado y REABRIR
        // ese día en todas las demás sedes, que es igual de global.
        const norte = await createSite('Sede Norte');
        await createSite('Sede Sur');
        const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
        const { id } = created.body as HolidayBody;
        const scoped = await scopedTo(norte.id);

        const response = await patch(
          `/holidays/${id}`,
          { siteId: norte.id },
          scoped,
        ).expect(403);

        expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
        const kept = await prisma.holiday.findUniqueOrThrow({ where: { id } });
        expect(kept.siteId).toBeNull();
      });

      it('CF-067 tampoco puede BORRAR un feriado nacional: lo abriría en todas las sedes', async () => {
        const norte = await createSite('Sede Norte');
        const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
        const { id } = created.body as HolidayBody;
        const scoped = await scopedTo(norte.id);

        const response = await destroy(`/holidays/${id}`, scoped).expect(403);

        expect((response.body as Problem).code).toBe('SITE_SCOPE_DENIED');
        expect(await prisma.holiday.count()).toBe(1);
      });

      it('CF-067 sí administra los feriados de SU sede: la comprobación no es un muro', async () => {
        const norte = await createSite('Sede Norte');
        const scoped = await scopedTo(norte.id);

        const created = await post(
          '/holidays',
          { date: '2026-09-24', name: 'Fiestas de Norte', siteId: norte.id },
          scoped,
        ).expect(201);
        const { id } = created.body as HolidayBody;

        await patch(`/holidays/${id}`, { name: 'Fiestas de la ciudad' }, scoped).expect(200); // prettier-ignore
        await destroy(`/holidays/${id}`, scoped).expect(204);

        expect(await prisma.holiday.count()).toBe(0);
      });

      it('CF-067 y SIGUE LEYENDO el calendario entero, feriados nacionales incluidos', async () => {
        // El listado no se estrecha a propósito: las filas con `site_id` nulo
        // no son de ninguna sede y toda sede las obedece, así que filtrarlas
        // por el alcance de quien llama escondería justo las que le aplican.
        const norte = await createSite('Sede Norte');
        await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
        const scoped = await scopedTo(norte.id);

        const response = await get('/holidays?year=2026', scoped).expect(200);

        expect((response.body as { items: HolidayBody[] }).items).toEqual([
          expect.objectContaining({ name: 'Navidad', siteId: null }),
        ]);
      });

      it('CF-067 la concesión de clínica sigue pudiéndolo todo: es la dirección', async () => {
        const sur = await createSite('Sede Sur');

        // `token` es la administradora con concesión global (`siteId` nulo).
        const national = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
        const surHoliday = await post('/holidays', {
          date: '2026-09-24',
          name: 'Fiestas de Sur',
          siteId: sur.id,
        }).expect(201);

        await patch(`/holidays/${(national.body as HolidayBody).id}`, { name: 'Navidad ' }).expect(200); // prettier-ignore
        await destroy(`/holidays/${(surHoliday.body as HolidayBody).id}`).expect(204); // prettier-ignore
      });
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
        // D-021: el turno de la agenda. Diez es el único de la banda estándar
        // del que son múltiplos las tres duraciones ya configuradas.
        slotAtomMinutes: 10,
        // AG-031, AG-094: el interruptor nace cerrado. Que una sede abra el
        // pasado es decisión suya; tenerlo abierto de fábrica sería nuestra.
        allowPastBooking: false,
        // AG-039, AG-094 (E4, D-005): y el del sobrecupo nace ABIERTO, que es
        // la decisión contraria y a propósito — es la vía documentada de la
        // excepción, y lo que la limita es `overbookingCap`.
        overbookingEnabled: true,
        overbookingPermission: 'agenda:overbook',
        // AG-066, AG-094 (E5): el octavo parámetro, que entró con la lista de
        // espera. Tres es la recomendación de D-040 (a) hasta que la clínica
        // conteste, y es el defecto de la columna: cambiarlo cuesta una
        // pantalla y no una migración.
        waitlistMaxContactAttempts: 3,
        cancelledRetention: 'NEVER',
        criticalNoticeWithinMinutes: 60,
        criticalEscalationRoleId: null,
        unmatchedResultOwnerRoleId: null,
        unmatchedResultDeadlineHours: 24,
      });
    });

    it('CF-062 los escribe también cuando la sede la crea el módulo de organización', async () => {
      // El disparador es la garantía justamente porque el alta puede venir de
      // cualquier sitio: la pantalla, una importación o un `INSERT` a mano.
      await establishmentId(prisma); // OR-032
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
        allowPastBooking: false,
        overbookingEnabled: true,
        overbookingPermission: 'agenda:overbook',
        cancelledRetention: 'NEVER',
        criticalNoticeWithinMinutes: 60,
        criticalEscalationRoleId: null,
        unmatchedResultOwnerRoleId: null,
        unmatchedResultDeadlineHours: 24,
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

    it('AG-094 abre y vuelve a cerrar la reserva en el pasado desde la aplicación', async () => {
      /**
       * REQ-145 EN UNA FRASE: la sede con urgencias que registra a posteriori
       * lo activa desde la pantalla, no con un `psql`. Antes de E7 la columna
       * existía y no había forma de tocarla ni de VERLA, que es la mitad que
       * más engaña: un administrador no puede saber con qué está operando su
       * sede si el parámetro no viaja en la respuesta.
       */
      const site = await createSite();

      const opened = await put(`/sites/${site.id}/parameters`, {
        allowPastBooking: true,
      }).expect(200);
      expect(opened.body).toMatchObject({ allowPastBooking: true });

      // Y se lee de vuelta, que es lo que la pantalla enseña.
      const read = await get(`/sites/${site.id}/parameters`).expect(200);
      expect(read.body).toMatchObject({ allowPastBooking: true });

      // Volver a cerrarlo es un `false`, y `false` no es «no lo envié»: la
      // trampa de los valores falsy dejaría la sede abierta contestando que se
      // guardó.
      const closed = await put(`/sites/${site.id}/parameters`, {
        allowPastBooking: false,
      }).expect(200);
      expect(closed.body).toMatchObject({ allowPastBooking: false });

      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });
      expect(stored.allowPastBooking).toBe(false);
      // Y no arrastró a los demás parámetros al pasar por encima.
      expect(stored.maxLeadDays).toBe(180);
    });

    it('AG-039, AG-094 apaga y vuelve a encender el sobrecupo desde la aplicación', async () => {
      // Un parámetro que no se puede tocar desde la aplicación es el defecto
      // que ya se corrigió una vez con `allowPastBooking` (REQ-145).
      const site = await createSite();

      const off = await put(`/sites/${site.id}/parameters`, {
        overbookingEnabled: false,
      }).expect(200);
      expect(off.body).toMatchObject({ overbookingEnabled: false });

      const on = await put(`/sites/${site.id}/parameters`, {
        overbookingEnabled: true,
      }).expect(200);
      expect(on.body).toMatchObject({ overbookingEnabled: true });
    });

    it('AG-101 guarda el permiso que autoriza los sobrecupos y lo devuelve', async () => {
      const site = await createSite();

      const response = await put(`/sites/${site.id}/parameters`, {
        overbookingPermission: 'settings:manage',
      }).expect(200);

      expect(response.body).toMatchObject({
        overbookingPermission: 'settings:manage',
      });
      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });
      expect(stored.overbookingPermission).toBe('settings:manage');
    });

    it('AG-101 rechaza con UNKNOWN_PERMISSION un permiso que el código no declara', async () => {
      /**
       * ES EL ÚNICO CÓDIGO DE PERMISO QUE ESTE ESQUEMA GUARDA COMO DATO. Con
       * una errata dentro, la comprobación de AG-101 no la pasa NADIE: la sede
       * se queda sin poder autorizar sobrecupos y ninguna pantalla lo dice.
       * Qué permisos existen es código (AU-033), y el catálogo es la
       * enumeración contra la que se valida.
       */
      const site = await createSite();

      const response = await put(`/sites/${site.id}/parameters`, {
        overbookingPermission: 'agenda:overbok',
      }).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('UNKNOWN_PERMISSION');
      expect(problem.errors?.[0]).toMatchObject({
        field: 'overbookingPermission',
        code: 'UNKNOWN_PERMISSION',
      });
      expect(problem.errors?.[0]?.message).toContain('agenda:overbok');

      // Y no se guardó: la sede sigue autorizando con lo que tenía.
      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });
      expect(stored.overbookingPermission).toBe('agenda:overbook');
    });

    it('AG-101 la BASE rechaza un permiso inventado aunque la escritura no pase por la aplicación', async () => {
      // `trg_site_parameter_overbooking_permission`. Es un disparador y no una
      // clave foránea a propósito: la fila la escribe el disparador de CF-062
      // al crear la sede, y una FK ataría CREAR UNA SEDE a que el espejo
      // `permission` ya estuviera sembrado.
      const site = await createSite();

      // El disparador levanta `foreign_key_violation`, que es lo que este
      // valor incumple; Prisma lo traduce a su error de clave foránea sin
      // nombre —de ahí que la aserción sea sobre el rechazo y sobre la fila,
      // no sobre el texto—. Lo que importa es que la escritura NO ocurrió.
      await expect(
        prisma.siteParameter.update({
          where: { siteId: site.id },
          data: { overbookingPermission: 'agenda:overbok' },
        }),
      ).rejects.toThrow(/[Ff]oreign key/);

      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });
      expect(stored.overbookingPermission).toBe('agenda:overbook');
    });

    it('AG-101 la BASE deja pasar los guardados que no tocan el permiso', async () => {
      // El disparador es `BEFORE UPDATE OF overbooking_permission` y con
      // `WHEN … IS DISTINCT FROM …`: no corre en la mayoría de los guardados
      // de esa pantalla, que son números.
      const site = await createSite();

      await expect(
        prisma.siteParameter.update({
          where: { siteId: site.id },
          data: { maxLeadDays: 90 },
        }),
      ).resolves.toMatchObject({ maxLeadDays: 90 });
    });

    it('ORD-063, ORD-046 y ORD-065 guardan el plazo de los críticos y los roles de las colas, y rechazan un rol que no existe o que no puede trabajarlas', async () => {
      const site = await createSite();
      const role = await prisma.role.create({
        data: {
          code: 'GUARDIA_CLINICA',
          name: 'Responsable clínico de guardia',
          // ORD-046, ORD-065: un rol que responde de una cola tiene que poder
          // verla y trabajarla.
          permissions: {
            create: [
              { permissionCode: 'record:read' },
              { permissionCode: 'result:write' },
            ],
          },
        },
      });
      const cashier = await prisma.role.create({
        data: { code: 'CAJA_PRUEBA', name: 'Caja de prueba' },
      });

      // Control positivo: un rol que existe se guarda, y `null` quita el plazo.
      const saved = await put(`/sites/${site.id}/parameters`, {
        criticalNoticeWithinMinutes: 60,
        criticalEscalationRoleId: role.id,
        unmatchedResultOwnerRoleId: role.id,
        unmatchedResultDeadlineHours: 12,
      }).expect(200);
      expect(saved.body).toMatchObject({
        criticalNoticeWithinMinutes: 60,
        criticalEscalationRoleId: role.id,
        unmatchedResultOwnerRoleId: role.id,
        unmatchedResultDeadlineHours: 12,
      });
      const cleared = await put(`/sites/${site.id}/parameters`, {
        criticalNoticeWithinMinutes: null,
      }).expect(200);
      expect(cleared.body).toMatchObject({
        criticalNoticeWithinMinutes: null,
        criticalEscalationRoleId: role.id,
      });

      // Un rol que no existe lo rechaza la clave foránea, con su campo.
      const response = await put(`/sites/${site.id}/parameters`, {
        unmatchedResultOwnerRoleId: '00000000-0000-7000-8000-000000000000',
      });
      const problem = response.body as Problem;
      // 422 y no 404: la clave foránea responde sobre un CAMPO del cuerpo.
      expect(response.status).toBe(422);
      expect(problem.code).toBe('ROLE_NOT_FOUND');
      expect(problem.errors?.[0]?.field).toBe('unmatchedResultOwnerRoleId');
      expect(
        (
          await prisma.siteParameter.findUniqueOrThrow({
            where: { siteId: site.id },
          })
        ).unmatchedResultOwnerRoleId,
      ).toBe(role.id);

      // Y un rol que no puede trabajar la cola se rechaza con su campo.
      const unable = await put(`/sites/${site.id}/parameters`, {
        criticalEscalationRoleId: cashier.id,
      }).expect(422);
      expect((unable.body as Problem).code).toBe('ROLE_CANNOT_WORK_RESULTS');
      expect((unable.body as Problem).errors?.[0]?.field).toBe(
        'criticalEscalationRoleId',
      );
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

    it('AG-096 rechaza el guardado por CAMPO, en vez de dejar el valor inválido para descubrirlo al reservar', async () => {
      /**
       * LA MITAD DE AG-096 QUE SIRVE DE ALGO ES «NO DEBERÁ ACEPTAR UN VALOR
       * INVÁLIDO PARA DESCUBRIRLO AL RESERVAR».
       *
       * Es el mismo comportamiento que CF-065 garantiza desde el lado de
       * `configuration`, y por eso esto no reimplementa nada: lo que añade es
       * la afirmación que la agenda necesita —que un parámetro imposible NO
       * llega a la tabla que ella lee—, y la trazabilidad de que alguien la
       * comprobó. Sin ella, la ventana de reserva de AG-031 a AG-033 podría
       * estar calculándose con una antelación negativa cargada meses antes.
       *
       * SE ENVÍAN DOS CAMPOS MALOS A LA VEZ, que es lo que distingue «un error
       * por campo» de «el primero que falle»: arreglar de uno en uno a través
       * de cuatro viajes es como una pantalla de configuración se abandona a
       * medio configurar.
       */
      const site = await createSite();

      const response = await put(`/sites/${site.id}/parameters`, {
        minLeadMinutes: -1,
        overbookingCap: 99,
      }).expect(422);

      const problem = response.body as Problem;
      expect(problem.code).toBe('PARAM_OUT_OF_RANGE');
      expect(problem.errors?.map((error) => error.field).sort()).toEqual([
        'minLeadMinutes',
        'overbookingCap',
      ]);

      // Y NADA SE GUARDÓ: el rechazo es del guardado entero, no de los campos
      // que fallaron. Un guardado parcial dejaría la sede con una mitad de la
      // configuración que nadie eligió.
      const stored = await get(`/sites/${site.id}/parameters`).expect(200);
      expect(stored.body).toMatchObject({
        minLeadMinutes: 0,
        overbookingCap: 2,
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

    /**
     * D-021. El turno de la agenda, y las DOS puertas de la garantía.
     *
     * Hacer múltiplos a las duraciones cierra la puerta por la que entran las
     * duraciones (SP-021, SP-022); ésta cierra la otra. Sin ella, una clínica
     * con tipos de 10, 20 y 30 podría mover una sede a turnos de 20 y dejar
     * cada tipo de 30 sin poder reservarse allí — la misma incoherencia,
     * entrando por configuración.
     */
    describe('D-021 · el turno de la agenda', () => {
      it('CF-062 la sede nace con el turno de diez minutos y se puede cambiar', async () => {
        const site = await createSite();

        const response = await put(`/sites/${site.id}/parameters`, {
          slotAtomMinutes: 15,
        }).expect(200);

        expect(response.body).toMatchObject({ slotAtomMinutes: 15 });
      });

      it('CF-065 rechaza un turno fuera de la banda nombrando el rango', async () => {
        const site = await createSite();

        const response = await put(`/sites/${site.id}/parameters`, {
          slotAtomMinutes: 90,
        }).expect(422);

        const problem = response.body as Problem;
        expect(problem.code).toBe('PARAM_OUT_OF_RANGE');
        expect(problem.errors?.[0]?.field).toBe('slotAtomMinutes');
        expect(problem.errors?.[0]?.message).toContain('5 a 60');
      });

      it('CF-065 la base también rechaza un turno fuera de la banda o fuera del paso de cinco', async () => {
        const site = await createSite();

        for (const minutes of [0, 7, 90]) {
          await expect(
            prisma.$executeRawUnsafe(
              `UPDATE site_parameter SET slot_atom_minutes = ${minutes} WHERE site_id = $1::uuid`,
              site.id,
            ),
          ).rejects.toThrow(/site_parameter_slot_atom_minutes_range/);
        }
      });

      it('D-021 rechaza un turno que dejaría sin reservar una duración ya configurada', async () => {
        const site = await createSite();
        const specialty = await prisma.specialty.create({
          data: { code: 'cardiologia', name: 'Cardiología' },
        });
        await prisma.serviceType.createMany({
          data: [
            { specialtyId: specialty.id, name: 'Control', durationMinutes: 20 },
            { specialtyId: specialty.id, name: 'Primera vez', durationMinutes: 30 }, // prettier-ignore
          ],
        });

        const response = await put(`/sites/${site.id}/parameters`, {
          slotAtomMinutes: 20,
        }).expect(422);

        const problem = response.body as Problem;
        expect(problem.code).toBe('PARAM_OUT_OF_RANGE');
        expect(problem.errors?.[0]?.field).toBe('slotAtomMinutes');
        // NOMBRA LAS QUE ESTORBAN: «no puede ser 20» deja a quien administra
        // adivinando cuál de cuarenta tipos de atención se lo impide.
        expect(problem.errors?.[0]?.message).toContain('30');

        // Y no escribió: la fila conserva el turno anterior.
        await expect(
          prisma.siteParameter.findUniqueOrThrow({
            where: { siteId: site.id },
            select: { slotAtomMinutes: true },
          }),
        ).resolves.toEqual({ slotAtomMinutes: 10 });
      });

      it('D-021 la excepción de un médico cuenta igual que la duración base', async () => {
        // Es el peldaño que gana en SP-023: mirar sólo `service_type` dejaría
        // la mitad de las duraciones fuera de la comprobación.
        const site = await createSite();
        const practitioner = await createPractitioner(prisma);
        const specialty = await prisma.specialty.create({
          data: { code: 'cardiologia', name: 'Cardiología' },
        });
        const type = await prisma.serviceType.create({
          data: { specialtyId: specialty.id, name: 'Control', durationMinutes: 20 }, // prettier-ignore
        });
        await prisma.durationException.create({
          data: {
            practitionerId: practitioner.id,
            serviceTypeId: type.id,
            durationMinutes: 30,
          },
        });

        // 20 divide a la duración base y no a la excepción.
        await put(`/sites/${site.id}/parameters`, {
          slotAtomMinutes: 20,
        }).expect(422);
      });

      it('D-021 acepta un turno del que toda duración configurada es múltiplo', async () => {
        const site = await createSite();
        const specialty = await prisma.specialty.create({
          data: { code: 'cardiologia', name: 'Cardiología' },
        });
        await prisma.serviceType.create({
          data: { specialtyId: specialty.id, name: 'Control', durationMinutes: 30 }, // prettier-ignore
        });

        await put(`/sites/${site.id}/parameters`, {
          slotAtomMinutes: 15,
        }).expect(200);
      });
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

    it('AG-097 · CF-066 la bitácora dice desde qué valor cambió el parámetro', async () => {
      // D-017, y es la mitad que sirve: «quién subió el tope de sobrecupos y
      // cuándo» no explica por qué una cita se aceptó en marzo y una idéntica
      // se rechazó en abril. «Desde qué» sí.
      const site = await createSite();
      await put(`/sites/${site.id}/parameters`, {
        maxLeadDays: 60,
        overbookingCap: 4,
      }).expect(200);

      const [row] = await prisma.accessAudit.findMany({
        where: { resourceType: 'configuration' },
        select: { before: true, after: true },
      });

      const defaults = {
        siteId: site.id,
        minLeadMinutes: 0,
        maxLeadDays: 180,
        overbookingCap: 2,
        slotAtomMinutes: 10,
        allowPastBooking: false,
        overbookingEnabled: true,
        overbookingPermission: 'agenda:overbook',
        waitlistMaxContactAttempts: 3,
        cancelledRetention: 'NEVER',
        criticalNoticeWithinMinutes: 60,
        criticalEscalationRoleId: null,
        unmatchedResultOwnerRoleId: null,
        unmatchedResultDeadlineHours: 24,
      };

      expect(row?.before).toEqual(defaults);
      expect(row?.after).toEqual({
        ...defaults,
        maxLeadDays: 60,
        overbookingCap: 4,
      });
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

      // Se envían a la vez los DOS parámetros legítimos que un lector podría
      // confundir con interruptores —el tope de sobrecupos y la reserva en el
      // pasado— y tres que sí apagarían una garantía. Sólo los primeros
      // sobreviven.
      await put(`/sites/${site.id}/parameters`, {
        overbookingCap: 3,
        allowPastBooking: true,
        allowOverlap: true,
        historyImmutable: false,
        closedByDefault: false,
      }).expect(200);

      const stored = await prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: site.id },
      });

      // Lo enviado de más se descartó; lo legítimo se guardó.
      expect(stored.overbookingCap).toBe(3);
      expect(stored.allowPastBooking).toBe(true);
      expect(Object.keys(stored)).toEqual([
        'siteId',
        'minLeadMinutes',
        'maxLeadDays',
        'overbookingCap',
        'slotAtomMinutes',
        'allowPastBooking',
        // E4 (AG-039, AG-101). Los dos del sobrecupo pasan la misma prueba:
        // elegir QUIÉN autoriza una excepción no configura la excepción.
        'overbookingEnabled',
        'overbookingPermission',
        // E5 (AG-066, AG-094). Cuántas llamadas sin respuesta agotan una
        // entrada de lista de espera. Pasa la misma prueba que las anteriores:
        // no apaga ninguna garantía —el orden de la cola lo sigue decidiendo la
        // prioridad derivada y la antigüedad, y el rastro de intentos es
        // append-only pase lo que pase con este número—, sólo dice cuándo la
        // clínica deja de llamar. Todavía NO se expone en la pantalla de
        // parámetros: la columna entra con la migración de E5 y el DTO, con el
        // servicio.
        'waitlistMaxContactAttempts',
        // 20-08-2026, el flujo de atención. Las cuatro pasan la misma prueba
        // que las anteriores —ninguna apaga el solapamiento, la inmutabilidad
        // del historial ni el cierre por defecto—; la justificación larga de
        // cada una está en la prueba de columnas de abajo.
        //
        // Y una que NO está aquí y es deliberado: la calificación de emergencia
        // del art. 10 de la Ley 77 no es configurable. Vive en `agenda_entry`,
        // se hace en toda llegada, y no depende de que el triaje esté
        // encendido. Un parámetro que la apagara sería exactamente el
        // interruptor que este requisito prohíbe.
        'triageEnabled',
        'requireCertifiedSignature',
        'recordRetentionYears',
        'lateArrivalGraceMinutes',
        'lateArrivalOverridePermission',
        'cancelledRetention',
        // ORD-046, ORD-063, ORD-065 (01-10-2026). La política de las colas de
        // resultados; la justificación, en la prueba de columnas de abajo.
        'criticalNoticeWithinMinutes',
        'criticalEscalationRoleId',
        'unmatchedResultOwnerRoleId',
        'unmatchedResultDeadlineHours',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('CF-063 la tabla de parámetros no tiene ninguna columna que apague una garantía', async () => {
      // La prueba se hace contra `information_schema` y no contra el modelo de
      // Prisma: la columna la crearía una migración, y una migración puede
      // añadir lo que `schema.prisma` no menciona.
      //
      // POR QUÉ `allow_past_booking` SÍ ES UN PARÁMETRO LEGÍTIMO, y no de los
      // que este requisito veda. CF-063 prohíbe exponer como configuración
      // aquello **cuya garantía se perdería al configurarlo**, y enumera las
      // tres: no-solapamiento, inmutabilidad del historial y cierre por
      // defecto. Admitir una cita con inicio anterior a ahora no toca ninguna:
      //
      //   * los tres `EXCLUDE USING gist` siguen arbitrando el solape — una
      //     cita en el pasado que pise a otra se rechaza igual, y la prueba de
      //     abajo lo comprueba contra la base;
      //   * `agenda_status_history` se sigue escribiendo dentro de la misma
      //     transición y ninguna operación del módulo la actualiza ni la borra
      //     (AG-005): el interruptor no la roza;
      //   * la ruta de reserva sigue exigiendo `agenda:write` y alcance sobre
      //     la sede (AG-071); no hay nada que «abrir» en ese eje.
      //
      // Lo que cambia es QUÉ HORA se admite, que es exactamente la clase de
      // decisión que REQ-145 quiere en configuración y no quemada en el
      // código: AG-094 lo enumera junto a la antelación mínima y máxima como
      // parámetro de sede, y el defecto de la migración es `false` — cerrado
      // hasta que la sede decida lo contrario, no abierto de fábrica.
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'site_parameter'
         ORDER BY column_name
      `;

      expect(columns.map((column) => column.column_name)).toEqual([
        'allow_past_booking',
        'cancelled_retention',
        'created_at',
        // ORD-063, ORD-065 (D-050 §2, D-111). Un PLAZO y un rol al que escalar,
        // no un interruptor: el valor crítico sigue en su cola hasta que hay
        // constancia del aviso, y la constancia es inmutable por disparador.
        // Vacíos de fábrica: la cola dice «sin plazo» en vez de inventarlo.
        'critical_escalation_role_id',
        'critical_notice_within_minutes',
        // 20-08-2026. Las cuatro columnas del flujo de atención, y por qué
        // ninguna apaga una de las tres garantías que CF-063 nombra
        // —no-solapamiento, inmutabilidad del historial, cierre por defecto—:
        //
        //   * `late_arrival_grace_minutes` es un UMBRAL, no un interruptor. La
        //     llegada tardía no es un estado: es la diferencia entre la hora de
        //     la cita y el check-in, y esto solo dice a partir de cuándo la
        //     clínica la considera tarde.
        //   * `record_retention_years` no relaja nada: la LOPDP art. 10.i
        //     OBLIGA a fijar un plazo y el art. 51 a declararlo. No fijarlo era
        //     el incumplimiento; el defecto es 15 años y nada se purga solo.
        //   * `require_certified_signature` viene ENCENDIDA. Apagarla no toca
        //     ninguna de las tres: la nota se sigue firmando, sigue siendo
        //     inmutable una vez firmada, y la ruta sigue exigiendo permiso. Lo
        //     que cambia es la FUERZA de la atribución, y la propia norma de
        //     farmacias privadas (ARCSA-DE-2022-012-AKRG, Disp. Gral. Décima)
        //     acepta para la receta electrónica «la signatura realizada en el
        //     sistema informático mediante el registro con usuario y clave».
        //     Apagada queda constancia explícita de que la firma no lleva
        //     certificado: no se disimula.
        //   * `triage_enabled` ENCIENDE una capacidad y viene apagada: ninguna
        //     norma exige triaje a un establecimiento ambulatorio (A.M.
        //     00030-2020 art. 27 no lo incluye en la cartera del centro de
        //     especialidades). Lo que NO es opcional, y por eso no está aquí,
        //     es la calificación de emergencia del art. 10 de la Ley 77: esa
        //     vive en `agenda_entry` y se hace siempre.
        'late_arrival_grace_minutes',
        // AG-120. Hermana de `overbooking_permission`, y pasa su misma prueba:
        // elegir QUIÉN autoriza una excepción no configura la excepción. Por
        // defecto apunta al mismo permiso del sobrecupo, porque dejar pasar a
        // alguien fuera de plazo ES romper la rejilla.
        'late_arrival_override_permission',
        'max_lead_days',
        'min_lead_minutes',
        'overbooking_cap',
        // E4, AG-039 y AG-101. `overbooking_enabled` no apaga ninguna
        // garantía: el `EXCLUDE` sigue en pie —el sobrecupo está exento de él
        // por el mismo predicado `blocks_calendar` de siempre— y la constancia
        // de cada excepción es un `CHECK`. `overbooking_permission` elige
        // QUIÉN autoriza, que es política de la clínica (D-002), y no puede
        // nombrar un permiso inventado: el catálogo del código lo rechaza con
        // `UNKNOWN_PERMISSION` y `trg_site_parameter_overbooking_permission`
        // lo rechaza en la base.
        'overbooking_enabled',
        'overbooking_permission',
        'record_retention_years',
        'require_certified_signature',
        'site_id',
        // D-021. Es un parámetro legítimo por la misma razón que
        // `allow_past_booking`, y con más motivo: configurarlo no pierde
        // ninguna garantía — es lo que hace que AG-012 y AG-104 no puedan
        // fallar por configuración, porque toda duración se guarda como
        // múltiplo suyo.
        'slot_atom_minutes',
        'triage_enabled',
        // ORD-046 (D-050 §4). Quién responde de los resultados sin orden y en
        // cuántas horas. Tampoco apaga nada: el resultado no sale de la cola
        // hasta que una persona lo empareja (ORD-041, ORD-043).
        'unmatched_result_deadline_hours',
        'unmatched_result_owner_role_id',
        'updated_at',
        // E5 (AG-066, AG-094). El octavo y último parámetro que AG-094 enumera
        // —«el número máximo de intentos de contacto de la lista de espera»— y
        // el único que nunca tuvo columna, porque E5 no se había abierto.
        // `site_parameter_waitlist_max_contact_attempts_range` lo mantiene
        // entre 1 y 10: en 0 la entrada caducaría antes de la primera llamada.
        'waitlist_max_contact_attempts',
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

    it('AG-092 rechaza a quien no tiene settings:manage al marcar una sede como laborable', async () => {
      // Es una mutación de la configuración de la clínica, no de la agenda:
      // el permiso es el mismo que crear el feriado, y recepción no lo tiene.
      const site = await createSite();
      const created = await post('/holidays', { date: '2026-12-25', name: 'Navidad' }).expect(201); // prettier-ignore
      const { id } = created.body as HolidayBody;
      const receptionToken = await signIn(RECEPCION_EMAIL, 'RECEPCION', RECEPCION_CEDULA); // prettier-ignore

      const response = await put(
        `/holidays/${id}/worked-by/${site.id}`,
        {},
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
