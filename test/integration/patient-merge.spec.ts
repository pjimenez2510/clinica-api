import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Patient, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { PASSWORD_HASHING } from '../../src/modules/auth/domain/password-hashing';
import { RolePermissionRegistry } from '../../src/modules/auth/infrastructure/role-permission.registry';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { enableBigIntSerialisation } from '../../src/shared/bigint-json';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import {
  chartScope,
  chartScopeIds,
} from '../../src/shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  hourSlot,
  linkPractitionerToSite,
  createUser,
} from './setup/fixtures';
import { closeApp, listenForTests } from './setup/http-server';

/**
 * P4 de `patients`: fusión de duplicados con rastro reversible.
 *
 * DOS SUITES EN UN FICHERO, Y LAS DOS HACEN FALTA:
 *
 *  1. LO QUE GARANTIZA LA BASE. Casi todo lo que el `SPEC.md` promete de esta
 *     entrega es una garantía de ALMACENAMIENTO: el rastro append-only
 *     (PA-044), la imposibilidad de fusionar una ficha consigo misma o de
 *     encadenar fusiones (PA-046), y que deshacer sea posible y deje otro
 *     rastro igual (PA-047, PA-048). Un doble rechaza lo que le programemos
 *     para rechazar; lo que se comprueba ahí es que el rechazo sobreviva a la
 *     aplicación entera — un `UPDATE` tecleado en `psql`, una importación, un
 *     ORM que no ha leído la spec.
 *  2. EL CONTRATO Y SU PERMISO. Las dos rutas, `patient:merge` (PA-052), los
 *     cinco códigos que P4 estrena, y las dos cosas que ninguna prueba de
 *     esquema puede ver: que la ficha absorbida rechace TODA operación que la
 *     nombre (PA-045) y que la transacción del servicio no deje nada a medias
 *     cuando el documento ya está reclamado (PA-048).
 *
 * LAS CÉDULAS LLEVAN DÍGITO VERIFICADOR CALCULADO. `is_valid_cedula()` rechaza
 * las inventadas, así que un número cualquiera fallaría por el motivo
 * equivocado y mandaría a alguien a perseguir un defecto que no existe.
 */
const CEDULA = '1710034065';
const OTRA_CEDULA = '1713175071';

/** Lo que se teclea en el formulario, y lo que queda en el rastro (PA-044). */
const REASON = 'la misma persona registrada dos veces en admisión';
const HTTP_PASSWORD = 'el caballo come alfalfa';

interface Problem {
  title: string;
  status: number;
  code: string;
  errors?: { field: string; code: string; message: string }[];
}

/** La respuesta de las dos rutas, que es la misma: un suceso del registro. */
interface MergeBody {
  mergeId: string;
  /** PA-062. El aviso de reposos solapados con una maternidad, o `null`. */
  restOverlapNotice: string | null;
  event: 'MERGE' | 'UNDO';
  sourcePatientId: string;
  sourceMrn: string;
  targetPatientId: string;
  targetMrn: string;
  performedAt: string;
  linkedRecords: {
    policy: string;
    appointments: number;
    encounters: number;
    documents: number;
    allergies: number;
    contacts: number;
    priorityGroups: number;
    waitlistEntries: number;
  };
}

/**
 * PA-054. La ficha vigente, de la que aquí sólo importan dos campos: a dónde
 * se movió ésta, y qué fichas absorbió — el mismo enlace en los dos sentidos.
 */
interface PatientChartBody {
  mrn: string;
  mergedIntoMrn: string | null;
  absorbedCharts: { total: number; mrns: string[] };
  /** PA-041, PA-055. 1 = prioritaria, 2 = estándar. */
  priority: number;
}

/** PA-040. El motivo, que es lo que PA-055 tiene que hacer visible desde B. */
interface PriorityGroupListBody {
  asOf: string;
  items: { id: string; group: string; inForce: boolean }[];
}

