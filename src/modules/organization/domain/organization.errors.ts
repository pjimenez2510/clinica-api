import {
  ConflictError,
  NotFoundError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong administering the establishment, its sites, its consulting
 * rooms and its points of emission, in business terms.
 *
 * No HTTP here: the category decides the status in `problem-details.filter.ts`
 * (NotFoundError is 404, ConflictError 409). The codes are fixed by the SPEC's
 * error table, and the guarantees behind the duplicates and the "in use" are
 * PostgreSQL's — unique indexes and FK RESTRICT — so these classes are defined
 * HERE and only thrown from the adapter, which is the constitution's rule:
 * infrastructure throws domain errors, it does not define them.
 *
 * `INVALID_RUC` (OR-008) is NOT here on purpose: it is the invariant of the
 * `Ruc` value object and lives beside it in `shared/domain`, because billing
 * validates the same number for a different reason (REQ-085) and a module may
 * not import another.
 *
 * `ROOM_NOT_IN_SITE` (OR-021) is not here either: this module declares the
 * guarantee and now enforces it in the base with a composite foreign key, but
 * the error is raised where a booking is attempted, which is `agenda`.
 */

/**
 * No establishment has been registered yet. A real state, not a corrupt one:
 * a fresh installation has none until somebody fills the form, and OR-001
 * forbids operating until they do.
 */
export class EstablishmentNotFoundError extends NotFoundError {
  readonly code = 'ESTABLISHMENT_NOT_FOUND';
  override readonly userTitle =
    'Todavía no se ha registrado el establecimiento. Regístrelo con su tipología y su código único del MSP antes de operar';

  constructor() {
    super('No establishment registered');
  }
}

/**
 * OR-002. The MSP's unique code identifies the establishment in every single
 * attention the RDACAA reports (REQ-020), so two rows carrying the same one
 * would make the report ambiguous at the source. The guarantee is
 * `establishment_msp_unicode_unique` and the unique index on `site`.
 */
export class MspUnicodeDuplicateError extends ConflictError {
  readonly code = 'MSP_UNICODE_DUPLICATE';
  override readonly userTitle =
    'Ese código único del MSP ya está registrado. Cada establecimiento y cada sede tiene el suyo';

  constructor() {
    // No rejected value in the message: it reaches logs and screenshots.
    super('MSP unique code already exists', {}, [
      {
        field: 'mspUnicode',
        code: 'MSP_UNICODE_DUPLICATE',
        message: 'Ese código único del MSP ya pertenece a otro registro',
      },
    ]);
  }
}

/** The site does not exist. Never says whether it once did. */
export class SiteNotFoundError extends NotFoundError {
  readonly code = 'SITE_NOT_FOUND';
  override readonly userTitle =
    'La sede indicada no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Site not found');
  }
}

/**
 * OR-006. Deleting a site referenced by an appointment, an encounter, a
 * practitioner or a role grant is refused; offering deactivation instead is
 * the other half of the requirement, and it travels in the user-facing
 * sentence. The guarantee is the FK `ON DELETE RESTRICT`, so this is raised
 * from the adapter when PostgreSQL says no.
 */
export class SiteInUseError extends ConflictError {
  readonly code = 'SITE_IN_USE';
  override readonly userTitle =
    'La sede está en uso y no puede borrarse. Puede desactivarla para que no se ofrezca en nuevas citas ni asignaciones';

  constructor() {
    super('Site is referenced and cannot be deleted');
  }
}

/** The consulting room does not exist. */
export class SiteRoomNotFoundError extends NotFoundError {
  readonly code = 'SITE_ROOM_NOT_FOUND';
  override readonly userTitle =
    'El consultorio indicado no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Site room not found');
  }
}

/**
 * OR-020. Two rooms may not share a name inside one site — «Consultorio 1»
 * twice is how a receptionist sends a patient to the wrong floor. The
 * guarantee is the unique index on `(site_id, name)`.
 */
export class SiteRoomDuplicateError extends ConflictError {
  readonly code = 'SITE_ROOM_DUPLICATE';
  override readonly userTitle =
    'Ya existe un consultorio con ese nombre en la sede. Revise la lista antes de crear otro';

  constructor() {
    super('Room name already exists within the site', {}, [
      {
        field: 'name',
        code: 'SITE_ROOM_DUPLICATE',
        message: 'Ese nombre ya pertenece a otro consultorio de la sede',
      },
    ]);
  }
}

/**
 * OR-022. A room referenced by an appointment cannot be deleted, and
 * deactivating it is what the requirement actually asks for: existing
 * appointments stay intact and no new one is offered the room.
 */
export class SiteRoomInUseError extends ConflictError {
  readonly code = 'SITE_ROOM_IN_USE';
  override readonly userTitle =
    'El consultorio está en uso y no puede borrarse. Puede desactivarlo para que no se ofrezca en nuevas citas';

  constructor() {
    super('Site room is referenced and cannot be deleted');
  }
}

/** The point of emission does not exist. */
export class EmissionPointNotFoundError extends NotFoundError {
  readonly code = 'EMISSION_POINT_NOT_FOUND';
  override readonly userTitle =
    'El punto de emisión indicado no existe. Actualice la lista e intente de nuevo';

  constructor() {
    super('Emission point not found');
  }
}

/**
 * OR-024. Two points of emission may not share a code inside one site: the
 * SRI numbers comprobantes per point, and a repeated code would make two
 * sequences collide the day `billing` starts issuing (REQ-085). The guarantee
 * is `emission_point_code_unique_per_site`.
 */
export class EmissionPointDuplicateError extends ConflictError {
  readonly code = 'EMISSION_POINT_DUPLICATE';
  override readonly userTitle =
    'Ya existe un punto de emisión con ese código en la sede. Revise la lista antes de crear otro';

  constructor() {
    super('Emission point code already exists within the site', {}, [
      {
        field: 'code',
        code: 'EMISSION_POINT_DUPLICATE',
        message: 'Ese código ya pertenece a otro punto de emisión de la sede',
      },
    ]);
  }
}

/**
 * OR-030. Another site invoicing under the same RUC already has that SRI
 * establishment code. Its guarantee is
 * `site_sri_establishment_code_unique_per_ruc`.
 */
export class SriEstablishmentCodeDuplicateError extends ConflictError {
  readonly code = 'SRI_ESTABLISHMENT_CODE_DUPLICATE';
  override readonly userTitle =
    'Otra sede que factura con el mismo RUC ya tiene ese código de establecimiento SRI. Use el que el SRI asignó a esta sede';

  constructor() {
    super(
      'SRI establishment code already used by another site of the RUC',
      {},
      [
        {
          field: 'sriEstablishmentCode',
          code: 'SRI_ESTABLISHMENT_CODE_DUPLICATE',
          message:
            'Ese código ya es de otra sede: dos sedes con el mismo código numerarían igual sus facturas',
        },
      ],
    );
  }
}
