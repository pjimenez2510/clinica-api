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
 * DOC-071, DOC-080. The establishment's header: the name always, and RUC,
 * address and phone only when the template's switches ask for them (DOC-034).
 */
function headerOf(
  context: DocumentContext,
  template: DocumentTemplate,
): DocumentHeader {
  const { establishment } = context;
  return {
    establishmentName: establishment.name,
    // DOC-034. Read always, printed only when the clinic asked for it: art. 5
    // requires none of these three.
    establishmentRuc: template.showEstablishmentRuc ? establishment.ruc : null,
    establishmentAddress: template.showEstablishmentAddress
      ? establishment.addressLine
      : null,
    establishmentPhone: template.showEstablishmentPhone
      ? establishment.phone
      : null,
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
  return {
    title: DOCUMENT_TITLE[request.kind],
    reference: request.reference,
    confidential: request.confidential,
    accentColour: template.accentColour,
    establishmentName: context.establishment.name,
    header: headerOf(context, template),
    footer: {
      text: template.footerText,
      verificationCode: request.verificationCode,
    },
  };
}