describe('fusión de duplicados: lo que garantiza la base', () => {
  const db = useDatabase();

  /** El autor de la fusión. PA-044 lo exige y la columna ya no admite NULL. */
  async function createAuthor(prisma: PrismaClient, suffix: string) {
    return prisma.user.create({
      data: {
        email: `admision${suffix}@clinica.ec`,
        passwordHash: 'not-a-real-hash',
        firstName: 'Ana',
        lastName: 'Villacís',
      },
    });
  }

  async function giveIdentifier(
    prisma: PrismaClient,
    patientId: string,
    value: string,
  ) {
    return prisma.patientIdentifier.create({
      data: { patientId, type: 'CEDULA', value },
    });
  }

  /** Marca la ficha como fusionada. Es lo que hará el servicio de la tanda siguiente. */
  async function linkAsMerged(
    prisma: PrismaClient,
    source: Patient,
    target: Patient,
  ) {
    return prisma.patient.update({
      where: { id: source.id },
      data: { mergedIntoId: target.id, mergedAt: new Date() },
    });
  }

  /** Deshacer, en el sentido de la ficha: vuelve a ser una ficha entera. */
  async function unlinkMerged(prisma: PrismaClient, source: Patient) {
    return prisma.patient.update({
      where: { id: source.id },
      data: { mergedIntoId: null, mergedAt: null },
    });
  }

  async function recordMerge(
    prisma: PrismaClient,
    source: Patient,
    target: Patient,
    authorId: string,
  ) {
    return prisma.patientMerge.create({
      data: {
        event: 'MERGE',
        sourcePatientId: source.id,
        targetPatientId: target.id,
        performedBy: authorId,
        reason: 'la misma persona registrada dos veces en admisión',
        sourceSnapshot: { mrn: source.mrn, familyName: source.familyName },
      },
    });
  }

  // =========================================================================
  // PA-043 · la absorbida no se borra
  // =========================================================================

  it('PA-043 conserva la ficha absorbida con su MRN, apuntando a la superviviente', async () => {
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await linkAsMerged(prisma, source, target);

    const kept = await prisma.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    // Documentos ya impresos y sistemas externos siguen citando este número.
    expect(kept.mrn).toBe(source.mrn);
    expect(kept.mergedIntoId).toBe(target.id);
    expect(kept.mergedAt).not.toBeNull();
  });

  it('PA-043 RECHAZA una ficha fusionada sin instante de fusión, y al revés', async () => {
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    // Un deshacer que limpiara sólo el enlace dejaría la ficha comportándose
    // como entera y arrastrando la fecha de una fusión que ya no existe.
    await expect(
      prisma.patient.update({
        where: { id: source.id },
        data: { mergedIntoId: target.id },
      }),
    ).rejects.toThrow(/patient_merged_at_matches_link/);
  });

  // =========================================================================
  // PA-044 · el rastro es append-only DE VERDAD
  // =========================================================================

  it('PA-044 acepta la fila de la fusión con autor, motivo e instantánea', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '001');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    const merge = await recordMerge(prisma, source, target, author.id);

    expect(merge.event).toBe('MERGE');
    expect(merge.performedBy).toBe(author.id);
    expect(merge.sourceSnapshot).not.toBeNull();
    expect(merge.undoesMergeId).toBeNull();
  });

  it('PA-044 RECHAZA modificar la fila de una fusión', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '002');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    const merge = await recordMerge(prisma, source, target, author.id);

    // La que importa: reescribir el motivo reescribe la respuesta a «¿por qué
    // se unieron los expedientes de estas dos personas?».
    await expect(
      prisma.patientMerge.update({
        where: { id: merge.id },
        data: { reason: 'otra cosa distinta' },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('PA-044 RECHAZA borrar la fila de una fusión', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '003');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    const merge = await recordMerge(prisma, source, target, author.id);

    await expect(
      prisma.patientMerge.delete({ where: { id: merge.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('PA-044 RECHAZA vaciar la tabla del rastro de fusiones', async () => {
    // TRUNCATE no dispara los de fila: sin disparador propio, el rastro de
    // todas las fusiones de la clínica se va en una sentencia.
    const prisma = db();
    const author = await createAuthor(prisma, '004');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    await recordMerge(prisma, source, target, author.id);

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE patient_merge'),
    ).rejects.toThrow(/append-only/);
  });

  it('PA-044 RECHAZA una fusión sin autor', async () => {
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    // Por SQL crudo: el cliente tipado ya no deja omitir la columna, y lo que
    // se juzga es la base, que es la que ve las importaciones.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_merge (event, source_patient_id, target_patient_id, reason, source_snapshot)
         VALUES ('MERGE', $1::uuid, $2::uuid, 'porque sí', '{}'::jsonb)`,
        source.id,
        target.id,
      ),
    ).rejects.toThrow(/performed_by/);
  });

  it('PA-044 RECHAZA una fusión cuyo autor no es una cuenta del sistema', async () => {
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_merge (event, source_patient_id, target_patient_id, performed_by, reason, source_snapshot)
         VALUES ('MERGE', $1::uuid, $2::uuid, gen_random_uuid(), 'porque sí', '{}'::jsonb)`,
        source.id,
        target.id,
      ),
    ).rejects.toThrow(/patient_merge_performed_by_fkey/);
  });

  it('PA-044 RECHAZA una fusión con el motivo en blanco', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '005');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    // `NOT NULL` impide la ausencia, no la cadena vacía: `'   '` la satisface
    // y no explica nada.
    await expect(
      prisma.patientMerge.create({
        data: {
          event: 'MERGE',
          sourcePatientId: source.id,
          targetPatientId: target.id,
          performedBy: author.id,
          reason: '   ',
          sourceSnapshot: {},
        },
      }),
    ).rejects.toThrow(/patient_merge_reason_not_blank/);
  });

  it('PA-044 RECHAZA una fusión sin instantánea de la ficha absorbida', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '006');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    // Sin instantánea no se puede explicar la operación ni deshacerla.
    await expect(
      prisma.patientMerge.create({
        data: {
          event: 'MERGE',
          sourcePatientId: source.id,
          targetPatientId: target.id,
          performedBy: author.id,
          reason: 'sin instantánea',
        },
      }),
    ).rejects.toThrow(/patient_merge_snapshot_matches_event/);
  });

  // =========================================================================
  // PA-046 · ni consigo misma, ni encadenada
  // =========================================================================

  it('PA-046 RECHAZA fusionar una ficha consigo misma', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);

    // Una ficha fusionada consigo misma rechaza toda operación (PA-045) y
    // remite a sí misma: nadie puede abrirla ni deshacerla.
    await expect(
      prisma.patient.update({
        where: { id: patient.id },
        data: { mergedIntoId: patient.id, mergedAt: new Date() },
      }),
    ).rejects.toThrow(/patient_merged_into_not_self/);
  });

  it('PA-046 RECHAZA un rastro que dice que una ficha se fusionó consigo misma', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '007');
    const patient = await createPatient(prisma);

    await expect(
      prisma.patientMerge.create({
        data: {
          event: 'MERGE',
          sourcePatientId: patient.id,
          targetPatientId: patient.id,
          performedBy: author.id,
          reason: 'no debería poder existir',
          sourceSnapshot: {},
        },
      }),
    ).rejects.toThrow(/patient_merge_not_self/);
  });

  it('PA-046 RECHAZA fusionar hacia una ficha que ya está fusionada', async () => {
    const prisma = db();
    const a = await createPatient(prisma);
    const b = await createPatient(prisma);
    const c = await createPatient(prisma);

    await linkAsMerged(prisma, b, c); // B → C

    // A → B daría A→B→C, y el primer lector que no recorra la cadena entera
    // enseñará la ficha equivocada.
    await expect(linkAsMerged(prisma, a, b)).rejects.toThrow(
      /is itself merged into/,
    );
  });

  it('PA-046 RECHAZA fusionar una ficha que ya absorbió a otras', async () => {
    const prisma = db();
    const a = await createPatient(prisma);
    const b = await createPatient(prisma);
    const c = await createPatient(prisma);

    await linkAsMerged(prisma, a, b); // A → B

    // B → C es la misma cadena por el otro extremo.
    await expect(linkAsMerged(prisma, b, c)).rejects.toThrow(
      /already absorbed other charts/,
    );
  });

  it('PA-046 RECHAZA mover una ficha ya fusionada a otro destino sin deshacer antes', async () => {
    const prisma = db();
    const a = await createPatient(prisma);
    const b = await createPatient(prisma);
    const c = await createPatient(prisma);

    await linkAsMerged(prisma, a, b);

    // No es una cadena: es una reescritura silenciosa. El rastro de la primera
    // fusión quedaría apuntando a donde la ficha ya no está.
    await expect(linkAsMerged(prisma, a, c)).rejects.toThrow(
      /is already merged into/,
    );
  });

  it('PA-046 con dos fusiones simultáneas que formarían cadena, gana la primera y la segunda se rechaza', async () => {
    const prisma = db();
    const a = await createPatient(prisma);
    const b = await createPatient(prisma);
    const c = await createPatient(prisma);

    // SIN EL `FOR UPDATE` DEL DISPARADOR, las dos leen que no hay cadena, las
    // dos aciertan, y A→B→C aparece al confirmar sin que ningún constraint la
    // haya visto nunca. Esta prueba es la que dice que el bloqueo está puesto:
    // afirma QUIÉN GANA, no que «al menos una falle».
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = prisma.$transaction(
      async (tx) => {
        await tx.patient.update({
          where: { id: a.id },
          data: { mergedIntoId: b.id, mergedAt: new Date() },
        });
        await held; // mantiene el bloqueo sobre B
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = prisma.$transaction(
      async (tx) => {
        await tx.patient.update({
          where: { id: b.id },
          data: { mergedIntoId: c.id, mergedAt: new Date() },
        });
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    const secondSettled = second.then(
      () => 'ok' as const,
      (error: Error) => error,
    );

    // Tiempo suficiente para que la segunda llegue al UPDATE y se quede
    // esperando el bloqueo, y no para que termine.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();

    await first;
    const outcome = await secondSettled;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/already absorbed other charts/);

    const survivors = await prisma.patient.findMany({
      where: { id: { in: [a.id, b.id, c.id] } },
      select: { id: true, mergedIntoId: true },
      orderBy: { mrn: 'asc' },
    });
    expect(survivors).toEqual([
      { id: a.id, mergedIntoId: b.id },
      { id: b.id, mergedIntoId: null },
      { id: c.id, mergedIntoId: null },
    ]);
  });

  // =========================================================================
  // PA-047 · deshacer es una fila nueva
  // =========================================================================

  it('PA-047 deshacer devuelve el documento a la ficha absorbida cuando nadie lo reclamó', async () => {
    // ESTE ES EL «DEFECTO CONFIRMADO DEL 6-08-2026», Y NO LO ES. PA-047 dice
    // que deshacer es hoy imposible porque `trg_patient_sync_merged` vuelve a
    // poner `patient_merged = false` y choca con
    // `patient_identifier_active_unique`. En el caso normal NO CHOCA: el índice
    // impedía desde el principio que dos fichas activas compartieran el
    // documento, así que no hay con qué chocar.
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    await giveIdentifier(prisma, source.id, CEDULA);

    await linkAsMerged(prisma, source, target);

    // La fusión LIBERA el documento: mientras la ficha está fusionada, su
    // cédula sale del índice único parcial y otra ficha podría tomarla.
    const whileMerged = await prisma.patientIdentifier.findFirstOrThrow({
      where: { patientId: source.id },
    });
    expect(whileMerged.patientMerged).toBe(true);

    await unlinkMerged(prisma, source);

    const afterUndo = await prisma.patientIdentifier.findFirstOrThrow({
      where: { patientId: source.id },
    });
    expect(afterUndo.patientMerged).toBe(false);
    expect(afterUndo.value).toBe(CEDULA);
  });

  it('PA-047 deja del deshacer el mismo rastro que de la fusión, en una fila nueva', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '008');
    const undoer = await createAuthor(prisma, '009');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await linkAsMerged(prisma, source, target);
    const merge = await recordMerge(prisma, source, target, author.id);
    await unlinkMerged(prisma, source);

    const undo = await prisma.patientMerge.create({
      data: {
        event: 'UNDO',
        undoesMergeId: merge.id,
        sourcePatientId: source.id,
        targetPatientId: target.id,
        performedBy: undoer.id,
        reason: 'eran dos personas distintas con el mismo apellido',
      },
    });

    expect(undo.undoesMergeId).toBe(merge.id);
    expect(undo.performedBy).toBe(undoer.id);
    // Quién, cuándo y por qué — las mismas tres que la fusión, y propias.
    expect(undo.performedAt).toBeInstanceOf(Date);
    expect(undo.reason).not.toHaveLength(0);
    // La fila de la fusión sigue intacta: deshacer no la tocó.
    const original = await prisma.patientMerge.findUniqueOrThrow({
      where: { id: merge.id },
    });
    expect(original.reason).toBe(merge.reason);
  });

  it('PA-047 responde si una fusión está deshecha por el enlace, y no adivinando por fechas', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '010');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    // La MISMA pareja fusionada, deshecha y vuelta a fusionar. Sin el enlace,
    // buscar «un UNDO posterior para esta pareja» deja la respuesta ambigua
    // para siempre a partir de aquí.
    await linkAsMerged(prisma, source, target);
    const first = await recordMerge(prisma, source, target, author.id);
    await unlinkMerged(prisma, source);
    await prisma.patientMerge.create({
      data: {
        event: 'UNDO',
        undoesMergeId: first.id,
        sourcePatientId: source.id,
        targetPatientId: target.id,
        performedBy: author.id,
        reason: 'deshecha por error de admisión',
      },
    });
    await linkAsMerged(prisma, source, target);
    const second = await recordMerge(prisma, source, target, author.id);

    const undone = await prisma.patientMerge.findMany({
      where: { event: 'UNDO', undoesMergeId: { in: [first.id, second.id] } },
      select: { undoesMergeId: true },
    });
    expect(undone).toEqual([{ undoesMergeId: first.id }]);
  });

  it('PA-047 RECHAZA deshacer dos veces la misma fusión', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '011');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await linkAsMerged(prisma, source, target);
    const merge = await recordMerge(prisma, source, target, author.id);
    await unlinkMerged(prisma, source);

    await prisma.patientMerge.create({
      data: {
        event: 'UNDO',
        undoesMergeId: merge.id,
        sourcePatientId: source.id,
        targetPatientId: target.id,
        performedBy: author.id,
        reason: 'eran dos personas distintas',
      },
    });

    // Dos filas de deshacer sobre la misma fusión describen un estado
    // imposible. Bajo concurrencia son dos peticiones que leen las dos
    // «todavía fusionada»: sólo el índice único arbitra.
    //
    // POR SQL CRUDO y no por el cliente: lo que se juzga es el constraint, y
    // su NOMBRE es contrato —viaja al cliente por el mapeo de errores—. Prisma
    // lo traduce a «Unique constraint failed on the fields», que pasaría igual
    // si el índice se llamara de cualquier otra forma.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_merge (event, undoes_merge_id, source_patient_id, target_patient_id, performed_by, reason)
         VALUES ('UNDO', $1::bigint, $2::uuid, $3::uuid, $4::uuid, 'otra vez')`,
        merge.id.toString(),
        source.id,
        target.id,
        author.id,
      ),
    ).rejects.toThrow(/patient_merge_undone_once/);
  });

  it('PA-047 RECHAZA una fila de deshacer que no nombra la fusión que deshace', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '012');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await expect(
      prisma.patientMerge.create({
        data: {
          event: 'UNDO',
          sourcePatientId: source.id,
          targetPatientId: target.id,
          performedBy: author.id,
          reason: 'un deshacer huérfano',
        },
      }),
    ).rejects.toThrow(/patient_merge_undo_links_merge/);
  });

  it('PA-047 RECHAZA una fila de deshacer que nombra otra pareja de fichas', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '013');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    const otra = await createPatient(prisma);

    await linkAsMerged(prisma, source, target);
    const merge = await recordMerge(prisma, source, target, author.id);

    // Pasaría todos los CHECK y dejaría el rastro diciendo que se deshizo algo
    // que nunca se fusionó. Ningún CHECK puede verlo: depende de otra fila.
    await expect(
      prisma.patientMerge.create({
        data: {
          event: 'UNDO',
          undoesMergeId: merge.id,
          sourcePatientId: otra.id,
          targetPatientId: target.id,
          performedBy: author.id,
          reason: 'la pareja equivocada',
        },
      }),
    ).rejects.toThrow(/names a different pair of charts/);
  });

  it('PA-047 RECHAZA una instantánea en la fila de deshacer', async () => {
    const prisma = db();
    const author = await createAuthor(prisma, '014');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await linkAsMerged(prisma, source, target);
    const merge = await recordMerge(prisma, source, target, author.id);

    await expect(
      prisma.patientMerge.create({
        data: {
          event: 'UNDO',
          undoesMergeId: merge.id,
          sourcePatientId: source.id,
          targetPatientId: target.id,
          performedBy: author.id,
          reason: 'con una instantánea inventada',
          sourceSnapshot: {},
        },
      }),
    ).rejects.toThrow(/patient_merge_snapshot_matches_event/);
  });

  // =========================================================================
  // PA-048 · el documento ya reclamado
  // =========================================================================

  it('PA-048 RECHAZA deshacer cuando otra ficha activa reclamó el documento', async () => {
    // EL OTRO LADO DEL «DEFECTO DEL 6-08-2026», Y ÉSTE SÍ CHOCA — porque debe.
    // Es la consecuencia técnica de PA-014: el índice único parcial no puede
    // admitir dos fichas activas con la misma cédula.
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    const tercera = await createPatient(prisma);
    await giveIdentifier(prisma, source.id, CEDULA);

    await linkAsMerged(prisma, source, target);
    // Posible precisamente porque la fusión liberó el documento.
    await giveIdentifier(prisma, tercera.id, CEDULA);

    // POR SQL CRUDO: el nombre del índice es lo que el mapeo de errores lee
    // para decidir qué se le responde a quien deshace, y es lo que la tanda de
    // código tendrá que traducir a `MERGE_UNDO_CONFLICT` en vez de al
    // `DUPLICATE_IDENTIFIER` que hoy recibe sobre un documento que no tocaba.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient SET merged_into_id = NULL, merged_at = NULL, updated_at = now() WHERE id = $1::uuid`,
        source.id,
      ),
    ).rejects.toThrow(/patient_identifier_active_unique/);
  });

  it('PA-048 no deja la fusión a medio deshacer cuando el documento está reclamado', async () => {
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    const tercera = await createPatient(prisma);
    await giveIdentifier(prisma, source.id, CEDULA);
    await giveIdentifier(prisma, source.id, OTRA_CEDULA);

    await linkAsMerged(prisma, source, target);
    await giveIdentifier(prisma, tercera.id, CEDULA);

    await expect(unlinkMerged(prisma, source)).rejects.toThrow();

    // La ficha sigue fusionada y sus DOS documentos siguen fuera del índice.
    // Una reversión a medias la dejaría ni fusionada ni entera.
    const still = await prisma.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(still.mergedIntoId).toBe(target.id);

    const flags = await prisma.patientIdentifier.findMany({
      where: { patientId: source.id },
      select: { patientMerged: true },
    });
    expect(flags).toEqual([{ patientMerged: true }, { patientMerged: true }]);
  });

  // =========================================================================
  // PA-014 · la bandera desnormalizada, también al insertar
  // =========================================================================

  it('PA-014 marca como fusionado el documento que se añade a una ficha ya fusionada', async () => {
    // `trg_patient_sync_merged` sólo se dispara al cambiar
    // `patient.merged_into_id`. Una fila INSERTADA después de la fusión tomaba
    // el `DEFAULT false` y entraba en el índice único como si la ficha
    // estuviera activa: la fusionada bloqueaba un documento que debía estar
    // libre, y la superviviente no podía registrarlo.
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    await linkAsMerged(prisma, source, target);
    const added = await giveIdentifier(prisma, source.id, CEDULA);

    expect(added.patientMerged).toBe(true);

    // Y la consecuencia que importa: la superviviente puede tomar el documento.
    const survivorDoc = await giveIdentifier(prisma, target.id, CEDULA);
    expect(survivorDoc.patientMerged).toBe(false);
  });

  it('PA-014 mantiene la bandera al MOVER el documento a la ficha superviviente', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL DISPARADOR QUE FALTABA, Y SIN EL CUAL EL P0 NO SE ARREGLA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `trg_patient_sync_merged` mira la FICHA y `trg_patient_identifier_set_
     * merged` miraba sólo el `INSERT`, así que mover la fila de A a B dejaba
     * `patient_merged = true` sobre una fila que ya pertenecía a B, que está
     * ACTIVA. La fila se quedaba fuera del índice único parcial y una TERCERA
     * ficha con esa misma cédula era aceptada — SC-008 dice que ese número es
     * cero, sin excepción.
     *
     * SE PRUEBA CON UN `UPDATE` DESNUDO, sin pasar por el servicio: lo que se
     * juzga es que la garantía viva en la base y sobreviva a una importación o
     * a un `psql`, no que el repositorio se acuerde de mantener la bandera.
     */
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    await giveIdentifier(prisma, source.id, CEDULA);
    await linkAsMerged(prisma, source, target);

    await prisma.$executeRaw`
      UPDATE patient_identifier SET patient_id = ${target.id}::uuid
       WHERE patient_id = ${source.id}::uuid
    `;

    const moved = await prisma.patientIdentifier.findFirstOrThrow({
      where: { value: CEDULA },
    });
    expect(moved.patientId).toBe(target.id);
    // FALSE: pertenece a una ficha entera, así que vuelve al índice único.
    expect(moved.patientMerged).toBe(false);

    // Y el índice lo demuestra: nadie más puede tomar esa cédula.
    await expect(
      giveIdentifier(prisma, (await createPatient(prisma)).id, CEDULA),
    ).rejects.toThrow(/Unique constraint failed/);
  });

  it('PA-014 vuelve a marcar el documento que regresa a una ficha aún fusionada', async () => {
    // El camino de vuelta, que es el del deshacer: los documentos regresan a la
    // absorbida ANTES de que se limpie `merged_into_id`, así que en ese
    // instante la ficha sigue fusionada y la fila tiene que salir del índice.
    // Si el disparador no cubriera esta dirección, la fila reentraría en el
    // índice una operación antes de tiempo.
    const prisma = db();
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);
    await giveIdentifier(prisma, target.id, CEDULA);
    await linkAsMerged(prisma, source, target);

    await prisma.$executeRaw`
      UPDATE patient_identifier SET patient_id = ${source.id}::uuid
       WHERE patient_id = ${target.id}::uuid
    `;

    const returned = await prisma.patientIdentifier.findFirstOrThrow({
      where: { value: CEDULA },
    });
    expect(returned.patientId).toBe(source.id);
    expect(returned.patientMerged).toBe(true);
  });

  it('PA-014 deja activo el documento que se añade a una ficha entera', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);

    const added = await giveIdentifier(prisma, patient.id, CEDULA);

    expect(added.patientMerged).toBe(false);
  });

  it('PA-055 el fragmento crudo y el filtro del ORM resuelven el MISMO alcance', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * DOS FORMAS DE UN SOLO PREDICADO, ATADAS CONTRA POSTGRESQL DE VERDAD
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `chartScope` es para el ORM y `chartScopeIds` para el SQL crudo, porque
     * este proyecto lee de las dos maneras —la búsqueda del registro y los
     * ocho contadores de PA-049 son crudos, y el RDACAA será más—. Dos
     * escrituras de un mismo predicado es exactamente cómo empiezan a
     * discrepar, así que se afirma que dan el MISMO conjunto: antes de
     * fusionar, después, y sobre filas reales.
     *
     * Un doble no puede demostrar esto. `merged_into_id` sólo existe en la
     * base y el `IN` lo resuelve el planificador.
     */
    const prisma = db();
    const author = await createAuthor(prisma, '-alcance');
    const source = await createPatient(prisma);
    const target = await createPatient(prisma);

    const record = await prisma.patientPriorityGroup.create({
      data: {
        patientId: source.id,
        groupCode: 'DISABILITY',
        startsOn: new Date('2026-01-01'),
        origin: 'SELF_DECLARED',
        recordedById: author.id,
      },
    });

    const viaOrm = async (): Promise<string[]> =>
      (
        await prisma.patientPriorityGroup.findMany({
          where: chartScope(target.id),
          select: { id: true },
        })
      ).map((row) => row.id);

    const viaSql = async (): Promise<string[]> =>
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM patient_priority_group
           WHERE patient_id IN ${chartScopeIds(target.id)}
        `
      ).map((row) => row.id);

    expect(await viaOrm()).toEqual([]);
    expect(await viaSql()).toEqual([]);

    await linkAsMerged(prisma, source, target);

    expect(await viaOrm()).toEqual([record.id]);
    expect(await viaSql()).toEqual([record.id]);
  });
});

/**
 * La misma entrega, por la puerta por la que entra la clínica: las dos rutas,
 * su permiso y los códigos de error que P4 estrena.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO NO ES UN FICHERO APARTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo de arriba juzga el ESQUEMA y esto juzga el CONTRATO, y las dos mitades se
 * leen juntas o no se leen: el bloque anterior demuestra que la base rechaza la
 * cadena y el documento reclamado, y éste demuestra que quien está en admisión
 * recibe una frase sobre la que puede actuar en vez de una violación de
 * constraint. Separarlas deja a cada una pareciendo completa.
 *
 * Y hay una cosa que sólo se puede comprobar aquí: que la transacción del
 * servicio NO DEJE NADA A MEDIAS cuando el documento ya está reclamado
 * (PA-048). El bloque de arriba lo comprueba sobre un `UPDATE` suelto; aquí son
 * dos escrituras —la ficha y la fila del rastro— y la pregunta es si las dos se
 * deshacen juntas.
 */
describe('fusión de duplicados: el contrato y su permiso', () => {
  const db = useDatabase();
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let registry: RolePermissionRegistry;
  let merges: PatientMergeService;

  /** Quien puede fusionar: un rol que la instalación creó A PROPÓSITO (D-030). */
  let admision: string;
  let admisionUserId: string;
  /** Recepción de fábrica: `patient:read` y `patient:write`, y nada más. */
  let recepcion: string;

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
      merges = app.get(PatientMergeService);
    }

    await syncAuthorisation(prisma);

    /**
     * `patient:merge` SE CONCEDE AQUÍ, A MANO, y eso es la mitad de PA-052 que
     * se ve. Ninguna semilla lo reparte —`explicitGrantOnly`—, así que un rol
     * que pueda fusionar es un rol que alguien creó y al que alguien marcó esa
     * casilla, exactamente como D-030 pide.
     */
    const role = await prisma.role.create({
      data: {
        code: 'ADMISION_JEFATURA',
        name: 'Jefatura de admisión',
        description: 'Resuelve duplicados del registro',
        permissions: {
          create: [
            { permissionCode: 'patient:read' },
            { permissionCode: 'patient:write' },
            { permissionCode: 'patient:priority' },
            { permissionCode: 'patient:merge' },
          ],
        },
      },
    });
    registry.invalidate();

    admisionUserId = await createAccount('jefatura@clinica.ec', role.id);
    admision = await signIn('jefatura@clinica.ec');

    const recepcionRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
    });
    await createAccount('mostrador@clinica.ec', recepcionRole.id);
    recepcion = await signIn('mostrador@clinica.ec');
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function createAccount(email: string, roleId: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        firstName: 'Gabriela',
        lastName: 'Mera',
        passwordHash: await argon2.hash(HTTP_PASSWORD, {
          type: argon2.argon2id,
          memoryCost: PASSWORD_HASHING.memoryCost,
          timeCost: PASSWORD_HASHING.timeCost,
          parallelism: PASSWORD_HASHING.parallelism,
        }),
      },
    });
    await prisma.userRoleGrant.create({ data: { userId: user.id, roleId } });
    return user.id;
  }

  async function signIn(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: HTTP_PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  const mergeRequest = (id: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/patients/${id}/merge`)
      .set('Authorization', `Bearer ${token}`);

  const undoRequest = (id: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/patients/${id}/merge/undo`)
      .set('Authorization', `Bearer ${token}`);

  /** PA-054. La ficha vigente tal como sale de `GET /patients/:id`. */
  async function openChart(id: string): Promise<PatientChartBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${admision}`)
      .expect(200);
    return response.body as PatientChartBody;
  }

  /** PA-040, PA-055. El motivo de la prioridad, tal como lo lee un médico. */
  async function readPriorityGroups(
    id: string,
  ): Promise<PriorityGroupListBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/patients/${id}/priority-groups`)
      .set('Authorization', `Bearer ${admision}`)
      .expect(200);
    return response.body as PriorityGroupListBody;
  }

  /**
   * Un día en formato de calendario, desplazado desde hoy EN `America/Guayaquil`.
   *
   * ⚠️ NO `Date.now() + días` PASADO POR `toISOString()`, que es lo que había:
   * eso desplaza desde el día UTC, y todo Ecuador está cinco horas al oeste.
   * Después de las 19:00 locales el día UTC ya es el siguiente, así que
   * `dayOffset(-1)` devolvía HOY en Guayaquil — y una prueba que cerraba un
   * embarazo «ayer» lo cerraba hoy, que sigue vigente porque el periodo es
   * inclusivo en los dos extremos (PA-036). El resultado era una prueba que
   * sólo pasaba antes de las siete de la tarde.
   *
   * Mismo procedimiento que `daysFromToday` en
   * `patient-priority-groups.spec.ts`: se resuelve el día clínico primero y se
   * cuenta sobre él, nunca sobre el huso de quien ejecuta las pruebas.
   */
  const dayOffset = (days: number): string => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Guayaquil',
    }).format(new Date());
    const [year, month, day] = today.split('-').map(Number) as [
      number,
      number,
      number,
    ];
    return new Date(Date.UTC(year, month - 1, day + days))
      .toISOString()
      .slice(0, 10);
  };

  /** La fusión que sale bien, que es el punto de partida de casi todo. */
  async function mergeCharts(
    source: { id: string },
    target: { id: string },
  ): Promise<MergeBody> {
    const response = await mergeRequest(source.id, admision)
      .send({ targetPatientId: target.id, reason: REASON })
      .expect(200);
    return response.body as MergeBody;
  }

  /**
   * Dos peticiones sobre la MISMA ficha origen, entrelazadas a propósito.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * POR QUÉ UN CANDADO EXTERNO Y NO UN `Promise.all` A SECAS
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El defecto que estas pruebas persiguen sólo aparece cuando las dos
   * peticiones LEEN el estado de la fusión antes de que ninguna lo haya
   * escrito, que es lo que hace un doble clic. Lanzarlas a la vez lo consigue
   * casi siempre, y «casi siempre» en una prueba de concurrencia es una prueba
   * que un día pasa sin haber reproducido nada.
   *
   * Así que una transacción ajena toma `FOR UPDATE` sobre la ficha origen antes
   * de que salga la primera. Las dos peticiones adelantan sus lecturas —un
   * bloqueo de fila no detiene un `SELECT` corriente— y se quedan esperando en
   * el primer intento de ESCRIBIR sobre ella. Al soltarlo, PostgreSQL concede
   * el bloqueo en el orden en que se pidió, y por eso esta función puede
   * devolver «la primera» y «la segunda» y no «una de las dos».
   */
  async function raceOnSourceChart(
    prismaClient: PrismaClient,
    sourcePatientId: string,
    calls: readonly [() => request.Test, () => request.Test],
  ): Promise<[request.Response, request.Response]> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = prismaClient.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM patient WHERE id = ${sourcePatientId}::uuid FOR UPDATE
        `;
        await held;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    await settle();

    // `.then()` es lo que ARRANCA una petición de supertest, y el orden en que
    // se arrancan es el orden en que pedirán el bloqueo.
    const first = calls[0]().then(
      (response) => response,
      (error: Error & { response?: request.Response }) =>
        error.response ?? Promise.reject(error),
    );
    await settle();
    const second = calls[1]().then(
      (response) => response,
      (error: Error & { response?: request.Response }) =>
        error.response ?? Promise.reject(error),
    );
    await settle();

    release();
    await holder;
    return Promise.all([first, second]);
  }

  /** Lo bastante para que la petición llegue a la base y se quede esperando. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  // =========================================================================
  // PA-052 · el permiso propio, que no trae ningún rol
  // =========================================================================

  it('PA-052 RECHAZA fusionar con el permiso de registro corriente', async () => {
    // «El sistema NO DEBERÁ admitirlas con el permiso de registro corriente.»
    // `RECEPCION` registra y corrige pacientes todo el día; unir dos historias
    // clínicas es otra cosa y tiene otra llave.
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const refused = await mergeRequest(source.id, recepcion)
      .send({ targetPatientId: target.id, reason: REASON })
      .expect(403);

    expect((refused.body as Problem).code).toBe('PERMISSION_DENIED');

    // Y la ficha sigue entera: un 403 que ya hubiera escrito no sería un 403.
    const untouched = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(untouched.mergedIntoId).toBeNull();
  });

  it('PA-052 RECHAZA deshacer con el permiso de registro corriente', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await mergeCharts(source, target);

    const refused = await undoRequest(source.id, recepcion)
      .send({ reason: REASON })
      .expect(403);

    expect((refused.body as Problem).code).toBe('PERMISSION_DENIED');
  });

  it('PA-052 no deja que ninguna semilla conceda `patient:merge`', async () => {
    /**
     * D-030: «el permiso NO LO TRAE NINGÚN ROL» —como `agenda:overbook:self` y
     * `user:reset-mfa`—. `syncAuthorisation` acaba de correr en el `beforeEach`
     * con el catálogo entero, y lo que se comprueba es que el único rol que lo
     * tiene es el que esta prueba creó a mano. Que un permiso exista y no lo
     * tenga nadie es preferible a que lo tenga quien registra pacientes.
     */
    const holders = await prisma.rolePermission.findMany({
      where: { permissionCode: 'patient:merge' },
      select: { role: { select: { code: true } } },
    });

    expect(holders.map((holder) => holder.role.code)).toEqual([
      'ADMISION_JEFATURA',
    ]);
  });

  // =========================================================================
  // PA-043, PA-044 · la fusión y su rastro, por la ruta
  // =========================================================================

  it('PA-043 la fusión conserva la ficha absorbida y responde con los dos números', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const body = await mergeCharts(source, target);

    expect(body.event).toBe('MERGE');
    expect(body.sourcePatientId).toBe(source.id);
    expect(body.sourceMrn).toBe(source.mrn);
    expect(body.targetMrn).toBe(target.mrn);
    expect(body.performedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // La absorbida NO se borra: documentos ya impresos siguen citando su MRN.
    const kept = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(kept.mrn).toBe(source.mrn);
    expect(kept.mergedIntoId).toBe(target.id);
  });

  it('PA-044 deja la fila del rastro con autor, motivo e instantánea, y la bitácora SIN valores', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    await mergeCharts(source, target);

    const trail = await prismaClient.patientMerge.findFirstOrThrow({
      where: { sourcePatientId: source.id },
    });
    expect(trail.event).toBe('MERGE');
    // El autor es quien firmó la sesión, nunca un campo de la petición.
    expect(trail.performedBy).toBe(admisionUserId);
    expect(trail.reason).toBe(REASON);
    expect((trail.sourceSnapshot as { mrn: string }).mrn).toBe(source.mrn);

    /**
     * D-032. La bitácora recibe QUIÉN y CUÁNDO y nada más.
     *
     * `access_audit_payload_only_for_declared_resources` rechaza una fila de
     * `'patient'` con carga útil, y como registrar no lanza, la fila se habría
     * perdido EN SILENCIO. El rastro con valores es `patient_merge`, que para
     * eso lleva la instantánea y que sí se puede rectificar (REQ-113).
     */
    const audit = await prismaClient.accessAudit.findMany({
      where: { resourceId: source.id, action: 'UPDATE' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.resourceType).toBe('patient');
    expect(audit[0]?.before).toBeNull();
    expect(audit[0]?.after).toBeNull();
    expect(audit[0]?.userId).toBe(admisionUserId);
  });

  it('PA-044 exige el motivo EN EL SERVICIO y no sólo en el DTO', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA QUE JUSTIFICA QUE `MERGE_REASON_REQUIRED` EXISTA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Por lo mismo que `CANCELLATION_REASON_REQUIRED` en la agenda: un `DEBERÁ`
     * que sólo hace cumplir la capa de transporte deja de cumplirse el día que
     * otro caso de uso llame POR DENTRO. Así que se llama por dentro — sin DTO,
     * sin zod y sin ruta— y el motivo se sigue exigiendo.
     *
     * Y `'   '` y no `''`: `NOT NULL` impide la ausencia, no la cadena de
     * espacios, que es un clic con más teclas.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    await expect(
      merges.merge(
        {
          sourcePatientId: source.id,
          targetPatientId: target.id,
          reason: '   ',
        },
        { userId: admisionUserId },
      ),
    ).rejects.toMatchObject({ code: 'MERGE_REASON_REQUIRED' });

    const untouched = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(untouched.mergedIntoId).toBeNull();
    expect(
      await prismaClient.patientMerge.count({
        where: { sourcePatientId: source.id },
      }),
    ).toBe(0);
  });

  it('PA-044 con dos fusiones idénticas simultáneas gana la primera y el rastro tiene UNA sola fila', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL DOBLE CLIC EN «FUSIONAR», QUE `trg_patient_merge_not_chained` NO VE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El disparador sólo levanta excepción cuando el destino CAMBIA. Reescribir
     * el MISMO destino no cambia ninguna columna, así que pasa limpio y quedan
     * DOS filas `MERGE` para una sola fusión. Lo que eso deja detrás no se
     * puede corregir nunca: al deshacer se cierra la más reciente y la anterior
     * queda abierta para siempre — la ficha entera mientras el rastro dice que
     * sigue fusionada—, y `patient_merge` es append-only. Además `merged_at`
     * guardaría el instante de la segunda petición y dejaría de coincidir con
     * el `performed_at` de la fila de la primera, que es el instante que PA-044
     * exige.
     *
     * Y LO QUE RECIBE LA SEGUNDA es `PATIENT_MERGED` con el MRN de la
     * superviviente, no `PATIENT_ALREADY_MERGED`: el origen ya está fusionado,
     * y ése es el código que el `SPEC.md` reserva para el origen —
     * `PATIENT_ALREADY_MERGED` es del destino, o del origen sólo cuando ya
     * absorbió a otras—.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const [winner, loser] = await raceOnSourceChart(prismaClient, source.id, [
      () =>
        mergeRequest(source.id, admision).send({
          targetPatientId: target.id,
          reason: REASON,
        }),
      () =>
        mergeRequest(source.id, admision).send({
          targetPatientId: target.id,
          reason: REASON,
        }),
    ]);

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
    const problem = loser.body as Problem;
    expect(problem.code).toBe('PATIENT_MERGED');
    expect(problem.errors).toEqual([
      {
        field: 'patientId',
        code: 'PATIENT_MERGED',
        message: `La historia vigente es ${target.mrn}`,
      },
    ]);

    // UNA fila, y es la que la ganadora dice haber escrito. Dos serían una
    // fusión que nadie puede deshacer entera: deshacer cierra la más reciente y
    // la anterior queda abierta para siempre sobre una ficha ya entera.
    const rows = await prismaClient.patientMerge.findMany({
      where: { sourcePatientId: source.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id.toString()).toBe((winner.body as MergeBody).mergeId);

    // Y la perdedora no escribió NADA: el enlace es el de la ganadora y no hay
    // un segundo `merged_at` encima del primero.
    const merged = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
      select: { mergedIntoId: true, mergedAt: true },
    });
    expect(merged.mergedIntoId).toBe(target.id);
    expect(merged.mergedAt).not.toBeNull();
  });

  it('PA-047 exige el motivo también al deshacer, y por dentro', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await mergeCharts(source, target);

    await expect(
      merges.undo(
        { sourcePatientId: source.id, reason: ' \n ' },
        { userId: admisionUserId },
      ),
    ).rejects.toMatchObject({ code: 'MERGE_REASON_REQUIRED' });

    // Sigue fusionada: el motivo se exige ANTES de tocar nada.
    const still = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(still.mergedIntoId).toBe(target.id);
  });

  it('PA-015 el documento que llega mientras se fusiona NO aterriza en la ficha absorbida', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA ASIMETRÍA ERA LA PRUEBA DEL DEFECTO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `PrismaPatientRepository.correct` bloquea la ficha y RELEE la fusión
     * dentro de su transacción, y su comentario dice por qué: «si la fusión se
     * confirma entre la lectura del servicio y esta escritura, la corrección
     * aterrizaría sobre la ficha absorbida y `PatientMergedError` no se
     * lanzaría nunca». Esa frase valía palabra por palabra para PA-015, que no
     * lo hacía.
     *
     * EL ESCENARIO, con las dos peticiones solapadas:
     *
     *   1. Ficha `A`, provisional, sin documento.
     *   2. Salen a la vez «añadir la cédula X a A» y «fusionar A→B».
     *   3. La fusión bloquea `A` con `FOR UPDATE`. El `INSERT` del documento se
     *      queda esperando en el `FOR KEY SHARE` de la clave foránea y
     *      REANUDA DESPUÉS de que la fusión haya movido los identificadores.
     *
     * La fila aterrizaba en la ficha ABSORBIDA, marcada `patient_merged` por
     * `trg_patient_identifier_set_merged`: fuera del índice único, sobre una
     * ficha que ninguna búsqueda devuelve, y ya no la movía nadie —la fusión
     * ya había pasado por ahí—. Al día siguiente se teclea `X`, no aparece, se
     * abre una TERCERA ficha, y deshacer responde conflicto PARA SIEMPRE. Es
     * exactamente la avería que la migración
     * `20260817222356_patient_identifier_follows_merge` se escribió para
     * eliminar. De paso, `is_provisional = false` se escribía sobre una ficha
     * ya absorbida.
     *
     * CONTRA POSTGRESQL DE VERDAD Y CON UN CANDADO EXTERNO: el defecto sólo
     * aparece cuando las dos peticiones han leído el estado antes de que
     * ninguna escriba, y «casi siempre» no es una prueba de concurrencia.
     *
     * Y SE AFIRMA QUIÉN GANA, no que «alguna de las dos falle»: gana la fusión,
     * porque es la que tomó el bloqueo primero, y la que añade el documento
     * recibe `PATIENT_MERGED` con el MRN al que ir (PA-045).
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    // PROVISIONAL DE VERDAD, o la aserción de abajo pasaría con el defecto
    // puesto: `is_provisional` ya nace en `false` y «no cambió» no diría nada.
    await prismaClient.patient.update({
      where: { id: source.id },
      data: { isProvisional: true },
    });

    const [fusion, documento] = await raceOnSourceChart(
      prismaClient,
      source.id,
      [
        () =>
          mergeRequest(source.id, admision).send({
            targetPatientId: target.id,
            reason: REASON,
          }),
        () =>
          request(app.getHttpServer())
            .post(`/api/v1/patients/${source.id}/identifiers`)
            .set('Authorization', `Bearer ${admision}`)
            .send({ type: 'CEDULA', issuingCountry: 'ECU', value: CEDULA }),
      ],
    );

    expect(fusion.status).toBe(200);
    expect(documento.status).toBe(409);
    expect((documento.body as Problem).code).toBe('PATIENT_MERGED');

    // NADA se escribió: ni la fila del documento sobre la ficha absorbida...
    const identifiers = await prismaClient.patientIdentifier.findMany({
      where: { value: CEDULA },
      select: { patientId: true, patientMerged: true },
    });
    expect(identifiers).toEqual([]);

    // ...ni el fin de lo provisional sobre una ficha que ya no se abre.
    const absorbida = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
      select: { isProvisional: true, mergedIntoId: true },
    });
    expect(absorbida.mergedIntoId).toBe(target.id);
    expect(absorbida.isProvisional).toBe(true);
  });

  // =========================================================================
  // PA-043, PA-047 · el documento sigue a la persona
  // =========================================================================

  it('PA-043 tras fusionar, la cédula de la absorbida encuentra a la SUPERVIVIENTE', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL P0: FUSIONAR NO PUEDE ESCONDER A LA PERSONA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La fusión saca la cédula de A del índice único —correcto, PA-014— y
     * ANTES no la llevaba a ninguna parte. Al día siguiente el paciente volvía,
     * en el mostrador se tecleaba su cédula, y la búsqueda —que excluye las
     * fichas fusionadas— no devolvía NADA. La entrega P4 lo pedía literalmente:
     * «comprobar que la cédula de A deja de bloquear el índice único Y QUE B LA
     * CONSERVA».
     *
     * Es lo contrario de D-031 y no lo contradice: la HISTORIA no se mueve
     * —citas, atenciones, alergias siguen en la absorbida y se leen por el
     * enlace— pero un documento de identidad no es historia, es cómo se
     * encuentra a la persona, y consolidarlo es el propósito de fusionar.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });

    await mergeCharts(source, target);

    // 1. LA FILA ES DE LA SUPERVIVIENTE, y su bandera dice que está activa.
    const moved = await prismaClient.patientIdentifier.findFirstOrThrow({
      where: { value: CEDULA },
    });
    expect(moved.patientId).toBe(target.id);
    expect(moved.patientMerged).toBe(false);

    // 2. EL MOSTRADOR LA ENCUENTRA, que es para lo que existe todo esto.
    const found = await request(app.getHttpServer())
      .get(`/api/v1/patients?q=${CEDULA}`)
      .set('Authorization', `Bearer ${admision}`)
      .expect(200);
    const items = (found.body as { items: { id: string; mrn: string }[] })
      .items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(target.id);
    expect(items[0]?.mrn).toBe(target.mrn);

    // 3. Y NO SE ABRE UNA TERCERA FICHA CON ELLA — el caso que hacía la fusión
    // irreversible para siempre, y que SC-008 prohíbe sin excepción.
    const refused = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${admision}`)
      .send({
        familyName: 'Quishpe',
        givenName: 'Marta',
        sex: 'FEMALE',
        birthDate: '1990-03-14',
        identifier: { type: 'CEDULA', value: CEDULA },
      })
      .expect(409);
    expect((refused.body as Problem).code).toBe('PATIENT_IDENTIFIER_TAKEN');
  });

  it('PA-047 al deshacer, el documento vuelve a la absorbida y se la encuentra por él', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });

    await mergeCharts(source, target);

    // SE FUE DE VERDAD, o lo de abajo no probaría que vuelve: una prueba que
    // sólo mira el final pasa igual el día que nada se mueva.
    expect(
      (
        await prismaClient.patientIdentifier.findFirstOrThrow({
          where: { value: CEDULA },
        })
      ).patientId,
    ).toBe(target.id);

    await undoRequest(source.id, admision).send({ reason: REASON }).expect(200);

    const back = await prismaClient.patientIdentifier.findFirstOrThrow({
      where: { value: CEDULA },
    });
    expect(back.patientId).toBe(source.id);
    expect(back.patientMerged).toBe(false);

    const found = await request(app.getHttpServer())
      .get(`/api/v1/patients?q=${CEDULA}`)
      .set('Authorization', `Bearer ${admision}`)
      .expect(200);
    const items = (found.body as { items: { id: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(source.id);
  });

  it('PA-043 NO mueve el documento que la superviviente ya tiene', async () => {
    /**
     * Decisión del 17-08-2026. El índice ya está satisfecho —la superviviente
     * tiene ese mismo tipo, país y valor— y mover la fila sólo dejaría dos
     * copias del mismo número en una ficha. Se queda donde está, y cuenta como
     * lo que se quedó atrás.
     *
     * `use: 'OLD'` porque es la única forma de que esto ocurra: dos fichas
     * ACTIVAS no pueden tener la misma cédula `OFFICIAL` —eso es exactamente lo
     * que `patient_identifier_active_unique` impide—, así que la copia de la
     * superviviente es siempre una fuera del índice.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });
    await prismaClient.patientIdentifier.create({
      data: { patientId: target.id, type: 'CEDULA', value: CEDULA, use: 'OLD' },
    });

    await mergeCharts(source, target);

    const rows = await prismaClient.patientIdentifier.findMany({
      where: { value: CEDULA },
      orderBy: { use: 'asc' },
      select: { patientId: true, use: true, patientMerged: true },
    });
    expect(rows).toEqual([
      // La de la absorbida, que NO se movió y sigue fuera del índice.
      { patientId: source.id, use: 'OFFICIAL', patientMerged: true },
      // La de la superviviente, intacta.
      { patientId: target.id, use: 'OLD', patientMerged: false },
    ]);
  });

  it('PA-043 NO mueve los documentos que no son OFFICIAL ni los PROVISIONAL', async () => {
    /**
     * Decisión del 17-08-2026. `patient_identifier_active_unique` excluye los
     * dos por construcción —`use = 'OFFICIAL'` y `type <> 'PROVISIONAL'`—, así
     * que moverlos no compra nada: no liberan ni ocupan el índice. Y arrastrar
     * un marcador PROVISIONAL a una ficha que sí tiene documento de verdad es
     * ensuciarla. Coherente con P2: un `PROVISIONAL` no es un documento.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'PROVISIONAL', value: 'RN-000123' },
    });
    await prismaClient.patientIdentifier.create({
      data: {
        patientId: source.id,
        type: 'PASSPORT',
        value: 'AB1234567',
        use: 'OLD',
      },
    });
    // Y uno que SÍ se mueve, para que la prueba no pase por no mover nada.
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });

    await mergeCharts(source, target);

    const rows = await prismaClient.patientIdentifier.findMany({
      where: { OR: [{ patientId: source.id }, { patientId: target.id }] },
      select: { patientId: true, type: true, value: true },
    });
    // Ordenado en TypeScript: el `ORDER BY` de la base va por la colación
    // española y lo que se juzga aquí es DÓNDE está cada fila, no cómo ordena.
    expect([...rows].sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      // El único que viaja.
      { patientId: target.id, type: 'CEDULA', value: CEDULA },
      // `use: 'OLD'`: fuera del índice, así que moverlo no compra nada.
      { patientId: source.id, type: 'PASSPORT', value: 'AB1234567' },
      // Un marcador provisional no es un documento, y no ensucia la vigente.
      { patientId: source.id, type: 'PROVISIONAL', value: 'RN-000123' },
    ]);
  });

  // =========================================================================
  // PA-045 · la ficha absorbida rechaza toda operación que la nombre
  // =========================================================================

  it('PA-045 RECHAZA abrir la ficha absorbida, nombrando el MRN de la superviviente', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await mergeCharts(source, target);

    const refused = await request(app.getHttpServer())
      .get(`/api/v1/patients/${source.id}`)
      .set('Authorization', `Bearer ${admision}`)
      .expect(409);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('PATIENT_MERGED');
    // NO es un 404: la historia existió, y el cliente necesita saber A DÓNDE se
    // movió para poder llevar allí a quien está en el mostrador.
    expect(problem.errors).toEqual([
      {
        field: 'patientId',
        code: 'PATIENT_MERGED',
        message: `La historia vigente es ${target.mrn}`,
      },
    ]);
  });

  it('PA-045 RECHAZA toda ruta del módulo que nombre la ficha absorbida', async () => {
    /**
     * «TODA operación que la nombre», recorrida de verdad y no de memoria. La
     * corrección ya lo hacía; las demás son las que este cambio cerró, y sin
     * esta prueba la siguiente ruta que se añada volverá a dejarla pasar.
     *
     * La ÚNICA excepción es deshacer, que por definición nombra una ficha
     * fusionada — y tiene su propia prueba más abajo.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const groupRecord = await prismaClient.patientPriorityGroup.create({
      data: {
        patientId: source.id,
        groupCode: 'PREGNANT',
        startsOn: new Date('2026-08-01'),
        endsOn: new Date('2027-04-01'),
        origin: 'SELF_DECLARED',
        recordedById: admisionUserId,
      },
    });
    await mergeCharts(source, target);

    const server = app.getHttpServer();
    const attempts = [
      request(server).get(`/api/v1/patients/${source.id}`),
      request(server)
        .patch(`/api/v1/patients/${source.id}`)
        .send({ familyName: 'Guamán' }),
      request(server)
        .post(`/api/v1/patients/${source.id}/identifiers`)
        .send({ type: 'CEDULA', issuingCountry: 'ECU', value: CEDULA }),
      request(server).get(`/api/v1/patients/${source.id}/priority-groups`),
      request(server)
        .post(`/api/v1/patients/${source.id}/priority-groups`)
        .send({
          group: 'PREGNANT',
          startsOn: '2026-08-01',
          endsOn: '2027-04-01',
          origin: 'SELF_DECLARED',
        }),
      request(server)
        .patch(
          `/api/v1/patients/${source.id}/priority-groups/${groupRecord.id}`,
        )
        .send({ endsOn: '2026-09-01' }),
    ];

    const answered = await Promise.all(
      attempts.map(
        (attempt) =>
        attempt
          .set('Authorization', `Bearer ${admision}`)
          .then((response) => `${response.status} ${(response.body as Problem).code}`), // prettier-ignore
      ),
    );

    expect(answered).toEqual([
      '409 PATIENT_MERGED',
      '409 PATIENT_MERGED',
      '409 PATIENT_MERGED',
      '409 PATIENT_MERGED',
      '409 PATIENT_MERGED',
      '409 PATIENT_MERGED',
    ]);
  });

  it('PA-045 RECHAZA volver a fusionar una ficha ya absorbida', async () => {
    // La tercera puerta: A→B se convertiría en A→C sin que nada lo registre, y
    // el rastro de la primera fusión quedaría apuntando a donde la ficha ya no
    // está. Primero se deshace, y deshacer deja su fila.
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const otra = await createPatient(prismaClient);
    await mergeCharts(source, target);

    const refused = await mergeRequest(source.id, admision)
      .send({ targetPatientId: otra.id, reason: REASON })
      .expect(409);

    expect((refused.body as Problem).code).toBe('PATIENT_MERGED');
    expect(
      await prismaClient.patientMerge.count({
        where: { sourcePatientId: source.id },
      }),
    ).toBe(1);
  });

  // =========================================================================
  // PA-046 · ni consigo misma, ni encadenada
  // =========================================================================

  it('PA-046 RECHAZA fusionar una ficha consigo misma con MERGE_INTO_SELF', async () => {
    const prismaClient = db();
    const patient = await createPatient(prismaClient);

    const refused = await mergeRequest(patient.id, admision)
      .send({ targetPatientId: patient.id, reason: REASON })
      .expect(422);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('MERGE_INTO_SELF');
    expect(problem.errors?.[0]?.field).toBe('targetPatientId');
  });

  it('PA-046 RECHAZA fusionar hacia una ficha ya fusionada, diciendo a dónde se movió', async () => {
    // A→B cuando B→C. Lo arbitra `trg_patient_merge_not_chained`, que además
    // bloquea la ficha destino: la aplicación NO repite la regla, sólo traduce
    // el rechazo a una frase con la que admisión puede elegir la ficha buena.
    const prismaClient = db();
    const a = await createPatient(prismaClient);
    const b = await createPatient(prismaClient);
    const c = await createPatient(prismaClient);
    await mergeCharts(b, c);

    const refused = await mergeRequest(a.id, admision)
      .send({ targetPatientId: b.id, reason: REASON })
      .expect(409);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('PATIENT_ALREADY_MERGED');
    expect(problem.errors).toEqual([
      {
        field: 'targetPatientId',
        code: 'PATIENT_ALREADY_MERGED',
        message: `Esa historia ya se unió a ${c.mrn}: deshaga esa fusión primero`,
      },
    ]);

    // Y no dejó ni el enlace ni fila de rastro: la transacción entera se cayó.
    const untouched = await prismaClient.patient.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(untouched.mergedIntoId).toBeNull();
    expect(
      await prismaClient.patientMerge.count({ where: { sourcePatientId: a.id } }), // prettier-ignore
    ).toBe(0);
  });

  it('PA-046 RECHAZA fusionar una ficha que ya absorbió a otras', async () => {
    // La misma cadena por el otro extremo: B→C cuando A→B.
    const prismaClient = db();
    const a = await createPatient(prismaClient);
    const b = await createPatient(prismaClient);
    const c = await createPatient(prismaClient);
    await mergeCharts(a, b);

    const refused = await mergeRequest(b.id, admision)
      .send({ targetPatientId: c.id, reason: REASON })
      .expect(409);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('PATIENT_ALREADY_MERGED');
    expect(problem.errors?.[0]?.field).toBe('patientId');
  });

  // =========================================================================
  // PA-047 · deshacer
  // =========================================================================

  it('PA-047 deshacer devuelve la ficha entera con su documento y deja una fila NUEVA', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });

    const merged = await mergeCharts(source, target);
    const undone = (
      await undoRequest(source.id, admision)
        .send({ reason: 'eran dos personas distintas con el mismo apellido' })
        .expect(200)
    ).body as MergeBody;

    expect(undone.event).toBe('UNDO');
    // La ficha vuelve a ser entera Y su documento vuelve al índice único.
    const whole = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(whole.mergedIntoId).toBeNull();
    expect(whole.mergedAt).toBeNull();
    const document = await prismaClient.patientIdentifier.findFirstOrThrow({
      where: { patientId: source.id },
    });
    expect(document.patientMerged).toBe(false);

    // FILA NUEVA, no una edición: la de la fusión sigue intacta y la de
    // deshacer la nombra. Es lo que hace que «¿está deshecha?» sea una consulta
    // exacta y no una adivinanza por fechas.
    const rows = await prismaClient.patientMerge.findMany({
      where: { sourcePatientId: source.id },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reason).toBe(REASON);
    expect(rows[1]?.event).toBe('UNDO');
    expect(rows[1]?.undoesMergeId?.toString()).toBe(merged.mergeId);
    expect(rows[1]?.sourceSnapshot).toBeNull();

    // Y la ficha vuelve a abrirse.
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${source.id}`)
      .set('Authorization', `Bearer ${admision}`)
      .expect(200);
  });

  it('PA-047 con dos deshaceres simultáneos gana el primero y el segundo recibe MERGE_NOT_FOUND', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL DOBLE CLIC EN «DESHACER», Y QUÉ RECIBE EL QUE PIERDE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Las dos peticiones leen que la ficha sigue fusionada y las dos encuentran
     * la MISMA fila de fusión abierta. Quien arbitra es
     * `patient_merge_undone_once`, y el perdedor salía por el mapa genérico de
     * violaciones únicas como `DUPLICATE_VALUE` 409 — un código que no está en
     * la tabla del módulo y que en el mostrador no dice nada. Lo que hay que
     * decirle es lo mismo que a quien deshace dos veces seguidas: la fusión que
     * pedía deshacer ya no está abierta, `MERGE_NOT_FOUND` 404.
     *
     * AFIRMA QUIÉN GANA, no que «al menos uno falle». El candado externo sobre
     * la ficha origen fija el entrelazado que el doble clic produce por
     * casualidad: las dos llegan a leer el estado antes de que ninguna escriba,
     * y PostgreSQL concede el bloqueo en el orden en que se pidió.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await mergeCharts(source, target);

    const [winner, loser] = await raceOnSourceChart(prismaClient, source.id, [
      () => undoRequest(source.id, admision).send({ reason: REASON }),
      () => undoRequest(source.id, admision).send({ reason: REASON }),
    ]);

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(404);
    expect((loser.body as Problem).code).toBe('MERGE_NOT_FOUND');

    // Y una sola fila de deshacer, que es lo que el rastro tiene que decir.
    expect(
      await prismaClient.patientMerge.count({
        where: { sourcePatientId: source.id, event: 'UNDO' },
      }),
    ).toBe(1);
  });

  it('PA-047 RECHAZA deshacer una ficha que no está fusionada, con MERGE_NOT_FOUND', async () => {
    /**
     * NO es `PATIENT_NOT_FOUND`, y la diferencia importa en el mostrador: el
     * paciente está en la pantalla. Lo que no existe es el SUCESO — la ficha
     * nunca se fusionó, o su fusión ya se deshizo—, y por eso es el hermano de
     * `AGENDA_ENTRY_NOT_FOUND` y no del 404 del registro.
     */
    const prismaClient = db();
    const patient = await createPatient(prismaClient);

    const refused = await undoRequest(patient.id, admision)
      .send({ reason: REASON })
      .expect(404);

    expect((refused.body as Problem).code).toBe('MERGE_NOT_FOUND');
  });

  it('PA-047 RECHAZA deshacer dos veces la misma fusión', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await mergeCharts(source, target);

    await undoRequest(source.id, admision).send({ reason: REASON }).expect(200);
    const refused = await undoRequest(source.id, admision)
      .send({ reason: REASON })
      .expect(404);

    expect((refused.body as Problem).code).toBe('MERGE_NOT_FOUND');
    expect(
      await prismaClient.patientMerge.count({
        where: { sourcePatientId: source.id, event: 'UNDO' },
      }),
    ).toBe(1);
  });

  // =========================================================================
  // PA-048 · el documento ya reclamado
  // =========================================================================

  it('PA-048 RECHAZA deshacer con MERGE_UNDO_CONFLICT nombrando la ficha que tiene el documento', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * QUÉ QUEDA DE PA-048 DESDE QUE EL DOCUMENTO VIAJA A LA SUPERVIVIENTE
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Que la base rechace es CORRECTO: es la consecuencia técnica de PA-014, y
     * SC-008 dice que el número de fichas activas con el mismo documento es
     * cero sin excepción. Lo que estaba mal era la respuesta —
     * `DUPLICATE_IDENTIFIER` sobre un documento que quien deshace no estaba
     * tocando—, porque el mapa de constraints no puede distinguir un alta
     * duplicada de un deshacer sobre el MISMO índice. Sólo el servicio sabe cuál
     * de las dos operaciones se pidió.
     *
     * ⚠️ EL MONTAJE CAMBIÓ, Y ESO ES LA PRUEBA DE QUE EL P0 ESTÁ ARREGLADO.
     * Antes bastaba con fusionar y dejar que otra ficha tomara la cédula
     * liberada — y eso es precisamente lo que ya NO se puede hacer: la cédula
     * viaja a la superviviente y sigue ocupando el índice. Para que otra ficha
     * la reclame, la absorbida tiene que tener un documento `OFFICIAL` que no
     * esté en la superviviente, y desde la aplicación eso ya no ocurre. Sí
     * ocurre por los caminos que no pasan por las rutas —una importación, un
     * `INSERT` por `psql`, datos traídos de otro sistema—, que es el mismo
     * argumento del dígito verificador de la cédula, y por eso PA-048 sigue
     * siendo necesario y no una reliquia.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const tercera = await createPatient(prismaClient);

    await mergeCharts(source, target);

    // Una importación le da un documento a una ficha YA fusionada. El
    // disparador lo marca `patient_merged`, así que entra fuera del índice.
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });
    // Y por eso otra ficha activa puede tomarlo.
    await prismaClient.patientIdentifier.create({
      data: { patientId: tercera.id, type: 'CEDULA', value: CEDULA },
    });

    const refused = await undoRequest(source.id, admision)
      .send({ reason: REASON })
      .expect(409);

    const problem = refused.body as Problem;
    expect(problem.code).toBe('MERGE_UNDO_CONFLICT');
    expect(problem.errors).toEqual([
      {
        field: 'patientId',
        code: 'MERGE_UNDO_CONFLICT',
        message: `La historia ${tercera.mrn} tiene ahora la cédula de esta ficha: corríjala allí antes de deshacer la fusión`,
      },
    ]);

    // ⚠️ NOMBRA EL CONFLICTO SIN FILTRAR NADA (PA-025, REQ-116): la CLASE de
    // documento y el número de historia, jamás el valor de la cédula ni un
    // nombre.
    const everything = JSON.stringify(problem);
    expect(everything).not.toContain(CEDULA);
    expect(everything).not.toContain('Guamán');
  });

  it('PA-048 no deja la fusión a medio deshacer cuando el documento está reclamado', async () => {
    /**
     * LAS TRES ESCRITURAS SE DESHACEN JUNTAS, que es lo que ninguna prueba de
     * esquema puede ver: deshacer son los documentos que VUELVEN, la ficha y la
     * fila del rastro. Una reversión a medias dejaría la ficha ni fusionada ni
     * entera, el rastro afirmando que se deshizo algo que sigue hecho, o —desde
     * el P0— un pasaporte que ya volvió a una ficha que sigue fusionada, es
     * decir un documento que no está en ninguna ficha viva.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const tercera = await createPatient(prismaClient);
    // Éste SÍ viaja a la superviviente al fusionar, y tiene que volver —o no
    // moverse en absoluto— cuando el deshacer se cae.
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'PASSPORT', value: OTRA_CEDULA },
    });

    await mergeCharts(source, target);

    // Y una importación le mete una cédula a la ficha ya fusionada, que otra
    // ficha activa reclama después. Ver el montaje de la prueba anterior.
    await prismaClient.patientIdentifier.create({
      data: { patientId: source.id, type: 'CEDULA', value: CEDULA },
    });
    await prismaClient.patientIdentifier.create({
      data: { patientId: tercera.id, type: 'CEDULA', value: CEDULA },
    });

    await undoRequest(source.id, admision).send({ reason: REASON }).expect(409);

    const still = await prismaClient.patient.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(still.mergedIntoId).toBe(target.id);
    expect(still.mergedAt).not.toBeNull();

    // EL PASAPORTE NO VOLVIÓ A MEDIAS: sigue en la superviviente y activo.
    const passport = await prismaClient.patientIdentifier.findFirstOrThrow({
      where: { value: OTRA_CEDULA },
      select: { patientId: true, patientMerged: true },
    });
    expect(passport).toEqual({ patientId: target.id, patientMerged: false });

    // Y la cédula importada sigue fuera del índice, en la ficha fusionada.
    const flags = await prismaClient.patientIdentifier.findMany({
      where: { patientId: source.id },
      select: { patientMerged: true },
    });
    expect(flags).toEqual([{ patientMerged: true }]);

    // NI UNA FILA DE DESHACER: el rastro no puede afirmar lo que no ocurrió.
    expect(
      await prismaClient.patientMerge.count({
        where: { sourcePatientId: source.id, event: 'UNDO' },
      }),
    ).toBe(0);

    // Y la fusión se puede seguir deshaciendo el día que se libere el
    // documento, que es lo que dice que no quedó nada a medias.
    await prismaClient.patientIdentifier.deleteMany({
      where: { patientId: tercera.id },
    });
    await undoRequest(source.id, admision).send({ reason: REASON }).expect(200);

    // Y entonces sí vuelve el pasaporte, a una ficha ya entera.
    expect(
      await prismaClient.patientIdentifier.findFirstOrThrow({
        where: { value: OTRA_CEDULA },
        select: { patientId: true, patientMerged: true },
      }),
    ).toEqual({ patientId: source.id, patientMerged: false });
  });

  // =========================================================================
  // PA-049 · qué ocurre con las citas, atenciones y documentos
  // =========================================================================

  it('PA-049 la respuesta dice qué ocurre con las citas, atenciones y documentos de la absorbida', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * D-031 HECHO COMPROBABLE: SE LEE POR EL ENLACE Y NO SE MUEVE NADA
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El esquema ya hacía (b) sin que nadie lo hubiera decidido, y una garantía
     * que nadie puede observar es un comentario. Así que la propia respuesta de
     * la fusión lo dice —`READ_THROUGH_LINK` y cuántas filas se quedaron— y
     * esta prueba comprueba las DOS mitades: lo que contesta, y que las filas
     * sigan teniendo el `patient_id` de la absorbida.
     *
     * La mitad de abajo es la que importa: si algún día alguien repunta las
     * filas «para unificar la historia», los contadores seguirían cuadrando
     * sobre la superviviente y sólo el `patient_id` lo delataría.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const site = await createSite(prismaClient, 'Sede Norte');
    const practitioner = await createPractitioner(prismaClient);
    await linkPractitionerToSite(prismaClient, practitioner.id, site.id);
    const slot = hourSlot(9);
    const appointment = await prismaClient.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: source.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        // `agenda_entry_booking_channel_coherence`: una cita tiene canal, un
        // bloqueo no. La rejilla no interviene aquí — lo que se juzga es dónde
        // se queda la fila, no cómo se reservó.
        bookingChannel: 'PHONE',
      },
    });
    const encounter = await createEncounter(prismaClient, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: source.id,
    });
    const certificate = await prismaClient.medicalCertificate.create({
      data: {
        encounterId: encounter.id,
        // CER-009. `medical_certificate_number_assigned` takes it from the
        // attention whatever is sent.
        siteId: site.id,
        patientId: source.id,
        issuedById: practitioner.id,
        type: 'ATTENDANCE',
        verificationCode: 'VC-0000000001',
      },
    });

    const body = await mergeCharts(source, target);

    expect(body.linkedRecords).toEqual({
      policy: 'READ_THROUGH_LINK',
      appointments: 1,
      encounters: 1,
      documents: 1,
      allergies: 0,
      contacts: 0,
      priorityGroups: 0,
      waitlistEntries: 0,
    });

    // NINGUNA FILA SE MOVIÓ. Repuntarlas —la opción (a) de PA-049— unificaría
    // la historia y haría la fusión irreversible en la práctica: deshacer
    // exigiría recordar cuáles se movieron, y una cita creada DESPUÉS de la
    // fusión no debe volver.
    const stayed = await Promise.all([
      prismaClient.agendaEntry.findUniqueOrThrow({
        where: { id: appointment.id },
        select: { patientId: true },
      }),
      prismaClient.encounter.findUniqueOrThrow({
        where: { id: encounter.id },
        select: { patientId: true },
      }),
      prismaClient.medicalCertificate.findUniqueOrThrow({
        where: { id: certificate.id },
        select: { patientId: true },
      }),
    ]);
    expect(stayed).toEqual([
      { patientId: source.id },
      { patientId: source.id },
      { patientId: source.id },
    ]);

    // Y la superviviente no ganó ninguna: lee por el enlace, no por copia.
    expect(
      await prismaClient.agendaEntry.count({ where: { patientId: target.id } }),
    ).toBe(0);
  });

  it('PA-062 la fusión que junta un reposo con una maternidad que se solapa se hace igual, y avisa', async () => {
    const prismaClient = db();
    const site = await createSite(prismaClient, 'Sede Norte');
    const practitioner = await createPractitioner(prismaClient);

    let codes = 0;
    /** A rest on its own attention of `chart`, issued that same day. */
    async function aRest(
      chart: { id: string },
      period: { from: number; to: number },
      maternity: boolean,
    ) {
      const encounter = await createEncounter(prismaClient, {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: chart.id,
      });
      const day = clinicalDateOf(encounter.startedAt);
      const date = (offset: number) => new Date(`${addDays(day, offset)}T00:00:00Z`); // prettier-ignore
      if (maternity) await createDiagnosis(prismaClient, encounter.id, 'O80');
      return prismaClient.medicalCertificate.create({
        data: {
          encounterId: encounter.id,
          siteId: site.id,
          patientId: chart.id,
          issuedById: practitioner.id,
          type: 'MEDICAL_REST',
          restFrom: date(period.from),
          restTo: date(period.to),
          includeDiagnosis: true,
          contingencyType: maternity ? 'MATERNITY' : 'GENERAL_ILLNESS',
          ...(maternity
            ? { maternityAdmissionOn: date(-1), birthOn: date(0), maternityDischargeOn: date(2) } // prettier-ignore
            : {}),
          verificationCode: `VC-PA062-${String(++codes).padStart(4, '0')}`,
          issuedAt: encounter.startedAt,
        },
      });
    }

    // La duplicada tiene un reposo general; la de la paciente, su maternidad.
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await aRest(source, { from: 0, to: 1 }, false);
    await aRest(target, { from: 0, to: 10 }, true);
    const body = await mergeCharts(source, target);
    // La fusión se hace (PA-043) y lo dice.
    expect(body.event).toBe('MERGE');
    // Nombra los dos reposos, por su número.
    const general = await prismaClient.medicalCertificate.findFirstOrThrow({ where: { patientId: source.id } }); // prettier-ignore
    const maternity = await prismaClient.medicalCertificate.findFirstOrThrow({ where: { patientId: target.id } }); // prettier-ignore
    expect(body.restOverlapNotice).toContain(`el N.º ${general.number} (del`);
    expect(body.restOverlapNotice).toContain(`con el N.º ${maternity.number} (maternidad`); // prettier-ignore
    // Y deshacer no avisa de nada.
    const undone = await undoRequest(source.id, admision)
      .send({ reason: REASON })
      .expect(200);
    expect((undone.body as MergeBody).restOverlapNotice).toBeNull();

    // Control positivo: sin solape, sin aviso.
    const apart = await createPatient(prismaClient);
    const survivor = await createPatient(prismaClient);
    await aRest(apart, { from: 0, to: 0 }, false);
    await aRest(survivor, { from: 1, to: 10 }, true);
    expect((await mergeCharts(apart, survivor)).restOverlapNotice).toBeNull();

    // Un reposo anulado no cuenta, ni dos generales que se pisan.
    const revoker = await createUser(prismaClient);
    const withRevoked = await createPatient(prismaClient);
    const keeper = await createPatient(prismaClient);
    const revoked = await aRest(withRevoked, { from: 0, to: 1 }, false);
    await prismaClient.medicalCertificate.update({
      where: { id: revoked.id },
      data: { revokedAt: new Date(), revokedById: revoker.id, revocationReason: 'Atención equivocada' }, // prettier-ignore
    });
    await aRest(keeper, { from: 0, to: 10 }, true);
    expect(
      (await mergeCharts(withRevoked, keeper)).restOverlapNotice,
    ).toBeNull();
    const generalOne = await createPatient(prismaClient);
    const generalTwo = await createPatient(prismaClient);
    await aRest(generalOne, { from: 0, to: 1 }, false);
    await aRest(generalTwo, { from: 0, to: 1 }, false);
    expect(
      (await mergeCharts(generalOne, generalTwo)).restOverlapNotice,
    ).toBeNull();

    // La maternidad de una ficha que la superviviente ya había absorbido
    // también cuenta.
    const earlier = await createPatient(prismaClient);
    const holder = await createPatient(prismaClient);
    await aRest(earlier, { from: 0, to: 10 }, true);
    await mergeCharts(earlier, holder);
    const late = await createPatient(prismaClient);
    await aRest(late, { from: 1, to: 3 }, false);
    expect((await mergeCharts(late, holder)).restOverlapNotice).toContain(
      'maternidad',
    );
  });

  it('PA-049 cuenta TODO lo que se queda en la absorbida, las ALERGIAS incluidas', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TRES CONTADORES DECÍAN «NO SE MOVIÓ NADA» Y CALLABAN LA LISTA DE ALERGIAS
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El campo existe, según su propio DTO, «para que sea comprobable» qué se
     * quedó donde estaba. Con citas, atenciones y documentos, quien fusiona lee
     * que nada se movió y NO SE ENTERA de que las alergias, los contactos, los
     * grupos prioritarios y la lista de espera se quedaron en la ficha vieja.
     * Las alergias son las que duelen: quien prescribe sobre la superviviente
     * las consulta por `patient_id` y no las encuentra.
     *
     * UNA DE CADA, y todas distintas de cero: con ceros, un contador que no
     * cuenta nada pasaría igual.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const site = await createSite(prismaClient, 'Sede Sur');
    const practitioner = await createPractitioner(prismaClient);
    await linkPractitionerToSite(prismaClient, practitioner.id, site.id);
    const slot = hourSlot(11);

    await prismaClient.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: source.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bookingChannel: 'PHONE',
      },
    });
    const encounter = await createEncounter(prismaClient, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: source.id,
    });
    await prismaClient.medicalCertificate.create({
      data: {
        encounterId: encounter.id,
        // CER-009. `medical_certificate_number_assigned` takes it from the
        // attention whatever is sent.
        siteId: site.id,
        patientId: source.id,
        issuedById: practitioner.id,
        type: 'ATTENDANCE',
        verificationCode: 'VC-0000000002',
      },
    });
    await prismaClient.referral.create({
      data: {
        encounterId: encounter.id,
        patientId: source.id,
        direction: 'REFERRAL',
        issuedById: practitioner.id,
        reason: 'valoración por especialidad',
      },
    });
    await prismaClient.patientAllergy.create({
      data: {
        recordedById: (await createUser(prismaClient)).id,
        patientId: source.id,
        substanceText: 'penicilina',
        criticality: 'HIGH',
      },
    });
    await prismaClient.patientContact.create({
      data: {
        patientId: source.id,
        fullName: 'Rosa Chiluiza',
        relationship: 'madre',
      },
    });
    await prismaClient.patientPriorityGroup.create({
      data: {
        patientId: source.id,
        groupCode: 'DISABILITY',
        startsOn: new Date('2026-01-05'),
        origin: 'SELF_DECLARED',
        recordedById: admisionUserId,
      },
    });
    // El rango preferido es obligatorio desde
    // `20260819125906_agenda_waitlist_contact_trail`: sin fecha máxima la
    // entrada no puede caducar nunca (AG-060, AG-065).
    await prismaClient.waitlistEntry.create({
      data: {
        patientId: source.id,
        siteId: site.id,
        preferredFrom: new Date('2026-09-01'),
        preferredTo: new Date('2026-09-30'),
      },
    });

    const body = await mergeCharts(source, target);

    expect(body.linkedRecords).toEqual({
      policy: 'READ_THROUGH_LINK',
      appointments: 1,
      encounters: 1,
      // Certificados y derivaciones: uno de cada, y por eso son DOS.
      documents: 2,
      allergies: 1,
      contacts: 1,
      priorityGroups: 1,
      waitlistEntries: 1,
    });

    // Y siguen donde estaban, que es la mitad que importa de PA-049: con sólo
    // los contadores, repuntar las filas «para unificar la historia» seguiría
    // cuadrando.
    expect(
      await prismaClient.patientAllergy.count({
        where: { patientId: target.id },
      }),
    ).toBe(0);
    expect(
      await prismaClient.patientAllergy.count({
        where: { patientId: source.id },
      }),
    ).toBe(1);
  });

  it('PA-049 lo dice también al deshacer, sobre la ficha que vuelve', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await mergeCharts(source, target);

    const undone = (
      await undoRequest(source.id, admision)
        .send({ reason: REASON })
        .expect(200)
    ).body as MergeBody;

    expect(undone.linkedRecords.policy).toBe('READ_THROUGH_LINK');
    expect(undone.linkedRecords.appointments).toBe(0);
  });

  // =========================================================================
  // PA-054 · desde la superviviente, el enlace deja de ser invisible
  // =========================================================================

  it('PA-054 tras fusionar A en B, la ficha de B NOMBRA a A; al deshacer, deja de nombrarla', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA MITAD QUE LE FALTABA A PA-043, Y EL ESCENARIO DE LA ALERGIA (D-038)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * P4 dejó el enlace puesto y recorrible en UN solo sentido: la absorbida
     * apunta a la superviviente (PA-043) y abrirla lleva a la vigente
     * (PA-045). Desde la superviviente no había nada, así que:
     *
     * > Admisión fusiona correctamente las dos fichas de una paciente. En la
     * > absorbida estaba su ALERGIA A LA PENICILINA. El médico abre la ficha
     * > vigente, no ve ninguna alergia, y prescribe.
     *
     * Esto no lee la alergia —quién la lee lo decide D-038— y no adelanta
     * ninguna de sus tres opciones: hace que la ficha vigente pueda DECIR que
     * el enlace existe, que es la condición para que alguien lo siga.
     *
     * SE MONTA CON LA ALERGIA PUESTA a propósito: es el dato del escenario, y
     * la prueba afirma que sigue en la absorbida —D-031 no se toca— mientras
     * la superviviente por fin dice a dónde ir a buscarla.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    await prismaClient.patientAllergy.create({
      data: {
        recordedById: (await createUser(prismaClient)).id,
        patientId: source.id,
        substanceText: 'penicilina',
        criticality: 'HIGH',
      },
    });

    const before = await openChart(target.id);
    expect(before.absorbedCharts).toEqual({ total: 0, mrns: [] });

    await mergeCharts(source, target);

    const merged = await openChart(target.id);
    expect(merged.absorbedCharts).toEqual({
      total: 1,
      mrns: [source.mrn],
    });

    // La alergia NO se movió: la superviviente dice dónde está, no se la
    // queda. Repuntarla es la opción B de D-038 y no está decidida.
    expect(
      await prismaClient.patientAllergy.count({
        where: { patientId: source.id },
      }),
    ).toBe(1);
    expect(
      await prismaClient.patientAllergy.count({
        where: { patientId: target.id },
      }),
    ).toBe(0);

    await undoRequest(source.id, admision).send({ reason: REASON }).expect(200);

    // Y AL DESHACER DEJA DE NOMBRARLA. Un aviso que sobrevive a la reversión
    // manda a quien lee a una ficha que ya es entera y ajena.
    const undone = await openChart(target.id);
    expect(undone.absorbedCharts).toEqual({ total: 0, mrns: [] });
  });

  it('PA-054 nombra las DOS fichas que absorbió, y el listado no lo lleva', async () => {
    /**
     * DOS, porque con una sola un mapeo que devolviera «la primera» pasaría
     * igual. Se fusionan en orden y se esperan en ese mismo orden: lo que se
     * enumera son FUSIONES, y `mergedAt` es lo que las ordena.
     *
     * Y EL LISTADO NO LO LLEVA (PA-021): la búsqueda se dispara con cada letra
     * tecleada y ninguna fila de resultados lo necesita. Se afirma sobre la
     * respuesta HTTP —la fila de la superviviente, que es la que lo tendría—
     * y no sobre el esquema.
     */
    const prismaClient = db();
    const first = await createPatient(prismaClient);
    const second = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    await mergeCharts(first, target);
    await mergeCharts(second, target);

    const chart = await openChart(target.id);
    expect(chart.absorbedCharts).toEqual({
      total: 2,
      mrns: [first.mrn, second.mrn],
    });

    const listing = await request(app.getHttpServer())
      .get(`/api/v1/patients`)
      .query({ q: 'Guamán' })
      .set('Authorization', `Bearer ${admision}`)
      .expect(200);

    const rows = (listing.body as { items: Record<string, unknown>[] }).items;
    const survivor = rows.find((row) => row.mrn === target.mrn);
    expect(survivor).toBeDefined();
    expect(survivor?.absorbedCharts).toBeUndefined();
    // Y las absorbidas no salen del listado por defecto, que es lo que hace
    // que la superviviente sea el único sitio donde el enlace puede verse.
    expect(rows.some((row) => row.mrn === first.mrn)).toBe(false);
  });
  it('PA-055 la historia de la absorbida se lee desde la superviviente, y deja de leerse al deshacer', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * D-038, OPCIÓN C. LA MITAD QUE PA-054 DEJÓ SIN HACER.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * PA-054 hizo que la ficha vigente DIGA que absorbió a otra. Esto es que
     * alguien la LEA. El escenario es el de la alergia (REQ-008), y aquí se
     * monta con un grupo prioritario porque es lo único de la historia que ya
     * tiene código: `patient_allergy` y `encounter` se especifican con
     * `encounter`, y el alcance compartido ya los cubre el día que existan.
     *
     * > Una embarazada con dos fichas se fusiona correctamente. El embarazo
     * > estaba en la absorbida. La superviviente deja de constar como
     * > prioritaria, y la sala la llama como a cualquier otra.
     *
     * TRES AFIRMACIONES, Y LA TERCERA ES LA QUE PRUEBA QUE NADIE HIZO TRAMPA:
     *
     *  1. Desde B se ve el motivo que está registrado en A (PA-040).
     *  2. La PRIORIDAD CALCULADA de B cambia en consecuencia (PA-041), que es
     *     lo que la agenda ordena (AG-062). Es la consecuencia visible de
     *     D-038 y es la correcta: es la misma persona.
     *  3. La fila SIGUE TENIENDO el `patient_id` de A. D-031 no se toca: no se
     *     repunta nada, se lee por el enlace. Sin esta afirmación, repuntar la
     *     fila «para unificar la historia» pasaría las otras dos.
     *
     * Y AL DESHACER SE APAGA SOLO, sin que nadie se acuerde de nada: el
     * alcance se deriva de `merged_into_id` al leer y no se guarda en ninguna
     * parte, así que limpiar el enlace es todo lo que hace falta.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const recorded = await request(app.getHttpServer())
      .post(`/api/v1/patients/${source.id}/priority-groups`)
      .set('Authorization', `Bearer ${admision}`)
      .send({
        group: 'PREGNANT',
        startsOn: dayOffset(-30),
        endsOn: dayOffset(120),
        origin: 'SELF_DECLARED',
      })
      .expect(201);
    const recordId = (recorded.body as { id: string }).id;

    // Antes de fusionar, B no sabe nada de ella y es una ficha estándar.
    expect((await readPriorityGroups(target.id)).items).toEqual([]);
    expect((await openChart(target.id)).priority).toBe(2);

    await mergeCharts(source, target);

    const seen = (await readPriorityGroups(target.id)).items;
    expect(seen.map((record) => record.id)).toEqual([recordId]);
    expect(seen[0]?.group).toBe('PREGNANT');
    expect(seen[0]?.inForce).toBe(true);
    expect((await openChart(target.id)).priority).toBe(1);

    const row = await prismaClient.patientPriorityGroup.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(row.patientId).toBe(source.id);

    await undoRequest(source.id, admision).send({ reason: REASON }).expect(200);

    expect((await readPriorityGroups(target.id)).items).toEqual([]);
    expect((await openChart(target.id)).priority).toBe(2);
  });

  it('PA-055 deja cerrar desde la superviviente un grupo que está en la absorbida', async () => {
    /**
     * La otra mitad de «se ve»: PA-037 cierra un estado poniéndole fecha, y un
     * motivo que se ve y no se puede cerrar deja al médico mirando un embarazo
     * de hace dos años sin forma de terminarlo. El `patient_id` de la fila no
     * cambia al cerrarla —sigue siendo el de la absorbida—, así que deshacer
     * se la lleva de vuelta con su fecha de fin puesta, como cualquier otra.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);

    const recorded = await request(app.getHttpServer())
      .post(`/api/v1/patients/${source.id}/priority-groups`)
      .set('Authorization', `Bearer ${admision}`)
      .send({
        group: 'PREGNANT',
        startsOn: dayOffset(-30),
        endsOn: dayOffset(120),
        origin: 'SELF_DECLARED',
      })
      .expect(201);
    const recordId = (recorded.body as { id: string }).id;

    await mergeCharts(source, target);

    await request(app.getHttpServer())
      .patch(`/api/v1/patients/${target.id}/priority-groups/${recordId}`)
      .set('Authorization', `Bearer ${admision}`)
      .send({ endsOn: dayOffset(-1) })
      .expect(200);

    // Cerrado, NO borrado (PA-037), y sin haberse movido de ficha (D-031).
    const row = await prismaClient.patientPriorityGroup.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(row.patientId).toBe(source.id);
    expect(row.endsOn).not.toBeNull();

    // Y B vuelve a ser estándar porque ya no hay ninguna valoración vigente.
    expect((await openChart(target.id)).priority).toBe(2);
  });
  // =========================================================================
  // PA-060 · la cola es un reparto, y la fusión no puede costarle el turno
  // =========================================================================

  /**
   * Una inscripción abierta, con la antigüedad que la prueba necesita.
   *
   * `createdAt` EXPLÍCITO: es lo único que AG-061 lee para desempatar, así que
   * una prueba sobre la antigüedad que dejara la columna en `now()` no podría
   * distinguir «se conservó» de «se creó ahora».
   */
  async function enrolInWaitlist(
    prismaClient: PrismaClient,
    entry: {
      patientId: string;
      siteId: string;
      createdAt: Date;
      practitionerId?: string;
      status?: 'WAITING' | 'CONTACTED' | 'EXPIRED';
      preferredTo?: string;
    },
  ) {
    return prismaClient.waitlistEntry.create({
      data: {
        patientId: entry.patientId,
        siteId: entry.siteId,
        practitionerId: entry.practitionerId ?? null,
        preferredFrom: new Date('2026-09-01'),
        preferredTo: new Date(entry.preferredTo ?? '2099-09-30'),
        status: entry.status ?? 'WAITING',
        createdAt: entry.createdAt,
      },
    });
  }

  const MARCH = new Date('2026-03-02T14:00:00.000Z');

  it('PA-060 la inscripción abierta de la absorbida nace en la superviviente CON SU FECHA ORIGINAL', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * D-041 (B). LA FUSIÓN ES UN ACTO ADMINISTRATIVO; LA COLA, UN REPARTO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Rosa se inscribió en marzo. Admisión fusiona sus dos fichas en agosto, y
     * hasta hoy eso le costaba el turno: la entrada colgaba de la absorbida y
     * la cola no la propone nunca más (AG-027 impide reservar sobre ella, y
     * `trg_waitlist_entry_conversion_consented` exige que la cita sea del
     * MISMO `patient_id`). Leer por el enlace, que resuelve todo lo demás
     * (PA-055), aquí ofrecería un cupo que nadie puede tomar.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const site = await createSite(prismaClient, 'Sede Norte');
    const practitioner = await createPractitioner(prismaClient);
    await linkPractitionerToSite(prismaClient, practitioner.id, site.id);

    const original = await enrolInWaitlist(prismaClient, {
      patientId: source.id,
      siteId: site.id,
      practitionerId: practitioner.id,
      createdAt: MARCH,
    });

    await mergeCharts(source, target);

    const carried = await prismaClient.waitlistEntry.findMany({
      where: { patientId: target.id },
    });
    expect(carried).toHaveLength(1);
    // LA ANTIGÜEDAD, que es el requisito entero: `created_at` es lo que AG-061
    // lee para desempatar, y una fila nacida hoy manda a Rosa al final.
    expect(carried[0]?.createdAt.toISOString()).toBe(MARCH.toISOString());
    expect(carried[0]?.siteId).toBe(site.id);
    expect(carried[0]?.practitionerId).toBe(practitioner.id);
    // `WAITING` y no `CONTACTED`: la entrada nueva no tiene llamadas propias,
    // y el rastro de llamadas no se copia (es append-only, AG-064).
    expect(carried[0]?.status).toBe('WAITING');

    // Y LA ORIGINAL NO SE MOVIÓ (D-031): sigue siendo de la absorbida, con su
    // `patient_id` intacto. Repuntarla es lo que D-031 rechazó.
    const stayed = await prismaClient.waitlistEntry.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(stayed.patientId).toBe(source.id);
  });

  it('PA-060 el rastro de la fusión sigue contando la inscripción que se quedó en la absorbida', async () => {
    /**
     * PA-049 responde «cuántas filas de la ABSORBIDA se quedaron donde
     * estaban», y esa frase tiene que seguir siendo cierta después de PA-060:
     * la fila nueva es de la superviviente y nunca entró en este objeto.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const site = await createSite(prismaClient, 'Sede Valle');

    await enrolInWaitlist(prismaClient, {
      patientId: source.id,
      siteId: site.id,
      createdAt: MARCH,
    });

    const body = await mergeCharts(source, target);

    expect(body.linkedRecords.waitlistEntries).toBe(1);
    expect(body.linkedRecords.policy).toBe('READ_THROUGH_LINK');
  });

  it('PA-060 deshacer la fusión retira la inscripción que la fusión creó', async () => {
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const site = await createSite(prismaClient, 'Sede Centro');

    const original = await enrolInWaitlist(prismaClient, {
      patientId: source.id,
      siteId: site.id,
      createdAt: MARCH,
    });

    await mergeCharts(source, target);
    await undoRequest(source.id, admision)
      .send({ reason: 'eran dos personas distintas' })
      .expect(200);

    // La cola vuelve a estar como estaba: una entrada, la de siempre, en la
    // ficha que vuelve a estar entera.
    const entries = await prismaClient.waitlistEntry.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(original.id);
    expect(entries[0]?.patientId).toBe(source.id);
    expect(entries[0]?.status).toBe('WAITING');
  });

  it('PA-060 no deja compitiendo dos veces a quien la superviviente ya tenía inscrita igual', async () => {
    /**
     * Duplicar pondría a la misma persona a competir dos veces por el mismo
     * cupo, que es lo contrario de un reparto justo: las cinco columnas que
     * AG-060 enumera son el contenido entero de una inscripción, así que dos
     * entradas que coinciden en todas son la misma petición.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const site = await createSite(prismaClient, 'Sede Sur');

    await enrolInWaitlist(prismaClient, {
      patientId: source.id,
      siteId: site.id,
      createdAt: MARCH,
    });
    const standing = await enrolInWaitlist(prismaClient, {
      patientId: target.id,
      siteId: site.id,
      createdAt: new Date('2026-06-10T14:00:00.000Z'),
    });

    await mergeCharts(source, target);

    const onSurvivor = await prismaClient.waitlistEntry.findMany({
      where: { patientId: target.id },
    });
    expect(onSurvivor).toHaveLength(1);
    expect(onSurvivor[0]?.id).toBe(standing.id);
    // Y la que ya estaba no se reescribe: `created_at` sigue diciendo cuándo
    // se escribió esa fila, no cuándo llegó la persona a la cola.
    expect(onSurvivor[0]?.createdAt.toISOString()).toBe(
      '2026-06-10T14:00:00.000Z',
    );
  });

  it('PA-060 no resucita en la superviviente una inscripción ya cerrada', async () => {
    /**
     * Recrear una `EXPIRED` con su antigüedad original es exactamente lo que
     * `trg_waitlist_entry_closure_final` existe para impedir —«una entrada
     * cerrada no vuelve a competir por un cupo»—, y hacerlo escribiendo en
     * otra fila seguiría siendo rodear el disparador.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const site = await createSite(prismaClient, 'Sede Norte');

    await enrolInWaitlist(prismaClient, {
      patientId: source.id,
      siteId: site.id,
      createdAt: MARCH,
      status: 'EXPIRED',
    });

    await mergeCharts(source, target);

    expect(
      await prismaClient.waitlistEntry.count({
        where: { patientId: target.id },
      }),
    ).toBe(0);
  });

  it('PA-060 al deshacer cierra, en vez de borrar, la inscripción a la que ya se llamó', async () => {
    /**
     * El rastro de llamadas es append-only (AG-064) y la clave foránea es
     * `ON DELETE RESTRICT`: una llamada que ocurrió no se borra porque una
     * fusión se revirtiera. La entrada deja de competir y punto.
     */
    const prismaClient = db();
    const source = await createPatient(prismaClient);
    const target = await createPatient(prismaClient);
    const site = await createSite(prismaClient, 'Sede Centro');

    await enrolInWaitlist(prismaClient, {
      patientId: source.id,
      siteId: site.id,
      createdAt: MARCH,
    });
    await mergeCharts(source, target);

    const copy = await prismaClient.waitlistEntry.findFirstOrThrow({
      where: { patientId: target.id },
    });
    await prismaClient.waitlistContactAttempt.create({
      data: {
        waitlistEntryId: copy.id,
        outcome: 'NO_ANSWER',
        recordedById: admisionUserId,
      },
    });

    await undoRequest(source.id, admision)
      .send({ reason: 'eran dos personas distintas' })
      .expect(200);

    const kept = await prismaClient.waitlistEntry.findUniqueOrThrow({
      where: { id: copy.id },
    });
    expect(kept.status).toBe('CANCELLED');
    expect(
      await prismaClient.waitlistContactAttempt.count({
        where: { waitlistEntryId: copy.id },
      }),
    ).toBe(1);
  });
});
