import { DOCUMENT_TITLE } from './document-kind';
import type { DocumentKind } from './document-kind';
import type { DocumentContext } from './document-source';
import type { DocumentTemplate } from './document-template';
import type { DocumentFrame, DocumentHeader } from './page-layout';

/**
 * DOC-071, DOC-080 to DOC-084. The frame every document is printed in: the
 * header and the footer of the template the author approved (D-095).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE FUNCTION FOR THE FOUR DOCUMENTS, AND WHY THE SPLIT RUNS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What a receta, an order, a certificate or a RIDE SAYS belongs to its own
 * composer, and each answers to its own norm. What FRAMES them is one identity
 * — one logo, one name, one accent, one footer — and it must not drift from one
 * class to the next because two people edited two functions. So the composers
 * hand over the four facts only they know (which class, the line that
 * identifies it, whether it prints a diagnosis, its verification code) and this
 * function decides everything else.
 */

/** What only the document's own composer knows about its frame. */
export interface FrameRequest {
  kind: DocumentKind;
  /** The line beside the title, labelled by the composer: «Receta N.º 128». */
  reference: string | null;
  /** DOC-082. True when the document PRINTS a diagnosis. */
  confidential: boolean;
  /** DOC-083. `null` when the document has none: then no QR is printed. */
  verificationCode: string | null;
}

/**
 * DOC-083. The line each class carries at its foot. Written here, not by each
 * composer, so the four footers read as one family.
 *
 * The receta carries none. It used to print «Copia de respaldo conservada cinco
 * años (Res. ACESS-2023-0030, art. 15)»: the retention is kept (DOC-013 purges
 * nothing), and printing it only recited the norm to the patient (author's
 * usability review, 04-10-2026).
 */
const FOOTER_NOTES: Readonly<Record<DocumentKind, readonly string[]>> = {
  PRESCRIPTION: [],
  SERVICE_ORDER: ['Numeración consecutiva por sede (A.M. 00002393, art. 43)'],
  MEDICAL_CERTIFICATE: ['Documento sin enmiendas'],
  INVOICE_RIDE: [
    'Representación impresa del comprobante electrónico (RIDE) · Ficha técnica del SRI, Anexo 2',
    'Consulte su validez en srienlinea.sri.gob.ec con la clave de acceso',
  ],
};

/**
 * DOC-071, DOC-080, DOC-081. The establishment's header: the trade name (the
 * legal one when there is none), the site line only with several sites, RUC,
 * address and phone only when the template's switches ask for them (DOC-034),
 * and e-mail and permit whenever they exist.
 */
function headerOf(
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentHeader {
  const { establishment } = context;
  return {
    establishmentName: establishment.tradeName ?? establishment.name,
    siteLine: context.siteLine,
    // DOC-034. Read always, printed only when the clinic asked for it: art. 5
    // requires none of these three.
    establishmentRuc: template.showEstablishmentRuc ? establishment.ruc : null,
    establishmentAddress: template.showEstablishmentAddress
      ? establishment.addressLine
      : null,
    establishmentPhone: template.showEstablishmentPhone
      ? establishment.phone
      : null,
    establishmentEmail: establishment.email,
    operatingPermit: establishment.operatingPermit,
    hasLogo: establishment.logo !== null,
    fields: template.headerFields.map((field) => ({
      label: field.label,
      value: field.value,
    })),
  };
}

/** The header and the footer of one document. Pure. */
export function composeFrame(
  context: DocumentContext,
  template: DocumentTemplate,
  request: FrameRequest,
): DocumentFrame {
  /**
   * DOC-084. THE RIDE KEEPS ITS OWN HEAD AND NO QR, WHATEVER IT IS HANDED.
   * Its header is the SRI's Anexo 2 (DOC-076) and DOC-078 forbids a QR on it;
   * deciding it here, not trusting the composer, is what keeps both true.
   */
  const fiscal = request.kind === 'INVOICE_RIDE';
  const code = fiscal ? null : request.verificationCode;

  return {
    title: DOCUMENT_TITLE[request.kind],
    reference: request.reference,
    confidential: request.confidential,
    accentColour: template.accentColour,
    // DOC-024. The legal person, which is who produced the file.
    establishmentName: context.establishment.name,
    header: fiscal ? null : headerOf(context, template),
    hasLogo: context.establishment.logo !== null,
    footer: {
      text: template.footerText,
      verification:
        code === null
          ? null
          : {
              code,
              url: `${context.verificationBaseUrl}/${encodeURIComponent(code)}`,
            },
      notes: FOOTER_NOTES[request.kind],
    },
    // Only a preview carries one (DOC-038); the service sets it.
    watermark: null,
  };
}
