import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * See `agenda.constraints.ts` for why each module registers its own.
 *
 * NOT REGISTERED HERE, deliberately: `app_user_email_key`, `role_code_key` and
 * the RESTRICT foreign key from `user_role_grant`. Those are translated by the
 * repositories themselves into the domain errors whose codes the SPEC fixes —
 * the registry cannot, because the right status for a foreign-key refusal
 * depends on the operation (422 on insert, 409 on delete) and only the
 * repository knows which one it ran.
 *
 * What remains here is the safety net for the CHECK constraints of the
 * authorisation tables, which the services refuse before reaching: a data
 * import, a migration script, a `psql` at two in the morning.
 */
registerConstraintMeanings({
  /**
   * Separation of duties, in the base since the roles migration: «the audit
   * question "who gave this person access to clinical records" must never
   * answer "they did"». `AccountsService` refuses it first so the message is
   * a sentence rather than `CHECK_FAILED`; this is what a write that dodged
   * the service reads back, with the same wording so the two cannot disagree.
   */
  user_role_grant_no_self_grant: {
    code: 'CANNOT_GRANT_TO_SELF',
    field: 'grants',
    message:
      'Nadie puede concederse a sí mismo un rol. Pídaselo a otra persona con administración de usuarios',
  },
  /** A revocation cannot precede its grant. */
  user_role_grant_revocation_order: {
    code: 'INVALID_GRANT_DATES',
    field: 'grants',
    message: 'La revocación no puede ser anterior a la concesión',
  },
  /**
   * AU-030. A role code is an identifier, not a label: it appears in seeds, in
   * logs and in support conversations, and lowercase or spaced codes make
   * those unsearchable.
   */
  role_code_shape: {
    code: 'INVALID_ROLE_CODE',
    field: 'code',
    message:
      'El código va en mayúsculas, sin espacios ni tildes, y tiene entre 3 y 48 caracteres. Por ejemplo: AUDITOR_EXTERNO',
  },
});
