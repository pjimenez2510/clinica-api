import type { DataSubjectRight } from './legal-due-date';
import {
  ClinicalRecordCopyInvalidError,
  DataRequestPartyNotAllowedError,
} from './privacy.errors';

/**
 * PD-052. Who presents a request: the holder or their legal representative,
 * who exercise the rights of the LOPDP; or one of the third parties to whom
 * the A.M. 5216 (art. 28) hands the copy of the clinical record.
 */
export const DATA_REQUEST_PARTIES = [
  'HOLDER',
  'REPRESENTATIVE',
  'ATTORNEY',
  'AUTHORIZED_PERSON',
  'AUTHORITY',
  'DECEASED_RELATIVE',
] as const;
export type DataRequestParty = (typeof DATA_REQUEST_PARTIES)[number];

/** PD-052. The four who only ask for the copy of the clinical record. */
export function isThirdParty(party: DataRequestParty): boolean {
  return party !== 'HOLDER' && party !== 'REPRESENTATIVE';
}

/** PD-052. What the name and the document of who presents it may be. */
export const REQUESTER_FIELD_MAX_LENGTH = 200;

/** What a request says about who presents it and what it asks for. */
export interface RequestPresentation {
  right: DataSubjectRight;
  requestedBy: DataRequestParty;
  clinicalRecordCopy: boolean;
  documentsChecked: boolean;
  requesterName: string | null;
  requesterDocument: string | null;
}

/**
 * PD-052, PD-053. The request as the A.M. 5216 admits it, or the refusal that
 * names the field: the copy is an access request, with the signed request and
 * the cedula at hand, and whoever is not the holder gives their name and
 * their cedula or official letter; a third party asks only for the copy.
 *
 * The name and the document come in trimmed; blank is absent. They are kept
 * only on a copy presented by someone other than the holder.
 */
export function presentationOf(input: {
  right: DataSubjectRight;
  requestedBy: DataRequestParty;
  clinicalRecordCopy?: boolean;
  documentsChecked?: boolean;
  requesterName?: string | null;
  requesterDocument?: string | null;
}): RequestPresentation {
  const clinicalRecordCopy = input.clinicalRecordCopy ?? false;
  // Who presents it is named only on a copy, and never the holder, whose
  // name is the chart's: whatever else came is dropped, as the base expects.
  const named = clinicalRecordCopy && input.requestedBy !== 'HOLDER';
  const requesterName = named ? filled(input.requesterName) : null;
  const requesterDocument = named ? filled(input.requesterDocument) : null;

  if (isThirdParty(input.requestedBy) && !clinicalRecordCopy) {
    throw new DataRequestPartyNotAllowedError();
  }
  if (clinicalRecordCopy && input.right !== 'ACCESS') {
    throw new ClinicalRecordCopyInvalidError('clinicalRecordCopy');
  }
  if (clinicalRecordCopy && input.documentsChecked !== true) {
    throw new ClinicalRecordCopyInvalidError('documentsChecked');
  }
  if (named) {
    if (requesterName === null) {
      throw new ClinicalRecordCopyInvalidError('requesterName');
    }
    if (requesterDocument === null) {
      throw new ClinicalRecordCopyInvalidError('requesterDocument');
    }
  }
  if ((requesterName?.length ?? 0) > REQUESTER_FIELD_MAX_LENGTH) {
    throw new ClinicalRecordCopyInvalidError('requesterName');
  }
  if ((requesterDocument?.length ?? 0) > REQUESTER_FIELD_MAX_LENGTH) {
    throw new ClinicalRecordCopyInvalidError('requesterDocument');
  }

  return {
    right: input.right,
    requestedBy: input.requestedBy,
    clinicalRecordCopy,
    documentsChecked: clinicalRecordCopy && input.documentsChecked === true,
    requesterName,
    requesterDocument,
  };
}

function filled(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
