import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import '../../src/modules/encounter/infrastructure/encounter.constraints';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * Referral, counter-referral, derivation and reverse referral, and the
 * interconsultation, against a real PostgreSQL (encounter H8, EN-100 to
 * EN-107): what `20261008230100_referral_interconsultation_h8` refuses,
 * whoever writes —the API, an import, a `psql`—.
 *
 * Every refusal has its positive control: the same row with the one thing
 * fixed goes in, so a guard that refused everything would not pass.
 */
const db = useDatabase();

async function anAttention(prisma: PrismaClient, patientId?: string) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = patientId ? { id: patientId } : await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return {
    encounterId: encounter.id,
    patientId: patient.id,
    practitionerId: practitioner.id,
    userId: practitioner.userId,
  };
}

type Attention = Awaited<ReturnType<typeof anAttention>>;

const DESTINATION = {
  destinationMspUnicode: '05176',
  destinationName: 'Hospital General de Chone',
};

/** A raw insert, the way an import writes: no service in between. */
function referral(
  prisma: PrismaClient,
  at: Attention,
  data: Partial<Prisma.ReferralUncheckedCreateInput> = {},
) {
  return prisma.referral.create({
    data: {
      encounterId: at.encounterId,
      patientId: at.patientId,
      issuedById: at.practitionerId,
      direction: 'REFERRAL',
      reason: 'Valoración por cardiología',
      ...DESTINATION,
      ...data,
    },
  });
}

function counterReferral(
  prisma: PrismaClient,
  at: Attention,
  respondsToId: string | null,
) {
  return referral(prisma, at, {
    direction: 'COUNTER_REFERRAL',
    destinationMspUnicode: null,
    destinationName: null,
    respondsToId,
    reason: 'Retorno con tratamiento indicado',
  });
}

function cancel(prisma: PrismaClient, id: string, by: string) {
  return prisma.referral.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledById: by,
      cancellationReason: 'Emitida por error',
    },
  });
}

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return extractDatabaseProblem(error);
  }
  throw new Error('the operation should have failed');
}

const refusedWith = (code: string, field?: string) => ({
  code,
  ...(field ? { errors: [expect.objectContaining({ field, code })] } : {}),
});

describe('EN-100 EN-101 a dónde va una referencia', () => {
  it('EN-100 la BASE admite las cuatro direcciones, la referencia inversa incluida', async () => {
    const prisma = db();
    const at = await anAttention(prisma);

    const answered = await referral(prisma, at);
    await referral(prisma, at, { direction: 'DERIVATION' });
    await referral(prisma, at, { direction: 'REVERSE_REFERRAL' });
    await counterReferral(prisma, at, answered.id);

    expect(
      (await prisma.referral.findMany({ select: { direction: true } }))
        .map((row) => row.direction)
        .sort(),
    ).toEqual(['COUNTER_REFERRAL', 'DERIVATION', 'REFERRAL', 'REVERSE_REFERRAL']); // prettier-ignore
  });

  it('EN-101 la BASE exige UNICÓDIGO y nombre a la referencia, la derivación y la referencia inversa, sólo con números', async () => {
    const prisma = db();
    const at = await anAttention(prisma);

    for (const direction of [
      'REFERRAL',
      'DERIVATION',
      'REVERSE_REFERRAL',
    ] as const) {
      expect(
        await problemFrom(referral(prisma, at, { direction, destinationMspUnicode: null })), // prettier-ignore
      ).toMatchObject(refusedWith('VALIDATION_FAILED', 'destination'));
      expect(
        await problemFrom(referral(prisma, at, { direction, destinationName: '  ' })), // prettier-ignore
      ).toMatchObject(refusedWith('VALIDATION_FAILED', 'destination'));
    }
    expect(
      await problemFrom(referral(prisma, at, { destinationMspUnicode: 'HGCH-1' })), // prettier-ignore
    ).toMatchObject(refusedWith('VALIDATION_FAILED', 'destination.mspUnicode'));

    // Positive control: the same, with where it goes.
    await referral(prisma, at);
    expect(await prisma.referral.count()).toBe(1);
  });

  it('EN-106 la BASE exige el motivo escrito', async () => {
    const prisma = db();
    const at = await anAttention(prisma);

    expect(
      await problemFrom(referral(prisma, at, { reason: '   ' })),
    ).toMatchObject(refusedWith('VALIDATION_FAILED', 'reason'));
    await referral(prisma, at);
    expect(await prisma.referral.count()).toBe(1);
  });

  it('EN-130 la BASE rechaza la fila en una atención terminada y con otro paciente que el de su atención', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const stranger = await createPatient(prisma);

    expect(
      await problemFrom(referral(prisma, at, { patientId: stranger.id })),
    ).toMatchObject(refusedWith('VALIDATION_FAILED', 'patientId'));

    const closed = await anAttention(prisma);
    await prisma.encounter.update({
      where: { id: closed.encounterId },
      data: { status: 'ENTERED_IN_ERROR', enteredInErrorAt: new Date(), enteredInErrorById: closed.userId, endedAt: new Date() }, // prettier-ignore
    });
    expect(await problemFrom(referral(prisma, closed))).toMatchObject(
      refusedWith('ENCOUNTER_ALREADY_CLOSED'),
    );

    // Positive control: the live attention, its own patient.
    await referral(prisma, at);
    expect(await prisma.referral.count()).toBe(1);
  });
});

