import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { chartScope } from '../../../shared/infrastructure/prisma/patient-chart-scope';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { EncounterStatus } from '../domain/encounter';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  ReferralAlreadyCancelledError,
  ReferralNotFoundError,
} from '../domain/encounter.errors';
import type {
  EncounterQuery,
  SiteScopeFilter,
} from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import {
  ACT_FORM_VERSION,
  ANSWERABLE_DIRECTIONS,
  INTERCONSULTATION_FORM_CODE,
  REFERRAL_FORM_CODE,
  type DiagnosisAtIssue,
  type InterconsultationDraft,
  type ReferralDraft,
} from '../domain/referral';
import type {
  AnswerableReferral,
  FormNoteSignature,
  InterconsultationView,
  IssueAuthor,
  IssueContext,
  ReferralRepository,
  ReferralSheet,
  ReferralView,
} from '../domain/referral.repository';

const NAME = { select: { user: { select: { firstName: true, lastName: true } } } } as const; // prettier-ignore

const REFERRAL_SELECT = {
  id: true,
  encounterId: true,
  direction: true,
  status: true,
  destinationMspUnicode: true,
  destinationName: true,
  specialty: { select: { id: true, name: true } },
  priority: true,
  reason: true,
  summary: true,
  respondsToId: true,
  responses: {
    where: { status: { not: 'CANCELLED' } },
    select: { id: true },
    take: 1,
  },
  clinicalNoteId: true,
  issuedById: true,
  issuedBy: NAME,
  issuedAt: true,
  cancelledAt: true,
  cancelledBy: NAME,
  cancellationReason: true,
} satisfies Prisma.ReferralSelect;

type ReferralRow = Prisma.ReferralGetPayload<{ select: typeof REFERRAL_SELECT }>; // prettier-ignore

const INTERCONSULTATION_SELECT = {
  id: true,
  encounterId: true,
  role: true,
  status: true,
  specialty: { select: { id: true, name: true } },
  requestedBy: NAME,
  requestedByName: true,
  reason: true,
  findings: true,
  opinion: true,
  respondedBy: NAME,
  clinicalNoteId: true,
  requestedAt: true,
  cancelledAt: true,
  cancelledBy: NAME,
  cancellationReason: true,
} satisfies Prisma.InterconsultationSelect;

type InterconsultationRow = Prisma.InterconsultationGetPayload<{
  select: typeof INTERCONSULTATION_SELECT;
}>;

/**
 * encounter H8 (EN-100 to EN-107). `trg_referral_guard`,
 * `trg_interconsultation_guard`, `referral_one_live_response` and the CHECKs
 * of `20261008230100_referral_interconsultation_h8` are the guarantee; this
 * adapter takes the attention's lock and writes each act with its 053 or 007.
 */
@Injectable()
export class PrismaReferralRepository implements ReferralRepository {
  constructor(private readonly prisma: PrismaService) {}

