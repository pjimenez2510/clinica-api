import type { Prisma } from '@prisma/client';

import {
  ConsentRepresentativeRequiredError,
  ConsentRequiredError,
  ConsentSignedAfterProcedureError,
} from '../domain/encounter.errors';
import {
  consentProblem,
  type ConsentExceptionKind,
  type ConsentSigner,
  type PersonRef,
  type ProcedureConsentInput,
  type ProcedureConsentView,
  type RefusalSigner,
  type RefusalView,
  type Representative,
  type RepresentativeRelationship,
} from '../domain/procedure-consent';

/**
 * The form 024 over PostgreSQL (EN-152 to EN-154), shared by the two adapters
 * that touch it: the procedures' (registering with its consent, correcting,
 * restoring, reading) and the consent's own (refusal, revocation).
 *
 * The questions «does this concept demand it?» and «is this procedure
 * covered?» are asked to the SAME SQL functions the deferred trigger
 * `encounter_procedure_consent_required` asks, so the screen, the service and
 * the database cannot disagree about what needs a 024.
 */

type Client = Prisma.TransactionClient;

/** EN-152. `procedure_requires_written_consent`: some service of it is marked. */
export async function requiresWrittenConsent(
  client: Client,
  conceptId: string,
): Promise<boolean> {
  const [row] = await client.$queryRaw<{ required: boolean }[]>`
    SELECT procedure_requires_written_consent(${conceptId}::uuid) AS required`;
  return row?.required === true;
}

/** EN-152, EN-246. Its own 024 or exception, or the one it was restored from. */
export async function writtenConsentCovers(
  client: Client,
  procedureId: string,
  conceptId: string,
): Promise<boolean> {
  const [row] = await client.$queryRaw<{ covered: boolean }[]>`
    SELECT procedure_written_consent_covers(${procedureId}::uuid, ${conceptId}::uuid) AS covered`;
  return row?.covered === true;
}

/**
 * EN-152. Writes the consent of a procedure just written in the same
 * transaction, after checking what the paper must say. `now` is the
 * application's clock: a signature without its instant is «ahora».
 */
export async function insertProcedureConsent(
  client: Client,
  procedure: {
    id: string;
    encounterId: string;
    conceptId: string;
    performedAt: Date;
  },
  consent: ProcedureConsentInput,
  recordedById: string,
  now: Date,
): Promise<void> {
  const signedAt =
    consent.kind === 'SIGNED' ? (consent.signedAt ?? now) : undefined;
  const problem = consentProblem(
    consent,
    procedure.performedAt,
    signedAt ?? procedure.performedAt,
  );
  if (problem === 'SIGNED_AFTER_PROCEDURE') {
    throw new ConsentSignedAfterProcedureError();
  }
  if (problem === 'REPRESENTATIVE_REQUIRED') {
    throw new ConsentRepresentativeRequiredError();
  }
  // A ground left blank is no exception at all: the 024 is still owed.
  if (problem === 'EXCEPTION_REASON_REQUIRED') throw new ConsentRequiredError();

  await client.procedureConsent.create({
    data: {
      encounterId: procedure.encounterId,
      conceptId: procedure.conceptId,
      procedureId: procedure.id,
      kind: consent.kind,
      recordedAt: now,
      recordedById,
      ...(consent.kind === 'SIGNED'
        ? {
            signer: consent.signer,
            ...representativeColumns(
              consent.signer === 'REPRESENTATIVE'
                ? consent.representative
                : null,
            ),
            // EN-152. Whoever records it is who informed: the professional at
            // the chairside, the one whose signature the paper carries.
            informedById: recordedById,
            signedAt,
          }
        : {
            exceptionKind: consent.exceptionKind,
            exceptionReason: consent.reason.trim(),
          }),
    },
  });
}

/** The three representative columns, trimmed, or all three empty. */
export function representativeColumns(representative: Representative | null): {
  representativeName: string | null;
  representativeRelationship: string | null;
  representativeDocument: string | null;
} {
  if (representative === null) {
    return {
      representativeName: null,
      representativeRelationship: null,
      representativeDocument: null,
    };
  }
  const document = representative.document?.trim() ?? '';
  return {
    representativeName: representative.name.trim(),
    representativeRelationship: representative.relationship,
    representativeDocument: document === '' ? null : document,
  };
}

const PERSON = {
  select: { id: true, firstName: true, lastName: true },
} as const;

const CONSENT_SELECT = {
  id: true,
  procedureId: true,
  conceptId: true,
  kind: true,
  signer: true,
  representativeName: true,
  representativeRelationship: true,
  representativeDocument: true,
  witnessName: true,
  witnessDocument: true,
  exceptionKind: true,
  exceptionReason: true,
  signedAt: true,
  recordedAt: true,
  informedBy: PERSON,
  recordedBy: PERSON,
  concept: { select: { code: true, display: true } },
  revocation: {
    select: {
      signer: true,
      representativeName: true,
      representativeRelationship: true,
      representativeDocument: true,
      revokedAt: true,
      revokedBy: PERSON,
    },
  },
} satisfies Prisma.ProcedureConsentSelect;

