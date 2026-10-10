import type { RecordReadScope } from '../../../shared/domain/clinical-record-key';
import type { StandingAllergyAbsence } from '../../../shared/clinical/allergy-history';
import type { Form117 } from '../../../shared/domain/form-117/form-117';
import type { DocumentKind, SiteScopeFilter } from './document-kind';
import type { StoredImage } from './document-image';
import type { VerificationFacts } from './document-verification';

/**
 * THE PORTS. What this module needs to know about the rows it prints, stated
 * without naming a table and without importing a single other module.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE ARE QUESTIONS ABOUT PRESCRIPTIONS, ORDERS, CERTIFICATES, INVOICES,
 * ESTABLISHMENTS AND PRACTITIONERS IN A MODULE THAT OWNS NONE OF THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Printing a document means reading the whole of it. NONE of that is obtained
 * by importing `prescription`, `orders`, `encounter`, `billing`, `organization`
 * or `staff`: no module imports another (CLAUDE.md §3), and the day that rule
 * is bent «for just one lookup» the modules stop being modules. This module
 * declares the facts it needs and its own adapter answers them — the route
 * `prescription` took for the chart, the practitioner and the site.
 *
 * ⚠️ EVERY QUERY CARRIES THE CALLER'S SITE SCOPE (DOC-012). Not a site the
 * caller named: the one their grants resolve to. A port that could be asked
 * about a subject without a scope is a port through which the scope can be
 * forgotten, once, in one call, for ever.
 */

/** One page of establishment identity, as every document prints it. */
export interface EstablishmentIdentity {
  /**
   * Art. 5.a.iii. The ONLY establishment datum the receta must carry. The
   * LEGAL name (razón social): the RIDE prints it as such (DOC-076).
   */
  name: string;
  /** OR-010, DOC-080. What the header prints instead of `name` when present. */
  tradeName: string | null;
  /** OR-011, DOC-080. */
  email: string | null;
  /** OR-012, DOC-080. The ACESS operating permit number. */
  operatingPermit: string | null;
  /** DOC-034. Read always, printed only if the template says so. */
  ruc: string | null;
  /** The SITE's address: where the patient walks back to. */
  addressLine: string | null;
  /** OR-028, DOC-076. The establishment's head office (`dirMatriz`). */
  headOfficeAddress: string | null;
  phone: string | null;
  /** DOC-059. `null` prints no logo, which is legitimate. */
  logo: StoredImage | null;
  /** DOC-077. The fiscal legends of the RIDE. */
  keepsAccounting: boolean;
  specialTaxpayerResolution: string | null;
  withholdingAgentResolution: string | null;
  rimpeRegime: 'NONE' | 'ENTREPRENEUR' | 'POPULAR_BUSINESS';
}

/** Who signs, and what this system holds of their hand. */
export interface PractitionerIdentity {
  /** «Apellidos y nombres», in that order (art. 5.d.i). */
  fullName: string;
  /** Art. 5.d.ii. `null` prints the field empty rather than inventing one. */
  acessRegistration: string | null;
  mspCode: string | null;
  /** PR-040. Art. 5.e.vi — the number the patient calls. */
  contactPhone: string | null;
  /** DOC-060. `null` prints a labelled empty box. */
  seal: StoredImage | null;
  signature: StoredImage | null;
}

/** What every document says about the person it is about. */
export interface PatientIdentity {
  /** Art. 5.b.i — «Apellidos y nombres completos». In that order. */
  fullName: string;
  /** The identifier printed so a pharmacy or an employer can match the person. */
  identifier: string | null;
  /**
   * D-078. The chart number, beside the document on everything printed: a
   * newborn without a cédula is matched by it alone.
   */
  mrn: string;
  /**
   * Art. 5.b.ii. THE FROZEN AGE OF THE ATTENTION, never today's: a document
   * filed five years ago has to keep saying the age the patient had that day.
   */
  ageYears: number | null;
  ageMonths: number | null;
}

