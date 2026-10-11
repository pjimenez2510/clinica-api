import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Minimum rows needed before anything clinical can exist.
 *
 * Deliberately NOT a full seed: a fixture that creates everything hides which
 * relationship a test actually depends on, and makes a failure ambiguous.
 *
 * Every cedula here has a REAL check digit, computed with the modulus-10
 * algorithm. The database rejects invalid ones via `is_valid_cedula()`, so a
 * made-up number would fail for the wrong reason and send someone chasing a
 * bug that does not exist.
 */

let sequence = 0;
/** Unique per call, without Math.random: a failing test must be reproducible. */
function next(): string {
  sequence += 1;
  return String(sequence).padStart(6, '0');
}

/**
 * OR-032. The establishment every site belongs to: the one already registered
 * in this database, or a new one. One per database, as in a clinic.
 */
export async function establishmentId(prisma: PrismaClient): Promise<string> {
  // The oldest: a test that registers a second one keeps its sites on the
  // first, deterministically.
  const existing = await prisma.establishment.findFirst({
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (existing) return existing.id;
  const created = await prisma.establishment.create({
    data: {
      mspUnicode: `E${next()}`,
      typology: 'Consultorio de especialidad',
      legalName: 'Clínica de Pruebas S.A.',
    },
    select: { id: true },
  });
  return created.id;
}

export async function createSite(prisma: PrismaClient, name = 'Sede Central') {
  return prisma.site.create({
    data: {
      mspUnicode: `U${next()}`,
      name,
      establishmentId: await establishmentId(prisma),
    },
  });
}

/**
 * D-021. Sets what the site dices its day into.
 *
 * A SEPARATE CALL AND NOT A FIELD OF `createSite`, for the same reason
 * `linkPractitionerToSite` is separate: `trg_site_parameter_defaults` writes
 * the row of D-001 on insert (CF-062), so the grid a test operates on is
 * always a deliberate departure from the ten minutes the clinic ships with —
 * and a test that changes it should say so on the line that changes it.
 */
export async function setSlotAtom(
  prisma: PrismaClient,
  siteId: string,
  slotAtomMinutes: number,
) {
  return prisma.siteParameter.update({
    where: { siteId },
    data: { slotAtomMinutes },
  });
}

export async function createRoom(prisma: PrismaClient, siteId: string) {
  return prisma.siteRoom.create({
    data: { siteId, name: `Consultorio ${next()}` },
  });
}

/**
 * An account with no role, for the columns that only need somebody behind a
 * datum (EN-086, EN-143, EN-085): who recorded an allergy, a history entry or
 * a vital sign.
 */
export async function createUser(prisma: PrismaClient) {
  return prisma.user.create({
    data: {
      email: `autor${next()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Carmen',
      lastName: 'Salazar',
    },
  });
}

export async function createPractitioner(prisma: PrismaClient) {
  const user = await prisma.user.create({
    data: {
      email: `medico${next()}@clinica.ec`,
      // Not a real hash: no test here exercises verification, and putting a
      // valid Argon2 hash would suggest otherwise.
      passwordHash: 'not-a-real-hash',
      firstName: 'Ana',
      lastName: 'Villacís',
    },
  });
  return prisma.practitioner.create({ data: { userId: user.id } });
}

export async function createPatient(
  prisma: PrismaClient,
  overrides: { birthDate?: Date; sex?: 'MALE' | 'FEMALE' } = {},
) {
  return prisma.patient.create({
    data: {
      mrn: `HC${next()}`,
      familyName: 'Guamán',
      givenName: 'María',
      sex: overrides.sex ?? 'FEMALE',
      birthDate: overrides.birthDate ?? new Date('1990-03-15'),
    },
  });
}

/**
 * Links a practitioner to a site.
 *
 * AG-014: without the row, no slot of theirs is offered at that site and no
 * appointment is admitted. It is a separate call on purpose — a fixture that
 * created it silently would hide the requirement it exists for.
 */
export async function linkPractitionerToSite(
  prisma: PrismaClient,
  practitionerId: string,
  siteId: string,
) {
  return prisma.practitionerSite.create({ data: { practitionerId, siteId } });
}

/**
 * A weekly schedule rule, in WALL CLOCK time.
 *
 * `start_time` and `end_time` are `time` columns — the one deliberate
 * exception to timestamptz — so they are written as a Date pinned to
 * 1970-01-01 whose UTC parts ARE the wall clock. Writing them with local
 * getters would shift the rule by the host's offset, which is the bug
 * `WallClockTime.fromTimeColumn` exists to avoid on the way back.
 */
export async function createScheduleRule(
  prisma: PrismaClient,
  ids: { practitionerId: string; siteId: string },
  rule: {
    /** ISO-8601: 1 = Monday .. 7 = Sunday. */
    weekday: number;
    startTime: string;
    endTime: string;
    validFrom?: Date;
    validTo?: Date | null;
    active?: boolean;
  },
) {
  return prisma.practitionerScheduleRule.create({
    data: {
      ...ids,
      weekday: rule.weekday,
      startTime: new Date(`1970-01-01T${rule.startTime}:00Z`),
      endTime: new Date(`1970-01-01T${rule.endTime}:00Z`),
      validFrom: rule.validFrom ?? new Date('2026-01-01T00:00:00Z'),
      validTo: rule.validTo ?? null,
      active: rule.active ?? true,
    },
  });
}

export async function createEncounter(
  prisma: PrismaClient,
  ids: {
    siteId: string;
    practitionerId: string;
    patientId: string;
    /** AG-045: set to hang the encounter off an appointment. */
    agendaEntryId?: string;
    /** When the age frozen on the encounter matters (ORD-036). */
    startedAt?: Date;
  },
) {
  return prisma.encounter.create({
    data: {
      // fecha-fija: an instant in the past, whatever today is; the age it
      // freezes (ORD-036) follows from `createPatient`'s fixed birth date.
      // Pass `startedAt` when the test is about the age.
      startedAt: new Date('2026-09-14T14:00:00Z'),
      ...ids,
      // Both are required, and on purpose: the RDACAA report demands them for
      // every single consultation. Making them optional would let a record be
      // created that the Ministry then rejects, months later.
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });
}

/**
 * A CIE-10 diagnosis on an attention, its concept made if missing. Ranked
 * after the ones already there: 1, the principal, is unique per attention.
 */
export async function createDiagnosis(
  prisma: PrismaClient,
  encounterId: string,
  code: string,
  display = `Diagnóstico ${code}`,
) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: 'CIE10' },
    create: { code: 'CIE10', name: 'CIE-10' },
    update: {},
  });
  const concept =
    (await prisma.catalogConcept.findFirst({
      where: { systemId: system.id, code },
    })) ??
    (await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code,
        display,
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    }));
  await prisma.encounterDiagnosis.create({
    data: {
      encounterId,
      conceptId: concept.id,
      cie10Code: code,
      cie10Display: concept.display,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      // 1 is the principal diagnosis, unique per attention: the next ones follow.
      rank: (await prisma.encounterDiagnosis.count({ where: { encounterId } })) + 1, // prettier-ignore
    },
  });
}

/**
 * EN-240 (D-188 §7). Answers block F of an attention — «No se aplicó» —, as
 * the doctor does before signing the 002 that discharges:
 * `trg_clinical_note_sign_needs_screening` refuses that signature without an
 * answer, and a test that signs straight in the database answers it first.
 * The rule is not weakened for tests. Call it while the attention is live:
 * `trg_violence_screening_guard` freezes block F with the discharge.
 * Idempotent: an attention already answered keeps its answer.
 */
export async function answerScreening(
  prisma: PrismaClient,
  encounterId: string,
  screenedById: string,
) {
  const answered = await prisma.violenceScreening.count({
    where: { encounterId },
  });
  if (answered > 0) return;
  await prisma.violenceScreening.create({
    data: {
      encounterId,
      result: 'NOT_APPLIED',
      screenedById,
      screenedAt: new Date(),
    },
  });
}

/** An hour of appointment, in UTC so the assertion does not depend on the host. */
export function hourSlot(hour: number): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(Date.UTC(2026, 8, 14, hour, 0, 0)),
    endsAt: new Date(Date.UTC(2026, 8, 14, hour + 1, 0, 0)),
  };
}

/**
 * PR-020, PR-038. A receta ALREADY ISSUED, with its lines: born a draft with
 * them and issued afterwards, as the code does it. The lines of an issued
 * receta never change (`prescription_frozen`), not even to be added at birth.
 */
export async function createIssuedPrescription(
  prisma: PrismaClient,
  data: Prisma.PrescriptionUncheckedCreateInput,
) {
  const {
    status = 'ACTIVE',
    issuedAt = new Date(),
    verificationCode = null,
    cancelledAt,
    cancelledById,
    cancelReason,
    ...draft
  } = data;
  const created = await prisma.prescription.create({
    data: { ...draft, status: 'DRAFT', issuedAt: null, verificationCode: null },
  });
  // PR-108. An annulled one carries the register of art. 70, or the database
  // refuses it (`prescription_cancel_states_who_when_and_why`).
  const cancellation =
    status === 'CANCELLED'
      ? {
          cancelledAt: cancelledAt ?? new Date(),
          cancelledById: cancelledById ?? (await createUser(prisma)).id,
          cancelReason: cancelReason ?? 'Pérdida',
        }
      : {};
  return prisma.prescription.update({
    where: { id: created.id },
    data: { status, issuedAt, verificationCode, ...cancellation },
    include: { items: true },
  });
}

/**
 * BI-278 (ADR-013). A service of the catalogue, with the 0 % rate created the
 * first time a test asks and reused after — `useDatabase` truncates it
 * between tests. A consultation needs its specialty and duration
 * (`service_consultation_shape`); pass them.
 */
export async function createService(
  prisma: PrismaClient,
  service: {
    code: string;
    name: string;
    kind:
      | 'CONSULTATION'
      | 'PROCEDURE'
      | 'LAB_EXAM'
      | 'IMAGING'
      | 'SUPPLY'
      | 'OTHER';
    mspCode?: string | null;
    specialtyId?: string;
    durationMinutes?: number;
    visitKind?: 'FIRST_VISIT' | 'FOLLOW_UP' | null;
    active?: boolean;
  },
) {
  const taxRate =
    (await prisma.taxRate.findFirst({ where: { sriCode: '0' } })) ??
    (await prisma.taxRate.create({
      data: {
        sriCode: '0',
        name: '0%',
        percentage: '0',
        validFrom: new Date('2000-01-01T00:00:00Z'), // fecha-fija: vigente desde antes de toda prueba
      },
    }));
  return prisma.service.create({
    data: {
      code: service.code,
      name: service.name,
      kind: service.kind,
      mspCode: service.mspCode ?? null,
      specialtyId: service.specialtyId ?? null,
      durationMinutes: service.durationMinutes ?? null,
      visitKind: service.visitKind ?? null,
      active: service.active ?? true,
      taxRateId: taxRate.id,
    },
  });
}

/**
 * BI-284. An ordered service: the service and its order extension, which is
 * what makes it orderable (ORD-010). Laboratory unless told otherwise; the
 * extension's fields default to the table's.
 */
export async function createExamService(
  prisma: PrismaClient,
  service: {
    code: string;
    name: string;
    mspCode?: string | null;
    kind?: 'LAB_EXAM' | 'IMAGING' | 'PROCEDURE';
    active?: boolean;
    exam?: Partial<{
      form010Section: string | null;
      specimenType: string | null;
      patientPreparation: string | null;
      turnaroundHours: number | null;
      requiresFasting: boolean;
      fastingHours: number | null;
      performedExternally: boolean;
    }>;
  },
) {
  const created = await createService(prisma, {
    code: service.code,
    name: service.name,
    kind: service.kind ?? 'LAB_EXAM',
    mspCode: service.mspCode,
    active: service.active,
  });
  await prisma.serviceExam.create({
    data: { serviceId: created.id, ...(service.exam ?? {}) },
  });
  return created;
}

/** SP-001. A specialty, by name. */
export async function createSpecialty(
  prisma: PrismaClient,
  name = 'Cardiología',
) {
  return prisma.specialty.create({
    data: { code: name.toUpperCase().slice(0, 64), name },
  });
}

/**
 * EN-131, BI-236 (D-184). Closes an attention the only way there is: caja
 * settles its account, and the database closes the attention that already
 * has its discharge, with that account's instant and author. Nothing here
 * writes `COMPLETED`: `trg_patient_account_closes_its_encounter` does.
 *
 * An attention still `OPEN` is given its discharge first, an hour after it
 * started: only the state and its condition, no 002 is signed, so the trail's
 * NOTE_SIGNED row has no author. Meant for attentions with nothing invoiced:
 * the reason it is not charged (BI-237) is stated only when no charge is
 * BILLED. Any account the attention already had open is the one settled (one
 * per attention, `patient_account_one_open_per_encounter`), since one left
 * open keeps the attention waiting. The cashier is a fresh user; its role
 * does not matter to the database.
 *
 * Throws when the attention did not close: a draft order keeps it waiting
 * for its doctor (D-189), and a test that expected it closed must not go on
 * believing it is.
 */
export async function closeThroughCashier(
  prisma: PrismaClient,
  encounterId: string,
) {
  let encounter = await prisma.encounter.findUniqueOrThrow({
    where: { id: encounterId },
  });
  if (encounter.status !== 'OPEN' && encounter.status !== 'DISCHARGED') {
    throw new Error(
      `closeThroughCashier: an attention ${encounter.status} is not closed by caja`,
    );
  }
  if (encounter.status === 'OPEN') {
    encounter = await prisma.encounter.update({
      where: { id: encounterId },
      data: {
        status: 'DISCHARGED',
        endedAt: new Date(encounter.startedAt.getTime() + 3_600_000),
        dischargeCondition: 'ALIVE',
      },
    });
  }
  const payer = await prisma.payer.upsert({
    where: { code: 'PARTICULAR' },
    update: {},
    create: { code: 'PARTICULAR', name: 'Particular', kind: 'SELF_PAY' },
  });
  const priceList =
    (await prisma.priceList.findFirst({ where: { payerId: payer.id } })) ??
    (await prisma.priceList.create({
      data: { payerId: payer.id, name: 'Vigente' },
    }));
  const open = await prisma.patientAccount.findMany({
    where: { encounterId, status: 'OPEN' },
  });
  const accounts = open.length
    ? open
    : [
        await prisma.patientAccount.create({
          data: {
            patientId: encounter.patientId,
            siteId: encounter.siteId,
            encounterId,
            payerId: payer.id,
            priceListId: priceList.id,
          },
        }),
      ];
  const cashier = await createUser(prisma);
  // The app's clock, never before the discharge it closes.
  const closedAt = new Date(
    Math.max(Date.now(), encounter.endedAt?.getTime() ?? 0),
  );
  for (const account of accounts) {
    const billed = await prisma.chargeItem.count({
      where: { accountId: account.id, status: 'BILLED' },
    });
    await prisma.patientAccount.update({
      where: { id: account.id },
      data: {
        status: 'SETTLED',
        closedAt,
        changedById: cashier.id,
        changedAt: closedAt,
        noChargeReason: billed ? undefined : 'Atención sin cargo',
      },
    });
  }
  const closed = await prisma.encounter.findUniqueOrThrow({
    where: { id: encounterId },
  });
  if (closed.status !== 'COMPLETED') {
    throw new Error(
      `closeThroughCashier: the attention stayed ${closed.status} (a draft order keeps it waiting, D-189)`,
    );
  }
  return { encounter: closed, cashierId: cashier.id, closedAt };
}

/**
 * BI-279 (ADR-013). A consultation: a service of kind CONSULTATION with its
 * specialty, duration and visit, under a code no other call reuses. Its NAME
 * must be unique among active services clinic-wide
 * (`service_active_name_unique`), so two specialties cannot both have an
 * active «Control»: the caller names them apart.
 */
export async function createConsultation(
  prisma: PrismaClient,
  consultation: {
    specialtyId: string;
    name: string;
    durationMinutes?: number;
    visitKind?: 'FIRST_VISIT' | 'FOLLOW_UP' | null;
    active?: boolean;
  },
) {
  return createService(prisma, {
    code: `CONS-T${next()}`,
    name: consultation.name,
    kind: 'CONSULTATION',
    specialtyId: consultation.specialtyId,
    durationMinutes: consultation.durationMinutes ?? 20,
    visitKind: consultation.visitKind ?? null,
    active: consultation.active,
  });
}