type ConsentRow = Prisma.ProcedureConsentGetPayload<{
  select: typeof CONSENT_SELECT;
}>;

/**
 * EN-152, EN-246. The consents of an attention, keyed by the LIVE procedure
 * each covers: a restored procedure is a new row, so the consent written for
 * the row it came back from is found by walking the archive's `restored_as_id`
 * — the same lineage `procedure_written_consent_covers` follows. When a
 * procedure was corrected between concepts, the consent of its CURRENT
 * concept is the one served.
 */
export async function consentsByProcedure(
  client: Client,
  encounterId: string,
  procedures: readonly { id: string; conceptId: string }[],
): Promise<Map<string, ProcedureConsentView>> {
  const result = new Map<string, ProcedureConsentView>();
  if (procedures.length === 0) return result;

  const [rows, archive] = await Promise.all([
    client.procedureConsent.findMany({
      where: { encounterId, procedureId: { not: null } },
      select: CONSENT_SELECT,
    }),
    client.encounterProcedureRetraction.findMany({
      where: { encounterId, restoredAsId: { not: null } },
      select: { id: true, restoredAsId: true },
    }),
  ]);
  if (rows.length === 0) return result;

  const restoredFrom = new Map(
    archive.map((entry) => [entry.restoredAsId!, entry.id]),
  );
  for (const procedure of procedures) {
    for (
      let id: string | undefined = procedure.id, depth = 0;
      id !== undefined && depth < 50;
      id = restoredFrom.get(id), depth += 1
    ) {
      const row = rows.find(
        (each) => each.procedureId === id && each.conceptId === procedure.conceptId, // prettier-ignore
      );
      if (row !== undefined) {
        result.set(procedure.id, toConsentView(row));
        break;
      }
    }
  }
  return result;
}

/** EN-153. The refusals of an attention, in the order they were expressed. */
export async function refusalsOf(
  client: Client,
  encounterId: string,
): Promise<RefusalView[]> {
  const rows = await client.procedureConsent.findMany({
    where: { encounterId, kind: 'REFUSED' },
    orderBy: [{ signedAt: 'asc' }, { id: 'asc' }],
    select: CONSENT_SELECT,
  });
  return rows.map(toRefusalView);
}

/** One refusal by id, as written. */
export async function refusalById(
  client: Client,
  id: string,
): Promise<RefusalView> {
  const row = await client.procedureConsent.findUniqueOrThrow({
    where: { id },
    select: CONSENT_SELECT,
  });
  return toRefusalView(row);
}

/** One consent by id, as written. */
export async function consentById(
  client: Client,
  id: string,
): Promise<ProcedureConsentView> {
  const row = await client.procedureConsent.findUniqueOrThrow({
    where: { id },
    select: CONSENT_SELECT,
  });
  return toConsentView(row);
}

function person(row: {
  id: string;
  firstName: string;
  lastName: string;
}): PersonRef {
  return { id: row.id, name: `${row.firstName} ${row.lastName}` };
}

function representativeOf(row: {
  representativeName: string | null;
  representativeRelationship: string | null;
  representativeDocument: string | null;
}): Representative | null {
  return row.representativeName === null ||
    row.representativeRelationship === null
    ? null
    : {
        name: row.representativeName,
        // `procedure_consent_representative_states_who` keeps it a known value
        // written by this adapter.
        relationship:
          row.representativeRelationship as RepresentativeRelationship,
        document: row.representativeDocument,
      };
}

/** The casts lean on the CHECKs of `procedure_consent`. */
function toConsentView(row: ConsentRow): ProcedureConsentView {
  return {
    id: row.id,
    kind: row.kind as 'SIGNED' | 'EXCEPTION',
    signer: row.signer as ConsentSigner | null,
    representative: representativeOf(row),
    exceptionKind: row.exceptionKind as ConsentExceptionKind | null,
    exceptionReason: row.exceptionReason,
    informedBy: row.informedBy === null ? null : person(row.informedBy),
    signedAt: row.signedAt,
    recordedAt: row.recordedAt,
    recordedBy: person(row.recordedBy),
    revocation:
      row.revocation === null
        ? null
        : {
            signer: row.revocation.signer as ConsentSigner,
            representative: representativeOf(row.revocation),
            revokedAt: row.revocation.revokedAt,
            revokedBy: person(row.revocation.revokedBy),
          },
  };
}

/** `procedure_consent_refusal_states_who` guarantees who, when and the witness. */
function toRefusalView(row: ConsentRow): RefusalView {
  return {
    id: row.id,
    conceptId: row.conceptId,
    procedureCode: row.concept.code,
    procedureDisplay: row.concept.display,
    signer: row.signer as RefusalSigner,
    representative: representativeOf(row),
    witness:
      row.witnessName === null || row.witnessDocument === null
        ? null
        : { name: row.witnessName, document: row.witnessDocument },
    informedBy: person(row.informedBy!),
    refusedAt: row.signedAt!,
    recordedBy: person(row.recordedBy),
  };
}
