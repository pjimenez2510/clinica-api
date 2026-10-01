import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What each constraint of this module means to the person who hit it.
 *
 * Lives HERE, beside the repository, so adding one is a change inside the
 * module that owns it — never an edit to a shared file. Imported for its side
 * effect by `documents.module.ts`.
 *
 * ⚠️ THE NAME OF A CONSTRAINT IS PART OF THE PUBLISHED CONTRACT. It travels to
 * the client through the PostgreSQL error mapping, so a rename here is a rename
 * of the contract.
 *
 * ⚠️ THE THREE IMMUTABILITY TRIGGERS ARE NOT HERE, AND CANNOT BE. They raise
 * from PL/pgSQL, so no constraint NAME travels with the error and this table
 * cannot match on one. That is not a gap: nothing this module writes can reach
 * them — there is no `update` and no `delete` anywhere in the repository — so
 * whoever does hit one is an import or a `psql`, and they are reading the
 * server log, not an HTTP response. What they get there is a sentence that says
 * what to do instead («emit a new render with supersedes_id over it»).
 *
 * These codes are deliberately NOT in `error-catalogue.ts`: they are produced
 * by PostgreSQL constraints, and this registration is their enumeration.
 */
registerConstraintMeanings({
  /**
   * DOC-030. `document_template_kind_version_unique`.
   *
   * NOBODY SHOULD SEE THIS THROUGH THE API: the version number is chosen inside
   * a `Serializable` transaction, so two people publishing at the same instant
   * get 4 and 5 rather than 4 and a collision. It is registered because the
   * unique index also guards an import — and because if the isolation level
   * were ever weakened, this is the sentence that would appear, which makes the
   * regression legible instead of a 500.
   */
  document_template_kind_version_unique: {
    code: 'DOCUMENT_TEMPLATE_VERSION_TAKEN',
    field: 'version',
    message: 'Otra persona publicó una versión de esta plantilla al mismo tiempo. Vuelva a intentarlo', // prettier-ignore
  },
  /**
   * DOC-008. `document_render_supersedes_unique`.
   *
   * Two documents cannot annul the same one. It is the ordinary race — two
   * people correcting the same receta from two screens — and the honest answer
   * is that one of them already did it, not that something went wrong.
   */
  document_render_supersedes_unique: {
    code: 'DOCUMENT_ALREADY_SUPERSEDED',
    field: 'supersedesId',
    message: 'Ese documento ya fue anulado por otro. Actualice la lista para ver el vigente', // prettier-ignore
  },
  /**
   * DOC-008. `document_render_*_original_unique`: ONE original per subject;
   * the others supersede it. The ordinary race —«Emitir» pressed twice, or from
   * two tabs— and the answer is that the PDF already exists.
   */
  document_render_prescription_original_unique: {
    code: 'DOCUMENT_ALREADY_EMITTED',
    field: 'subjectId',
    message: 'Este documento ya tiene su PDF archivado. Descárguelo, o corríjalo si hay que cambiarlo', // prettier-ignore
  },
  document_render_service_order_original_unique: {
    code: 'DOCUMENT_ALREADY_EMITTED',
    field: 'subjectId',
    message: 'Este documento ya tiene su PDF archivado. Descárguelo, o corríjalo si hay que cambiarlo', // prettier-ignore
  },
  document_render_certificate_original_unique: {
    code: 'DOCUMENT_ALREADY_EMITTED',
    field: 'subjectId',
    message: 'Este documento ya tiene su PDF archivado. Descárguelo, o corríjalo si hay que cambiarlo', // prettier-ignore
  },
  /**
   * DOC-003. `document_render_one_subject` and
   * `document_render_kind_matches_subject`.
   *
   * UNREACHABLE THROUGH THIS MODULE: the repository writes the column that goes
   * with the kind, so the pair can only disagree if somebody writes the row by
   * hand. Registered because for that writer the honest answer is a sentence.
   */
  document_render_one_subject: {
    code: 'DOCUMENT_SUBJECT_INCONSISTENT',
    field: 'subjectId',
    message: 'Un documento archivado representa exactamente una receta, orden, certificado o factura', // prettier-ignore
  },
  document_render_kind_matches_subject: {
    code: 'DOCUMENT_KIND_MISMATCH',
    field: 'kind',
    message: 'El tipo de documento no concuerda con el origen que se está imprimiendo', // prettier-ignore
  },
  /**
   * DOC-050. `document_image_mime_type_allowed`.
   *
   * The service refuses the format first, by MAGIC BYTES, with the field named.
   * This is the same rule for the writer that did not come through the service.
   * ⚠️ SVG is refused here too, and permanently: an SVG executes scripts when it
   * is navigated to directly, and there are real CVEs of credential theft
   * through that path.
   */
  document_image_mime_type_allowed: {
    code: 'DOCUMENT_IMAGE_FORMAT_STORED_NOT_ALLOWED',
    field: 'mimeType',
    message: 'Sólo se guardan imágenes PNG o JPEG. El formato SVG no se acepta por seguridad', // prettier-ignore
  },
  /**
   * DOC-053. `document_image_pixels_bounded`.
   *
   * A decompression bomb that got past the byte cap. The application catches it
   * first, inside the decoder; this is the floor underneath.
   */
  document_image_pixels_bounded: {
    code: 'DOCUMENT_IMAGE_PIXELS_OUT_OF_BOUNDS',
    field: 'width',
    message: 'La imagen tiene demasiados píxeles. Redúzcala a un tamaño razonable para un logo o un sello', // prettier-ignore
  },
  /**
   * DOC-004, SC-061. `document_render_content_is_consistent` and
   * `document_render_sha256_format`.
   *
   * Both are the archive refusing to store something it could not later prove.
   * A `byte_size` that disagrees with the bytes is a `Content-Length` that
   * truncates a download; an uppercase or short `sha256` is a hash that
   * compares unequal to the same hash computed anywhere else.
   */
  document_render_content_is_consistent: {
    code: 'DOCUMENT_CONTENT_INCONSISTENT',
    field: 'byteSize',
    message: 'El documento archivado no concuerda con su tamaño declarado y no se guardó', // prettier-ignore
  },
  document_render_sha256_format: {
    code: 'DOCUMENT_SHA256_INVALID',
    field: 'sha256',
    message: 'La huella del documento no tiene el formato exigido y no se guardó', // prettier-ignore
  },
  /**
   * DOC-010. `document_render_supersession_states_why`.
   *
   * The DTO refuses a supersession with no reason first, with the box named.
   * Without a reason, annulling is a way of making what was emitted disappear.
   */
  document_render_supersession_states_why: {
    code: 'DOCUMENT_SUPERSEDE_REASON_REQUIRED',
    field: 'reason',
    message: 'Para anular un documento hay que decir por qué: sin motivo, anular es hacer desaparecer lo que se emitió', // prettier-ignore
  },
  /** DOC-035, DOC-036. The two slot shapes the database also checks. */
  document_template_accent_colour_format: {
    code: 'DOCUMENT_TEMPLATE_COLOUR_INVALID',
    field: 'accentColour',
    message: 'El color de acento se escribe como #rrggbb en minúsculas, por ejemplo #1f6f8b', // prettier-ignore
  },
  document_template_header_fields_bounded: {
    code: 'DOCUMENT_TEMPLATE_HEADER_FIELDS_INVALID',
    field: 'headerFields',
    message: 'La cabecera admite como mucho seis campos, cada uno con etiqueta y valor', // prettier-ignore
  },
});