describe('EN-102 la contrarreferencia responde a una referencia', () => {
  it('EN-102 la BASE rechaza una contrarreferencia sin referencia y una referencia que responde a algo', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const answered = await referral(prisma, at);

    expect(await problemFrom(counterReferral(prisma, at, null))).toMatchObject(
      refusedWith('COUNTER_REFERRAL_WITHOUT_REFERRAL', 'respondsToId'),
    );
    expect(
      await problemFrom(referral(prisma, at, { respondsToId: answered.id })),
    ).toMatchObject(refusedWith('COUNTER_REFERRAL_WITHOUT_REFERRAL'));

    // Positive control.
    await counterReferral(prisma, at, answered.id);
    expect(await prisma.referral.count()).toBe(2);
  });

  it('EN-102 la BASE rechaza responder a otra contrarreferencia, a una referencia inversa, a una anulada o de otro paciente; acepta una derivación', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const other = await anAttention(prisma);

    const answered = await referral(prisma, at);
    const response = await counterReferral(prisma, at, answered.id);
    const reverse = await referral(prisma, at, { direction: 'REVERSE_REFERRAL' }); // prettier-ignore
    const annulled = await referral(prisma, at);
    await cancel(prisma, annulled.id, at.practitionerId);
    const foreign = await referral(prisma, other);

    for (const target of [response.id, reverse.id, annulled.id, foreign.id]) {
      expect(
        await problemFrom(counterReferral(prisma, at, target)),
      ).toMatchObject(refusedWith('COUNTER_REFERRAL_WITHOUT_REFERRAL'));
    }

    // Positive control: a derivation is answered too (D-191 §5).
    const derivation = await referral(prisma, at, { direction: 'DERIVATION' });
    await counterReferral(prisma, at, derivation.id);
    expect(await prisma.referral.count({ where: { direction: 'COUNTER_REFERRAL' } })).toBe(2); // prettier-ignore
  });

  it('EN-102 PA-055 responde a la referencia de la ficha que se unificó con la del paciente', async () => {
    const prisma = db();
    const absorbed = await anAttention(prisma);
    const survivor = await createPatient(prisma);
    const answered = await referral(prisma, absorbed);
    await prisma.patient.update({
      where: { id: absorbed.patientId },
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });

    const later = await anAttention(prisma, survivor.id);
    await counterReferral(prisma, later, answered.id);
    expect(await prisma.referral.count({ where: { respondsToId: answered.id } })).toBe(1); // prettier-ignore
  });

  it('EN-102 la BASE admite como mucho UNA respuesta viva: anulada la primera, se registra otra', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const answered = await referral(prisma, at);
    const first = await counterReferral(prisma, at, answered.id);

    expect(
      await problemFrom(counterReferral(prisma, at, answered.id)),
    ).toMatchObject(refusedWith('REFERRAL_ALREADY_ANSWERED', 'respondsToId'));

    // Positive control: the first one annulled, the answer can be given again.
    await cancel(prisma, first.id, at.practitionerId);
    await counterReferral(prisma, at, answered.id);
    expect(await prisma.referral.count({ where: { respondsToId: answered.id } })).toBe(2); // prettier-ignore
  });

  it('EN-102 la BASE rechaza anular una referencia con respuesta viva; anulada la respuesta, se anula', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const answered = await referral(prisma, at);
    const response = await counterReferral(prisma, at, answered.id);

    expect(
      await problemFrom(cancel(prisma, answered.id, at.practitionerId)),
    ).toMatchObject(refusedWith('REFERRAL_ALREADY_ANSWERED', 'referralId'));

    await cancel(prisma, response.id, at.practitionerId);
    await cancel(prisma, answered.id, at.practitionerId);
    expect(await prisma.referral.count({ where: { status: 'CANCELLED' } })).toBe(2); // prettier-ignore
  });
});

