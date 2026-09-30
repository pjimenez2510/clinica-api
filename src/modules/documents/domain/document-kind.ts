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
] as const;

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

export type ClinicalDocumentKind = (typeof CLINICAL_DOCUMENT_KINDS)[number];

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
};

/**
 * The caller's site scope, as `Principal.sitesFor` states it.
 *
 * Declared here and not imported from another module: no module imports
 * another. The DOMAIN only needs to know which of the two shapes it got.
 */
export type SiteScopeFilter = 'all' | readonly string[];
