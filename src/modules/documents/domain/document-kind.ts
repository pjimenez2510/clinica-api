/**
 * The four documents this module prints, and what each one represents.
 *
 * ⚠️ THE CONTROLLED-SUBSTANCE PRESCRIPTION IS NOT ONE OF THEM (DOC-079). That
 * document is a pre-printed pad the ACESS issues and sells, with its own
 * numbering, under the doctor's nominal custody, and whose original stays at the
 * pharmacy. A PDF we produced would not be that prescription, and a clinic
 * believing otherwise would find out during an inspection. It is also the only
 * document whose QR IS mandatory, with a rigid state-defined format — one more
 * reason not to go near it.
 */
export const DOCUMENT_KINDS = [
  'PRESCRIPTION',
  'SERVICE_ORDER',
  'MEDICAL_CERTIFICATE',
  'INVOICE_RIDE',
  // DOC-111, DOC-113. Composed on demand and NEVER archived.
  'ENCOUNTER_SUMMARY',
  // SRI-089. The RIDE of a credit note, on the invoice RIDE's template.
  'CREDIT_NOTE_RIDE',
  // EN-243. Form 053 or 007 of a referral or interconsultation, composed on
  // demand from its signed note and NEVER archived, like the summary.
  'CLINICAL_FORM',
] as const;

/** One of `DOCUMENT_KINDS`, as `document_render.kind` stores it. */
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * The three kinds a caller holding `record:read` may ask for.
 *
 * THE RIDE IS NOT AMONG THEM, and that is the separation that matters
 * (DOC-090): a tax document is not clinical content, and whoever may read a
 * chart has no business being handed an invoice because both happen to be PDFs.
 */
export const CLINICAL_DOCUMENT_KINDS = [
  'PRESCRIPTION',
  'SERVICE_ORDER',
  'MEDICAL_CERTIFICATE',
] as const satisfies readonly DocumentKind[];

/** One of `CLINICAL_DOCUMENT_KINDS`. */
export type ClinicalDocumentKind = (typeof CLINICAL_DOCUMENT_KINDS)[number];

/**
 * DOC-091. The test that decides whether serving a document leaves an audit
 * row: true for the three clinical kinds, false for the RIDE.
 */
export function isClinicalDocumentKind(
  kind: DocumentKind,
): kind is ClinicalDocumentKind {
  return (CLINICAL_DOCUMENT_KINDS as readonly DocumentKind[]).includes(kind);
}

/** The Spanish title printed at the head of each document. */
export const DOCUMENT_TITLE: Readonly<Record<DocumentKind, string>> = {
  PRESCRIPTION: 'RECETA MÉDICA',
  SERVICE_ORDER: 'ORDEN DE EXÁMENES',
  MEDICAL_CERTIFICATE: 'CERTIFICADO MÉDICO',
  INVOICE_RIDE: 'FACTURA',
  ENCOUNTER_SUMMARY: 'RESUMEN DE LA ATENCIÓN',
  CREDIT_NOTE_RIDE: 'NOTA DE CRÉDITO',
  // EN-243. The composer names the act: «REFERENCIA», «INTERCONSULTA»…
  CLINICAL_FORM: 'FORMULARIO CLÍNICO',
};

/**
 * DOC-030, DOC-039. The kinds that have a template of their own: every kind
 * but the credit note's RIDE.
 *
 * SRI-089. THE CREDIT NOTE IS PRINTED ON THE INVOICE RIDE'S TEMPLATE. Both are
 * vouchers of the same issuer laid out by the same Anexo 2 of the Ficha
 * Técnica, and the clinic has ONE visual identity (D-095.3): a second
 * template would be a second place to publish the same accent and footer,
 * and the day the two drifted the credit note would stop looking like the
 * invoice it corrects. So the administration publishes five templates, and
 * `templateKindOf` says which one each document borrows.
 */
export const TEMPLATE_KINDS = [
  'PRESCRIPTION',
  'SERVICE_ORDER',
  'MEDICAL_CERTIFICATE',
  'INVOICE_RIDE',
  'ENCOUNTER_SUMMARY',
] as const satisfies readonly DocumentKind[];

/** One of `TEMPLATE_KINDS`: what `document_template.kind` holds. */
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** SRI-089. The template a document is composed with. */
export function templateKindOf(kind: DocumentKind): TemplateKind {
  if (kind === 'CREDIT_NOTE_RIDE') return 'INVOICE_RIDE';
  // EN-243. The 053 and the 007 are clinical papers composed on demand, like
  // the summary, and wear its template: one more template would be one more
  // place for the clinic to publish the same identity.
  if (kind === 'CLINICAL_FORM') return 'ENCOUNTER_SUMMARY';
  return kind;
}

/** DOC-084, SRI-089. The two tax documents: Anexo 2 head, no QR. */
export function isFiscalDocumentKind(kind: DocumentKind): boolean {
  return kind === 'INVOICE_RIDE' || kind === 'CREDIT_NOTE_RIDE';
}

/**
 * The caller's site scope, as `Principal.sitesFor` states it.
 *
 * Declared here and not imported from another module: no module imports
 * another. The DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];