/** One line of a receta, as it is stored. */
export interface PrescriptionLine {
  /** Art. 5.c.i — the DCI, frozen when the receta was written. */
  genericName: string;
  presentation: string | null;
  concentration: string | null;
  /** The stored code. The layout spells it out; art. 13 forbids abbreviations. */
  routeCode: string | null;
  quantity: number | null;
  doseText: string;
  frequencyText: string;
  durationDays: number | null;
  /** Art. 5.e.iii — what goes on the tear-off band. */
  instructions: string | null;
  /** PR-110, REQ-054. Outside the CNMB: printed whether or not a reason was given. */
  offFormulary: boolean;
  offFormularyJustification: string | null;
}

/** Everything the receta prints. */
export interface PrescriptionPrintData {
  subjectId: string;
  siteId: string;
  /** DOC-014. `ACTIVE`, `CANCELLED`… Only some of them may be filed. */
  status: string;
  /** `null` while it is a draft, which is what DOC-014 refuses to archive. */
  issuedAt: Date | null;
  /** Art. 5.a.i. The canton of the site's parish; `null` if the site has none. */
  city: string | null;
  verificationCode: string | null;
  /** PR-020, art. 5.a.i. Consecutive per site; `null` on a draft. */
  sequenceNumber: number | null;
  /** PR-038, art. 5.e.iii — signos de alarma. */
  warningSigns: string | null;
  /** PR-039, art. 5.e.iii — recomendaciones no farmacológicas. */
  nonPharmacologicalAdvice: string | null;
  patient: PatientIdentity;
  /** Art. 5.b.iii — the CIE of the attention, principal first. */
  diagnoses: readonly { code: string; display: string }[];
  /** Art. 5.b.iv — «Antecedentes de alergias». */
  allergies: readonly string[];
  /**
   * DOC-116, EN-087. The chart's STANDING «sin alergias conocidas», or `null`
   * («no se preguntó»), by the rule the attention's band reads it with.
   */
  noKnownAllergies: StandingAllergyAbsence | null;
  prescriber: PractitionerIdentity;
  lines: readonly PrescriptionLine[];
}

/** Everything the exam request prints. No norm fixes its format (DOC-072). */
export interface ServiceOrderPrintData {
  subjectId: string;
  siteId: string;
  /** ORD-006. The consecutive number per site, printed as the reference. */
  number: number;
  /** D-095. The short random code a laboratory checks the order with. */
  verificationCode: string;
  requestedAt: Date;
  category: string;
  priority: string;
  clinicalNoteText: string | null;
  patient: PatientIdentity;
  /** ORD-126. The header of form 010A carries it: `MALE`, `FEMALE`, … */
  patientSex: string;
  diagnoses: readonly { code: string; display: string }[];
  orderedBy: PractitionerIdentity;
  /**
   * DOC-072. Each exam with its frozen code and name, and the specimen, the
   * patient's preparation and its section of form 010A (ORD-126) as the
   * catalogue holds them today.
   */
  items: readonly {
    code: string;
    display: string;
    specimen: string | null;
    preparation: string | null;
    /**
     * ORD-129 (D-137). The exam asks for a fast, with its minimum hours if the
     * catalogue says them; `null` when it asks for none.
     */
    fasting: { hours: number | null } | null;
    section: string | null;
    status: string;
  }[];
}

/**
 * DOC-075, CER-020 to CER-037. Everything the certificate prints: form 117 as
 * `composeForm117` composes it — the SAME function the certificate's screen
 * reads, so the paper and the screen cannot say two things — plus the
 * practitioner whose seal goes in block E.
 */
export interface CertificatePrintData {
  subjectId: string;
  siteId: string;
  form: Form117;
  issuedBy: PractitionerIdentity;
}

