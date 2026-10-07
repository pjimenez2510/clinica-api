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
  /** PR-038, art. 5.e.iv — signos de alarma. */
  warningSigns: string | null;
  /** PR-039, art. 5.e.v — recomendaciones no farmacológicas. */
  nonPharmacologicalAdvice: string | null;
  patient: PatientIdentity;
  /** Art. 5.b.iii — the CIE of the attention, principal first. */
  diagnoses: readonly { code: string; display: string }[];
  /** Art. 5.b.iv — «Antecedentes de alergias». */
  allergies: readonly string[];
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

export type DocumentSubject =
  | { kind: 'PRESCRIPTION'; data: PrescriptionPrintData }
  | { kind: 'SERVICE_ORDER'; data: ServiceOrderPrintData }
  | { kind: 'MEDICAL_CERTIFICATE'; data: CertificatePrintData }
  | { kind: 'INVOICE_RIDE'; data: InvoicePrintData }
  | { kind: 'ENCOUNTER_SUMMARY'; data: EncounterSummaryPrintData }
  | { kind: 'CREDIT_NOTE_RIDE'; data: CreditNotePrintData };

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
}

export const DOCUMENT_SOURCE_READER = Symbol('DOCUMENT_SOURCE_READER');

/** DOC-083. Injected into the reader: the base of `verificationBaseUrl`. */
export const DOCUMENT_VERIFICATION_BASE_URL = Symbol(
  'DOCUMENT_VERIFICATION_BASE_URL',
);
