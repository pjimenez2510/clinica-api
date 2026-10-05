/**
 * DOC-109. After a receta, an exam of an order or a certificate is annulled
 * —or annulled by «Corregir» (PR-109, ORD-118, CER-053)—, `documents` files
 * the PDF that replaces the archived one, with its mark and a reason the
 * system writes. Nobody chains a second step any more.
 *
 * A SHARED PORT because no module imports another: `prescription`, `orders`
 * and `certificates` know when something was annulled; `documents` owns the
 * archive and the layout that prints «ANULADA».
 *
 * ⚠️ IT NEVER THROWS. The annulment is the clinical act and it is already
 * committed when this runs; a PDF that cannot be composed must not undo it or
 * answer it with an error. What is lost is only the new file, and «Corregir…»
 * (DOC-108) archives it later.
 */
export type AnnulledDocumentKind =
  'PRESCRIPTION' | 'SERVICE_ORDER' | 'MEDICAL_CERTIFICATE';

export interface AnnulledDocument {
  kind: AnnulledDocumentKind;
  /** The receta, the order or the certificate. */
  subjectId: string;
  /** The ACCOUNT that annulled it: the new PDF is filed in its name. */
  userId: string;
  /** `CORRECTION` when «Corregir» annulled it; the reason says so. */
  cause: 'ANNULMENT' | 'CORRECTION';
}

/**
 * DOC-109. What the annulment answers about its PDF, so the screen can warn:
 * `true` filed; `false` there was one to replace and it COULD NOT be filed —
 * the archive still holds the PDF without the mark, and nobody must hand it
 * out; `null` there was no PDF to replace.
 */
export type DocumentArchived = boolean | null;

export interface AnnulledDocumentArchiver {
  archiveAnnulled(document: AnnulledDocument): Promise<DocumentArchived>;
}

export const ANNULLED_DOCUMENT_ARCHIVER = Symbol('AnnulledDocumentArchiver');