/** One line of the RIDE's detail table. */
export interface InvoiceLine {
  code: string;
  /** DOC-076. The MSP tariff code, when the service has one. */
  auxiliaryCode: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  /** The line's net: quantity × unit price − discount. */
  total: string;
  /** SRI table 17 `codigoPorcentaje`, frozen on the charge. */
  taxSriCode: string;
  /** The frozen rate, `15.00`; `null` for «no objeto» and «exento». */
  taxPercentage: string | null;
}

/** Everything the RIDE prints (SRI, Ficha Técnica, Anexo 2). */
export interface InvoicePrintData {
  subjectId: string;
  siteId: string;
  /** `001-001-000000001`, composed from the establishment and emission point. */
  documentNumber: string;
  /** The 49-digit access key, once the SRI authorises it. */
  accessKey: string | null;
  status: string;
  issuedAt: Date | null;
  authorisedAt: Date | null;
  buyerIdentificationType: string;
  buyerIdentification: string;
  buyerName: string;
  buyerEmail: string | null;
  /** DOC-076. Only known when the buyer is the patient: their address. */
  buyerAddress: string | null;
  /** BI-170. SRI table 24 code; `null` on an invoice from before it. */
  paymentMethod: string | null;
  /** DOC-076 «Información adicional»: whom the attention was for. */
  patient: {
    fullName: string;
    /** The medical record number humans quote (HC). */
    mrn: string;
    /** Printed only when the buyer is the patient. */
    phone: string | null;
  } | null;
  /** The first service date of the lines: the day of the attention. */
  attendedOn: Date | null;
  lines: readonly InvoiceLine[];
  subtotalTaxed: string;
  subtotalUntaxed: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

/**
 * SRI-089. Everything the RIDE of a credit note prints: the values FROZEN in
 * the credit note, never the invoice's current ones.
 */
export interface CreditNotePrintData {
  subjectId: string;
  siteId: string;
  /** Its own series and sequential, from its access key once there is one. */
  documentNumber: string;
  accessKey: string | null;
  /** `ISSUED`, `AUTHORISED` or `REJECTED`: a credit note is never a draft. */
  status: string;
  issuedAt: Date | null;
  /** Its voucher's `authorised_at`; `null` until the SRI authorises it. */
  authorisedAt: Date | null;
  buyerIdentificationType: string;
  buyerIdentification: string;
  buyerName: string;
  buyerEmail: string | null;
  /** The text of `<motivo>`, as the voucher carries it. */
  reason: string;
  /** The invoice it modifies: its printed number and its date of issue. */
  modifiedDocument: { number: string; issuedAt: Date | null };
  lines: readonly InvoiceLine[];
  subtotalTaxed: string;
  subtotalUntaxed: string;
  discountTotal: string;
  taxTotal: string;
  /** The credit note's `amount`: its total, `valorModificacion`. */
  total: string;
}

/** What every document needs before it can be composed. */
export interface DocumentContext {
  establishment: EstablishmentIdentity;
  siteName: string;
  /**
   * DOC-081. «Sede Norte · Unicódigo 012345» when the establishment has MORE
   * THAN ONE active site, `null` when it has one (D-095.4).
   */
  siteLine: string | null;
  /**
   * DOC-083. Where the public verification page lives, without the code:
   * `https://clinica.example/verificar`. A datum of the installation.
   */
  verificationBaseUrl: string;
}

/**
 * The union the service works with. Discriminated by `kind`, so adding a fifth
 * document is a compile error everywhere it has to be handled rather than a
 * silent gap.
 */
/**
 * DOC-111. Everything the summary of an attention prints, as it stands when it
 * is asked for: it is composed on demand and never archived, so «as it stands»
 * is the honest answer. Only what was issued and not annulled: a receta in
 * draft or annulled, a cancelled exam, a revoked certificate are not part of
 * what the patient takes away.
 */
export interface EncounterSummaryPrintData {
  subjectId: string;
  siteId: string;
  /** EN-219. The attention's code, printed at the foot (DOC-112). */
  verificationCode: string;
  /** `ENTERED_IN_ERROR` is refused; any other is printed. */
  status: string;
  startedAt: Date;
  patient: PatientIdentity;
  patientSex: string;
  practitioner: PractitionerIdentity;
  /** The current vital signs, already labelled; empty when none were taken. */
  vitals: readonly { label: string; value: string }[];
  /**
   * The CURRENT 002 of the chain —the last signed—, its sections under the
   * titles of its template. `null` when none is signed: DOC-111 refuses it.
   */
  note: {
    signedAt: Date;
    /** When it is an amendment: the instant the current version was signed. */
    amendedAt: Date | null;
    /**
     * EN-156. Signed with the credential and no electronic certificate — every
     * note today (D-177.1). Printed, because the constancy that lives only on
     * a screen is gone from the paper handed over at an inspection.
     */
    withoutCertificate: boolean;
    sections: readonly { title: string; text: string }[];
  } | null;
  diagnoses: readonly {
    code: string;
    display: string;
    principal: boolean;
    certainty: string;
  }[];
  prescriptions: readonly {
    sequenceNumber: number | null;
    lines: readonly PrescriptionLine[];
  }[];
  exams: readonly { orderNumber: number | null; display: string }[];
  certificates: readonly {
    number: number;
    type: string;
    restFrom: Date | null;
    restTo: Date | null;
  }[];
}

/**
 * EN-243. Form 053 or 007 as its signed note says it: composed on demand and
 * never archived, so «as it stands» is the note, which is immutable (EN-027).
 */
export interface ClinicalFormPrintData {
  /** The `clinical_note` id. */
  subjectId: string;
  siteId: string;
  /** `053` or `007`. */
  formCode: string;
  /** What the paper is titled: «REFERENCIA», «INTERCONSULTA»… */
  title: string;
  /** EN-107. The act was annulled: the paper says so. */
  annulled: boolean;
  signedAt: Date;
  /** EN-156. Signed with the credential, without a certificate. */
  withoutCertificate: boolean;
  encounterStartedAt: Date;
  patient: PatientIdentity;
  /** Who issued and signed it, with the seal they carry. */
  signer: PractitionerIdentity;
  sections: readonly { title: string; text: string }[];
}

/**
 * DOC-121 (D-203 §4). One report of an exam of the attention, as it stood when
 * the copy was authorised: its values and its conclusion; and whether it was
 * corrected afterwards — the correction is not part of what was authorised.
 */
export interface CopyResultReport {
  /** The order's number, when it has one. */
  orderNumber: number | null;
  issuedAt: Date | null;
  conclusion: string | null;
  values: readonly {
    analyte: string;
    value: string;
    reference: string | null;
    abnormal: string | null;
  }[];
  correctedAfter: Date | null;
}

/** DOC-123 (D-203 §6). Block F, as recorded, when the review includes it. */
export interface CopyScreening {
  result: string;
  types: readonly string[];
  tool: string | null;
  actionTaken: string | null;
  reportedToAuthority: boolean;
}

/** DOC-121. What one attention of the copy adds to its summary (DOC-111). */
export interface CopyEncounterData extends EncounterSummaryPrintData {
  siteName: string;
  results: readonly CopyResultReport[];
  /** Form 005, signed and standing, oldest first. */
  evolutionNotes: readonly { signedAt: Date; text: string }[];
  /** `null` without the screening, or when the review does not include it. */
  screening: CopyScreening | null;
}

/**
 * DOC-118 (D-198 §1). The copy of the clinical record a request of `privacy`
 * authorised: who asked, who authorised, and every attention with a signed
 * 002 of the chart in force and of the charts merged into it, oldest first.
 */
export interface ClinicalRecordCopyPrintData {
  requestId: string;
  /** The chart in force, with no age: the cover is not one attention. */
  patient: PatientIdentity;
  patientSex: string;
  /** PD-052. `HOLDER`, `REPRESENTATIVE` or one of the four third parties. */
  requestedBy: string;
  requesterName: string | null;
  requesterDocument: string | null;
  /** PD-063. The relative's relationship with the deceased patient. */
  requesterRelationship: string | null;
  receivedAt: Date;
  /** DOC-122. `null` is the whole record; a period, «Atendida en parte». */
  copyPeriod: { from: string; to: string } | null;
  /** DOC-123. The review includes the violence screening. */
  includesScreening: boolean;
  /** The standing answer (PD-047): who authorised the delivery, and when. */
  authorisedBy: string;
  authorisedAt: Date;
  /** DOC-119. The charts whose attentions leave: the one in force first. */
  chartIds: readonly string[];
  /** Each attention as DOC-111 prints it, with the name of its site. */
  encounters: readonly CopyEncounterData[];
  /**
   * D-203 §1. Attentions at sites beyond the caller's `record:read` were left
   * out: the cover says the copy does not carry those of other sites.
   */
  omitsOtherSites: boolean;
  /**
   * The site whose letterhead the copy wears: the latest attention's, or
   * `null` when there is none (the caller takes the first active site).
   */
  siteId: string | null;
}

/** DOC-118. What a request id resolves to, before anything is composed. */
export type ClinicalRecordCopyLookup =
  | { status: 'missing' }
  /** Not a copy request, or its standing answer does not authorise it. */
  | { status: 'not-available' }
  | { status: 'ready'; data: ClinicalRecordCopyPrintData };

export type DocumentSubject =
  | { kind: 'PRESCRIPTION'; data: PrescriptionPrintData }
  | { kind: 'SERVICE_ORDER'; data: ServiceOrderPrintData }
  | { kind: 'MEDICAL_CERTIFICATE'; data: CertificatePrintData }
  | { kind: 'INVOICE_RIDE'; data: InvoicePrintData }
  | { kind: 'ENCOUNTER_SUMMARY'; data: EncounterSummaryPrintData }
  | { kind: 'CREDIT_NOTE_RIDE'; data: CreditNotePrintData }
  | { kind: 'CLINICAL_FORM'; data: ClinicalFormPrintData };

/** One subject, looked up within the caller's own site scope (DOC-012). */
export interface SubjectQuery {
  kind: DocumentKind;
  subjectId: string;
  sites: SiteScopeFilter;
}

/** The port that answers «what does this document say?». */
export interface DocumentSourceReader {
  /** `null` when it does not exist OR is out of the caller's scope (DOC-012). */
  findSubject(query: SubjectQuery): Promise<DocumentSubject | null>;
  /** The establishment and site identity behind one site. */
  contextForSite(siteId: string): Promise<DocumentContext | null>;
  /**
   * DOC-038. The site a template preview borrows its identity from when the
   * administrator names none: the first active one, by name.
   */
  firstActiveSiteId(): Promise<string | null>;
  /**
   * DOC-094. What may be said in public about the document behind a code.
   * Not scoped: the code IS the credential, and the answer carries nobody.
   */
  findForVerification(code: string): Promise<VerificationFacts | null>;
  /**
   * DOC-118, D-203 §1. The copy of the clinical record behind a request, as
   * far as the caller's `record:read` reaches: `missing` too when they hold
   * no key to the person's record, so the refusal reveals nothing.
   */
  findClinicalRecordCopy(
    requestId: string,
    recordScope: RecordReadScope,
  ): Promise<ClinicalRecordCopyLookup>;
}

export const DOCUMENT_SOURCE_READER = Symbol('DOCUMENT_SOURCE_READER');

/** DOC-083. Injected into the reader: the base of `verificationBaseUrl`. */
export const DOCUMENT_VERIFICATION_BASE_URL = Symbol(
  'DOCUMENT_VERIFICATION_BASE_URL',
);
