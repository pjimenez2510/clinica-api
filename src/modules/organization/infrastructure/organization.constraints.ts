import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * See `agenda.constraints.ts` for why each module registers its own.
 *
 * NOT REGISTERED HERE, deliberately: the unique indexes
 * (`establishment_msp_unicode_unique`, `site_msp_unicode_key`,
 * `site_room_site_id_name_key`, `emission_point_code_unique_per_site`) and the
 * RESTRICT foreign keys. Those are translated by the repository itself into
 * the domain errors whose codes the SPEC fixes — the registry cannot, because
 * the right status for a foreign-key refusal depends on the operation (422 on
 * insert, 409 on delete) and only the repository knows which one it ran.
 *
 * What remains here is the safety net for writes that bypass the repository's
 * translation: a data import, a migration script, a `psql` at two in the
 * morning.
 */
registerConstraintMeanings({
  // OR-021 (AG-105) moved into the base with this delivery: the composite
  // foreign key refuses a room that is not the appointment's own site. The
  // agenda checks it first and answers `ROOM_NOT_IN_SITE`; this is what a
  // write that dodged the agenda service reads back, with the same wording so
  // the two cannot say different things.
  agenda_entry_room_in_site: {
    code: 'ROOM_NOT_IN_SITE',
    field: 'roomId',
    message: 'El consultorio seleccionado no pertenece a esa sede',
  },
  // OR-023: three digits, and the leading zero is significant.
  emission_point_code_format: {
    code: 'INVALID_EMISSION_POINT_CODE',
    field: 'code',
    message: 'El punto de emisión son exactamente tres dígitos, como 001',
  },
  // OR-008: the shape of a RUC. The rest of the rule is the `Ruc` value object's,
  // which answers per-field long before the base is reached.
  establishment_ruc_format: {
    code: 'INVALID_RUC',
    field: 'ruc',
    message:
      'El RUC son trece dígitos y termina en un código de establecimiento como 001',
  },
  // OR-027. The DTO refuses the shape first; this is the base's own refusal.
  site_sri_establishment_code_format: {
    code: 'INVALID_SRI_ESTABLISHMENT_CODE',
    field: 'sriEstablishmentCode',
    message:
      'El código de establecimiento del SRI son exactamente tres dígitos, como 001',
  },
  site_ruc_format: {
    code: 'INVALID_RUC',
    field: 'ruc',
    message:
      'El RUC son trece dígitos y termina en un código de establecimiento como 001',
  },
});
