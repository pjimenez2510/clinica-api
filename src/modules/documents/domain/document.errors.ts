import {
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
  type DomainFieldError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong when a document is composed, emitted or served.
 *
 * No HTTP here: the CATEGORY decides the status in `problem-details.filter.ts`,
 * which is what lets these same rules run from a worker where «422» means
 * nothing.
 *
 * ⚠️ NOT ONE OF THESE MESSAGES NAMES THE PATIENT, THE MEDICINE OR THE AMOUNT
 * (DOC-093). A drug name IS a diagnosis said differently — metformin says
 * diabetes, efavirenz says HIV — and these sentences reach logs and support
 * screenshots. They speak of documents and of fields.
 *
 * ⚠️ AND NONE OF THEM REUSES A CODE THAT ALREADY EXISTS. `PRESCRIPTION_NOT_FOUND`
 * and `ORDER_NOT_FOUND` say something close to what `DOCUMENT_SUBJECT_NOT_FOUND`
 * says, and they are not reused: no module imports another (CLAUDE.md §3), and
 * `error-catalogue.spec.ts` fails when two classes declare the same `code` — a
 * client branches on the code, so two situations answering one code is two
 * things it cannot tell apart.
 */

/**
 * DOC-012. The artefact does not exist — or belongs to a site outside the
 * caller's scope.
 *
 * ONE ANSWER FOR BOTH, and it is the requirement rather than a convenience:
 * telling them apart would confirm documents of other sites to whoever guesses
 * identifiers, one at a time.
 */
export class DocumentRenderNotFoundError extends NotFoundError {
  readonly code = 'DOCUMENT_RENDER_NOT_FOUND';
  override readonly userTitle =
    'Ese documento no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Document render not found within the caller site scope');
  }
}

/**
 * The row the document would represent does not exist, or is out of scope.
 *
 * SEPARATE FROM THE ONE ABOVE because what to do differs: there the document
 * was never emitted, here the receta or the invoice itself is not reachable, and
 * the screen has to send the user back to a different list.
 */
export class DocumentSubjectNotFoundError extends NotFoundError {
  readonly code = 'DOCUMENT_SUBJECT_NOT_FOUND';
  override readonly userTitle =
    'No se encuentra el documento de origen en las sedes a las que usted tiene acceso';

  constructor() {
    super('Document subject not found within the caller site scope');
  }
}

/**
 * DOC-014. The subject can still change, so there is nothing definitive to
 * archive.
 *
 * ⚠️ IT IS NOT A REFUSAL TO SHOW ANYTHING: the draft of DOC-001 stays available
 * and returns the very same bytes. What is refused is FILING them. Archiving a
 * draft produces two files that say different things and none of them is «la
 * receta», which is the question the ACESS art. 9 copy has to answer.
 */
export class DocumentSubjectNotIssuableError extends ConflictError {
  readonly code = 'DOCUMENT_SUBJECT_NOT_ISSUABLE';
  override readonly userTitle =
    'Ese documento todavía es un borrador. Emítalo primero y después podrá archivarse e imprimirse';

  constructor(state: string) {
    super(`Document subject is not issuable in state ${state}`, { state });
  }
}

/**
 * DOC-037. No template version has been published for this class of document.
 *
 * 422 AND NOT 500: nothing is broken, a datum of the installation is missing,
 * and the message says who fixes it and where. AND NO DEFAULT IS INVENTED — a
 * template that exists only in the code is the version no row records, so the
 * `sha256` of every artefact it produced would be unreconstructible.
 */
export class DocumentTemplateNotPublishedError extends ValidationError {
  readonly code = 'DOCUMENT_TEMPLATE_NOT_PUBLISHED';
  override readonly userTitle =
    'Todavía no hay una plantilla publicada para este documento. Publíquela en Configuración › Documentos';

  constructor(kind: string) {
    super(`No template published for ${kind}`, { kind });
  }
}

/** DOC-035, DOC-036. A slot outside its shape. */
export class DocumentTemplateSlotInvalidError extends ValidationError {
  readonly code = 'DOCUMENT_TEMPLATE_SLOT_INVALID';
  override readonly userTitle = 'Revise los datos de la plantilla';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(field: string, message: string) {
    super(`Invalid template slot: ${field}`, { field });
    this.fieldErrors = [
      { field, code: 'DOCUMENT_TEMPLATE_SLOT_INVALID', message },
    ];
  }
}