  async sheetOf(query: EncounterQuery): Promise<ReferralSheet | null> {
    const encounter = await this.prisma.encounter.findFirst({
      where: { id: query.encounterId, ...siteFilter(query.sites) },
      select: { id: true, patientId: true },
    });
    if (!encounter) return null;

    const [referrals, interconsultations, answerable, specialties] =
      await Promise.all([
        this.prisma.referral.findMany({
          where: { encounterId: encounter.id },
          select: REFERRAL_SELECT,
          orderBy: { issuedAt: 'asc' },
        }),
        this.prisma.interconsultation.findMany({
          where: { encounterId: encounter.id },
          select: INTERCONSULTATION_SELECT,
          orderBy: { requestedAt: 'asc' },
        }),
        this.prisma.referral.findMany({
          where: {
            // PA-055. The person's referrals, from any of her charts.
            ...chartScope(encounter.patientId),
            direction: { in: [...ANSWERABLE_DIRECTIONS] },
            status: { not: 'CANCELLED' },
            responses: { none: { status: { not: 'CANCELLED' } } },
            encounter: siteFilter(query.sites),
          },
          select: {
            id: true,
            direction: true,
            destinationName: true,
            reason: true,
            issuedAt: true,
          },
          orderBy: { issuedAt: 'desc' },
          take: 20,
        }),
        this.prisma.specialty.findMany({
          where: { active: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);

    return {
      referrals: referrals.map(toReferralView),
      interconsultations: interconsultations.map(toInterconsultationView),
      answerable: answerable.map((row): AnswerableReferral => ({
        id: row.id,
        direction: row.direction,
        destinationName: row.destinationName,
        reason: row.reason,
        issuedAt: row.issuedAt,
      })),
      specialties,
    };
  }

  async issueReferral(
    query: EncounterQuery,
    draft: ReferralDraft,
    author: IssueAuthor,
    sign: (context: IssueContext) => FormNoteSignature,
  ): Promise<ReferralView> {
    return this.prisma.$transaction(async (tx) => {
      const encounter = await lockLive(tx, query);
      const answered = draft.respondsToId
        ? await tx.referral.findFirst({
            where: { id: draft.respondsToId, encounter: siteFilter(query.sites) }, // prettier-ignore
            select: { issuedAt: true, destinationName: true, reason: true },
          })
        : null;
      const context: IssueContext = {
        specialtyName: await specialtyNameOf(tx, draft.specialtyId),
        diagnoses: await diagnosesOf(tx, encounter.id),
        answered: answered && {
          issuedOn: ecuadorianDate(answered.issuedAt),
          destinationName: answered.destinationName,
          reason: answered.reason,
        },
      };

      const noteId = await writeFormNote(
        tx,
        encounter.id,
        REFERRAL_FORM_CODE,
        sign(context),
        author,
      );
      const created = await tx.referral.create({
        data: {
          encounterId: encounter.id,
          patientId: encounter.patientId,
          issuedById: author.practitionerId,
          direction: draft.direction,
          destinationMspUnicode: draft.destination?.mspUnicode ?? null,
          destinationName: draft.destination?.name ?? null,
          specialtyId: draft.specialtyId,
          priority: draft.priority,
          reason: draft.reason,
          summary: draft.summary,
          respondsToId: draft.respondsToId,
          clinicalNoteId: noteId,
          issuedAt: author.at,
        },
        select: REFERRAL_SELECT,
      });
      return toReferralView(created);
    });
  }

  async issueInterconsultation(
    query: EncounterQuery,
    draft: InterconsultationDraft,
    author: IssueAuthor,
    sign:
      | ((
          context: Pick<IssueContext, 'specialtyName' | 'diagnoses'>,
        ) => FormNoteSignature)
      | null,
  ): Promise<InterconsultationView> {
    return this.prisma.$transaction(async (tx) => {
      const encounter = await lockLive(tx, query);

      if (draft.role === 'RECEIVED') {
        const created = await tx.interconsultation.create({
          data: {
            encounterId: encounter.id,
            role: 'RECEIVED',
            status: 'ANSWERED',
            requestedByName: draft.requestedByName,
            reason: draft.reason,
            findings: draft.findings,
            opinion: draft.opinion,
            respondedById: author.practitionerId,
            requestedAt: author.at,
            respondedAt: author.at,
          },
          select: INTERCONSULTATION_SELECT,
        });
        return toInterconsultationView(created);
      }

      const noteId = sign
        ? await writeFormNote(
            tx,
            encounter.id,
            INTERCONSULTATION_FORM_CODE,
            sign({
              specialtyName: await specialtyNameOf(tx, draft.specialtyId),
              diagnoses: await diagnosesOf(tx, encounter.id),
            }),
            author,
          )
        : null;
      const created = await tx.interconsultation.create({
        data: {
          encounterId: encounter.id,
          role: 'REQUESTED',
          status: 'REQUESTED',
          requestedById: author.practitionerId,
          specialtyId: draft.specialtyId,
          reason: draft.reason,
          findings: draft.findings,
          clinicalNoteId: noteId,
          requestedAt: author.at,
        },
        select: INTERCONSULTATION_SELECT,
      });
      return toInterconsultationView(created);
    });
  }

  async cancelReferral(
    query: EncounterQuery & { referralId: string },
    by: IssueAuthor,
    reason: string,
  ): Promise<ReferralView> {
    return this.prisma.$transaction(async (tx) => {
      await lockInScope(tx, query);
      const found = await tx.referral.findFirst({
        where: { id: query.referralId, encounterId: query.encounterId },
        select: { status: true, clinicalNoteId: true },
      });
      if (!found) throw new ReferralNotFoundError();
      if (found.status === 'CANCELLED')
        throw new ReferralAlreadyCancelledError();

      // EN-102, EN-105: `trg_referral_guard` refuses an answered referral and
      // the last one of a «referred» discharge, with their sentences.
      const updated = await tx.referral.update({
        where: { id: query.referralId },
        data: {
          status: 'CANCELLED',
          cancelledAt: by.at,
          cancelledById: by.practitionerId,
          cancellationReason: reason,
        },
        select: REFERRAL_SELECT,
      });
      await retractFormNote(tx, found.clinicalNoteId);
      return toReferralView(updated);
    });
  }

  async cancelInterconsultation(
    query: EncounterQuery & { interconsultationId: string },
    by: IssueAuthor,
    reason: string,
  ): Promise<InterconsultationView> {
    return this.prisma.$transaction(async (tx) => {
      await lockInScope(tx, query);
      const found = await tx.interconsultation.findFirst({
        where: { id: query.interconsultationId, encounterId: query.encounterId }, // prettier-ignore
        select: { status: true, clinicalNoteId: true },
      });
      if (!found) throw new ReferralNotFoundError();
      if (found.status === 'CANCELLED')
        throw new ReferralAlreadyCancelledError();

      const updated = await tx.interconsultation.update({
        where: { id: query.interconsultationId },
        data: {
          status: 'CANCELLED',
          cancelledAt: by.at,
          cancelledById: by.practitionerId,
          cancellationReason: reason,
        },
        select: INTERCONSULTATION_SELECT,
      });
      await retractFormNote(tx, found.clinicalNoteId);
      return toInterconsultationView(updated);
    });
  }
}

/**
 * EN-130. The attention, in scope, under the lock the signature takes, and
 * live: a discharge that landed after the service's read is refused here, and
 * a signature waiting on this lock sees the referral (EN-105).
 */
async function lockLive(
  tx: Prisma.TransactionClient,
  query: EncounterQuery,
): Promise<{ id: string; patientId: string }> {
  const locked = await lockInScope(tx, query);
  if (!acceptsNewClinicalContent(locked.status)) {
    throw new EncounterAlreadyClosedError(locked.status);
  }
  return locked;
}

async function lockInScope(
  tx: Prisma.TransactionClient,
  query: EncounterQuery,
): Promise<{ id: string; patientId: string; status: EncounterStatus }> {
  const inScope = await tx.encounter.findFirst({
    where: { id: query.encounterId, ...siteFilter(query.sites) },
    select: { id: true },
  });
  if (!inScope) throw new EncounterNotFoundError();
  const [locked] = await tx.$queryRaw<
    { id: string; patientId: string; status: EncounterStatus }[]
  >`
    SELECT "id"::text AS "id", "patient_id"::text AS "patientId",
           "status"::text AS "status"
      FROM "encounter"
     WHERE "id" = ${query.encounterId}::uuid
       FOR UPDATE`;
  if (!locked) throw new EncounterNotFoundError();
  return locked;
}

/**
 * EN-104. The 053 or 007, born SIGNED with what was issued: version 1 of its
 * own chain, like an amendment is born signed (EN-025). The signature method
 * is stamped by `a_clinical_note_signature_states_its_method`.
 */
async function writeFormNote(
  tx: Prisma.TransactionClient,
  encounterId: string,
  formCode: string,
  signature: FormNoteSignature,
  author: IssueAuthor,
): Promise<string> {
  const [generated] = await tx.$queryRaw<{ id: string }[]>`
    SELECT uuidv7()::text AS id`;
  const id = generated?.id;
  if (id === undefined) throw new Error('uuidv7() is unavailable in this database'); // prettier-ignore

  await tx.clinicalNote.create({
    data: {
      id,
      chainId: id,
      version: 1,
      encounterId,
      formCode,
      formVersion: ACT_FORM_VERSION,
      status: 'SIGNED',
      content: signature.content as Prisma.InputJsonObject,
      authorId: author.practitionerId,
      signedById: author.practitionerId,
      signedAt: author.at,
      contentHash: signature.contentHash,
      createdAt: author.at,
    },
    select: { id: true },
  });
  return id;
}

/**
 * EN-107. The paper of an annulled act says so: its note leaves the record
 * as `ENTERED_IN_ERROR`, the one change `trg_clinical_note_immutable` admits.
 */
async function retractFormNote(
  tx: Prisma.TransactionClient,
  noteId: string | null,
): Promise<void> {
  if (noteId === null) return;
  await tx.clinicalNote.updateMany({
    where: { id: noteId, status: 'SIGNED' },
    data: { status: 'ENTERED_IN_ERROR' },
  });
}

async function specialtyNameOf(
  tx: Prisma.TransactionClient,
  specialtyId: string | null,
): Promise<string | null> {
  if (specialtyId === null) return null;
  const row = await tx.specialty.findUnique({
    where: { id: specialtyId },
    select: { name: true },
  });
  // An unknown id is refused by the foreign key, with its own sentence.
  return row?.name ?? null;
}

/** EN-104. The attention's diagnoses as they stand when the paper is issued. */
async function diagnosesOf(
  tx: Prisma.TransactionClient,
  encounterId: string,
): Promise<DiagnosisAtIssue[]> {
  const rows = await tx.encounterDiagnosis.findMany({
    where: { encounterId },
    select: { cie10Code: true, cie10Display: true, rank: true },
    orderBy: [{ rank: 'asc' }, { recordedAt: 'asc' }],
  });
  return rows.map((row) => ({
    code: row.cie10Code,
    display: row.cie10Display,
    principal: row.rank === 1,
  }));
}

/** The clinical date of an instant, in Ecuador, as the paper prints it. */
function ecuadorianDate(instant: Date): string {
  return new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(instant);
}

/** EN-121. The caller's resolved scope as a `where` fragment. */
function siteFilter(sites: SiteScopeFilter): Prisma.EncounterWhereInput {
  return sites === 'all' ? {} : { siteId: { in: [...sites] } };
}

function nameOf(
  practitioner: { user: { firstName: string; lastName: string } } | null,
): string | null {
  return practitioner
    ? `${practitioner.user.firstName} ${practitioner.user.lastName}`
    : null;
}

function cancellationOf(row: {
  cancelledAt: Date | null;
  cancelledBy: { user: { firstName: string; lastName: string } } | null;
  cancellationReason: string | null;
}) {
  return row.cancelledAt && row.cancellationReason
    ? {
        at: row.cancelledAt,
        byName: nameOf(row.cancelledBy) ?? '',
        reason: row.cancellationReason,
      }
    : null;
}

function toReferralView(row: ReferralRow): ReferralView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    direction: row.direction,
    status: row.status,
    destination:
      row.destinationMspUnicode !== null && row.destinationName !== null
        ? { mspUnicode: row.destinationMspUnicode, name: row.destinationName }
        : null,
    specialty: row.specialty,
    priority: row.priority,
    reason: row.reason,
    summary: row.summary,
    respondsToId: row.respondsToId,
    answeredById: row.responses[0]?.id ?? null,
    clinicalNoteId: row.clinicalNoteId,
    issuedBy: {
      practitionerId: row.issuedById,
      name: nameOf(row.issuedBy) ?? '',
    },
    issuedAt: row.issuedAt,
    cancellation: cancellationOf(row),
  };
}

function toInterconsultationView(
  row: InterconsultationRow,
): InterconsultationView {
  return {
    id: row.id,
    encounterId: row.encounterId,
    role: row.role,
    status: row.status,
    specialty: row.specialty,
    requestedByName: row.requestedByName ?? nameOf(row.requestedBy),
    reason: row.reason,
    findings: row.findings,
    opinion: row.opinion,
    respondedByName: nameOf(row.respondedBy),
    clinicalNoteId: row.clinicalNoteId,
    requestedAt: row.requestedAt,
    cancellation: cancellationOf(row),
  };
}