describe('EN-105 salir «referido» exige la referencia', () => {
  it('EN-105 la BASE rechaza la condición de egreso «Referido» sin referencia viva de la atención, y la admite con una', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const referred = () =>
      prisma.encounter.update({
        where: { id: at.encounterId },
        data: { dischargeCondition: 'REFERRED' },
      });

    expect(await problemFrom(referred())).toMatchObject(
      refusedWith('REFERRAL_REQUIRED_ON_DISCHARGE', 'dischargeCondition'),
    );

    // An annulled referral and a counter-referral do not send anybody.
    const annulled = await referral(prisma, at);
    await cancel(prisma, annulled.id, at.practitionerId);
    const elsewhere = await anAttention(prisma, at.patientId);
    const answered = await referral(prisma, elsewhere);
    await counterReferral(prisma, at, answered.id);
    expect(await problemFrom(referred())).toMatchObject(
      refusedWith('REFERRAL_REQUIRED_ON_DISCHARGE'),
    );

    // Positive control: a reverse referral standing in the attention.
    await referral(prisma, at, { direction: 'REVERSE_REFERRAL' });
    await referred();
    expect(
      (await prisma.encounter.findUniqueOrThrow({ where: { id: at.encounterId } })) // prettier-ignore
      .dischargeCondition,
    ).toBe('REFERRED');
  });

  it('EN-105 la BASE rechaza anular la última referencia de una atención que salió «referida», y deja anular otra si queda una', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const first = await referral(prisma, at);
    await prisma.encounter.update({
      where: { id: at.encounterId },
      data: { dischargeCondition: 'REFERRED' },
    });

    expect(
      await problemFrom(cancel(prisma, first.id, at.practitionerId)),
    ).toMatchObject(refusedWith('REFERRAL_REQUIRED_ON_DISCHARGE'));

    // Positive control: with a second standing, the first is annulled.
    await referral(prisma, at, { direction: 'DERIVATION' });
    await cancel(prisma, first.id, at.practitionerId);
    expect(await prisma.referral.count({ where: { status: 'CANCELLED' } })).toBe(1); // prettier-ignore
  });
});