/**
 * DOC-050, DOC-051. Anything that is not PNG or JPEG.
 *
 * ⚠️ THE MESSAGE NAMES SVG EXPLICITLY, and it should. An SVG is the format a
 * designer hands over, so «no se admite ese formato» would read as an oversight
 * and somebody would try again next week. Saying it is refused ON PURPOSE ends
 * the conversation: an SVG DOES execute scripts when navigated to directly, and
 * there are real CVEs of credential theft through that exact path.
 */
export class DocumentImageFormatNotAllowedError extends ValidationError {
  readonly code = 'DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED';
  override readonly userTitle =
    'Sólo se admiten imágenes PNG o JPEG. El formato SVG no se acepta por seguridad, ni siquiera convertido';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(field: string) {
    super('Rejected image format: only PNG and JPEG are admitted', { field });
    this.fieldErrors = [
      {
        field,
        code: 'DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED',
        message: 'Suba la imagen en PNG o JPEG, de menos de 512 KB',
      },
    ];
  }
}

/**
 * DOC-052, DOC-053. Too many bytes, or too many pixels.
 *
 * TWO CAUSES AND ONE CODE, because what to do is the same — send a smaller
 * image — but the MESSAGE distinguishes them: «pesa demasiado» and «tiene
 * demasiados píxeles» send somebody to two different buttons in their image
 * editor. And they are two different defences: a byte cap does NOT stop a
 * decompression bomb, where 40 KB declare 30 000 × 30 000 pixels.
 */
export class DocumentImageTooLargeError extends ValidationError {
  readonly code = 'DOCUMENT_IMAGE_TOO_LARGE';
  override readonly userTitle: string;
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(field: string, reason: 'bytes' | 'pixels') {
    const message =
      reason === 'bytes'
        ? 'La imagen supera los 512 KB. Redúzcala antes de subirla'
        : 'La imagen tiene demasiados píxeles. Redúzcala a un tamaño razonable para un logo o un sello';
    super(`Image rejected: too large by ${reason}`, { reason });
    this.userTitle = message;
    this.fieldErrors = [{ field, code: 'DOCUMENT_IMAGE_TOO_LARGE', message }];
  }
}

/**
 * The file claims to be PNG or JPEG and cannot be decoded.
 *
 * NOT THE SAME AS THE FORBIDDEN FORMAT, and the difference is worth a code:
 * there the format was right and refused, here the format is admitted and the
 * content is broken. Merging them would tell somebody with a truncated PNG that
 * PNG is not accepted.
 */
export class DocumentImageUnreadableError extends ValidationError {
  readonly code = 'DOCUMENT_IMAGE_UNREADABLE';
  override readonly userTitle =
    'No se pudo leer la imagen. Puede estar dañada o incompleta: vuelva a exportarla y súbala otra vez';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(field: string) {
    super('Image could not be decoded', { field });
    this.fieldErrors = [
      {
        field,
        code: 'DOCUMENT_IMAGE_UNREADABLE',
        message: 'Vuelva a exportar la imagen y súbala otra vez',
      },
    ];
  }
}

/**
 * Composing the PDF failed.
 *
 * THE ONLY ERROR OF THIS MODULE THAT IS OUR FAULT, and it is an
 * `ExternalServiceError` rather than a business rule because that is what it
 * is: an engine that did not produce a file. `isRetryable` is true — a failure
 * here is a defect or a resource limit, and neither is something the caller
 * corrects by editing the receta.
 *
 * IT CARRIES NO DETAIL TO THE CALLER. A stack trace from a PDF engine says
 * nothing to a receptionist and can carry a field value out with it.
 */
export class DocumentRenderFailedError extends ExternalServiceError {
  readonly code = 'DOCUMENT_RENDER_FAILED';
  readonly service = 'pdfkit';
  readonly isRetryable = true;
  override readonly userTitle =
    'No se pudo generar el documento. Inténtelo de nuevo; si vuelve a fallar, avise a soporte';

  constructor(cause?: unknown) {
    super('PDF composition failed');
    this.cause = cause;
  }
}