describe('EN-107 nada se borra ni se reescribe', () => {
  it('EN-107 la BASE rechaza borrar una referencia o una interconsulta y cambiar lo emitido; cuenta las filas', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const issued = await referral(prisma, at);
    const asked = await prisma.interconsultation.create({
      data: {
        encounterId: at.encounterId,
        role: 'REQUESTED',
        requestedById: at.practitionerId,
        reason: 'Opinión de cardiología',
      },
    });

    expect(await problemFrom(prisma.referral.delete({ where: { id: issued.id } }))).toBeDefined(); // prettier-ignore
    expect(await problemFrom(prisma.interconsultation.delete({ where: { id: asked.id } }))).toBeDefined(); // prettier-ignore
    expect(
      await problemFrom(
        prisma.referral.update({ where: { id: issued.id }, data: { reason: 'Otro motivo' } }), // prettier-ignore
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await problemFrom(
        prisma.interconsultation.update({ where: { id: asked.id }, data: { reason: 'Otro' } }), // prettier-ignore
      ),
    ).toMatchObject({ status: 409 });
    expect(await prisma.referral.count()).toBe(1);
    expect(await prisma.interconsultation.count()).toBe(1);
    expect((await prisma.referral.findUniqueOrThrow({ where: { id: issued.id } })).reason).toBe('Valoración por cardiología'); // prettier-ignore

    // Positive control: what may change, changes —the state, to annul it.
    await cancel(prisma, issued.id, at.practitionerId);
    expect(
      (await prisma.referral.findUniqueOrThrow({ where: { id: issued.id } })).status, // prettier-ignore
    ).toBe('CANCELLED');
  });

  it('EN-107 la BASE exige quién, cuándo y por qué al anular, y que lo anulado no cambie más', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const issued = await referral(prisma, at);

    expect(
      await problemFrom(
        prisma.referral.update({ where: { id: issued.id }, data: { status: 'CANCELLED' } }), // prettier-ignore
      ),
    ).toMatchObject(refusedWith('VALIDATION_FAILED', 'reason'));
    expect(
      await problemFrom(
        prisma.referral.update({
          where: { id: issued.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: at.practitionerId, cancellationReason: ' ' }, // prettier-ignore
        }),
      ),
    ).toMatchObject(refusedWith('VALIDATION_FAILED', 'reason'));

    await cancel(prisma, issued.id, at.practitionerId);
    expect(
      await problemFrom(
        prisma.referral.update({ where: { id: issued.id }, data: { status: 'ISSUED', cancelledAt: null, cancelledById: null, cancellationReason: null } }), // prettier-ignore
      ),
    ).toMatchObject({ status: 409 });
  });
});

describe('EN-103 la interconsulta solicitada o recibida', () => {
  it('EN-103 la BASE exige a la solicitada quién la pide, y a la recibida quién la pidió, quién responde y la respuesta', async () => {
    const prisma = db();
    const at = await anAttention(prisma);
    const now = new Date();
    const received = (
      data: Partial<Prisma.InterconsultationUncheckedCreateInput>,
    ) =>
      // prettier-ignore
      prisma.interconsultation.create({
        data: {
          encounterId: at.encounterId,
          role: 'RECEIVED',
          status: 'ANSWERED',
          requestedByName: 'Medicina interna, Hospital del IESS',
          respondedById: at.practitionerId,
          respondedAt: now,
          reason: 'Valorar soplo',
          opinion: 'Soplo funcional; sin tratamiento',
          ...data,
        },
      });

    expect(
      await problemFrom(
        prisma.interconsultation.create({
          data: { encounterId: at.encounterId, role: 'REQUESTED', reason: 'Valorar soplo' }, // prettier-ignore
        }),
      ),
    ).toMatchObject(refusedWith('VALIDATION_FAILED', 'role'));
    for (const missing of [
      { requestedByName: null },
      { opinion: '  ' },
      { respondedById: null },
      { status: 'REQUESTED' as const },
      { requestedById: at.practitionerId },
    ]) {
      expect(await problemFrom(received(missing))).toMatchObject(
        refusedWith('VALIDATION_FAILED', 'role'),
      );
    }

    // Positive control: each said properly.
    await received({});
    await prisma.interconsultation.create({
      data: {
        encounterId: at.encounterId,
        role: 'REQUESTED',
        requestedById: at.practitionerId,
        reason: 'Valorar soplo',
      },
    });
    expect(await prisma.interconsultation.count()).toBe(2);
  });
});
