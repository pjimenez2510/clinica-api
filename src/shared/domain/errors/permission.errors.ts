import { BusinessRuleViolation, ConflictError } from './domain-error';

/**
 * The two ways a permission CODE handed in as data can be wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THEY LIVE IN `shared/` AND NOT IN `modules/auth/`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * They were auth's until 14-08-2026, when a SECOND module started storing a
 * permission code: `site_parameter.overbooking_permission` — which permission
 * authorises an overbooking at this site (AG-094, AG-101, D-005). That column
 * is data, and the question «is this a permission the code declares?» is
 * exactly the one `roles.service.ts` already answers for a role's checkboxes.
 *
 * A `code` is public contract and `error-catalogue.spec.ts` refuses two
 * classes declaring the same one — rightly: two classes answering
 * `UNKNOWN_PERMISSION` are two situations no client can tell apart. And no
 * module imports another. So the class moves to where both can reach it, the
 * same route `SERVICE_TYPE_NOT_FOUND` and `PATIENT_MERGED` took. THE CHAIN IS
 * UNCHANGED: same `code`, same status, same sentences for the roles screen.
 */

/**
 * AU-033. A permission code the CODE does not declare.
 *
 * Permissions are not data: each one corresponds to a check in a route, so a
 * code invented in a row protects nothing and, worse, reads on the screen as a
 * promise the system does not keep. The catalogue in
 * `shared/authorisation/permission.catalogue.ts` is the enumeration, and this
 * is what a client gets for sending anything outside it.
 */
export class UnknownPermissionError extends BusinessRuleViolation {
  readonly code = 'UNKNOWN_PERMISSION';
  override readonly userTitle =
    'Alguno de los permisos indicados no existe en el sistema. Actualice la pantalla: los permisos los define el programa, no se pueden inventar';

  /**
   * `field` is the box the sentence lands under. It defaults to the roles
   * screen's `permissions` because that is where this rule was born; the site
   * parameter names its own column, or the refusal would highlight a field
   * that form does not have.
   */
  constructor(unknown: readonly string[], field = 'permissions') {
    super('One or more permission codes are not in the catalogue', {}, [
      {
        field,
        code: 'UNKNOWN_PERMISSION',
        // The rejected codes ARE named: they came from the caller, they are
        // not personal data, and hiding them makes the failure unreportable.
        message: `Permisos desconocidos: ${unknown.join(', ')}`,
      },
    ]);
  }
}

/**
 * AU-033. The code declares the permission; THIS INSTALLATION'S DATABASE has
 * not been told about it yet.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT THE SAME FAILURE AS `UNKNOWN_PERMISSION`, AND SAYING SO IS THE POINT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `permission` is a MIRROR of the catalogue in the code, kept so grants have
 * referential integrity. The screen reads the catalogue from the CODE — that is
 * deliberate, and `RolesService.catalogue()` explains why — so between deploying
 * a version that declares a new permission and running `pnpm db:seed:auth`, the
 * screen offers a checkbox the foreign key will refuse.
 *
 * WHAT THAT LOOKED LIKE BEFORE THIS ERROR EXISTED: `RELATED_RECORD_MISSING`,
 * rendered as «Datos inválidos» over a form where nothing was invalid. Whoever
 * was granting `user:reset-mfa` to somebody so a doctor could get back into the
 * system had no way to learn that the answer was one command on the server, and
 * the obvious next move — untick, retick, try another role — cannot work.
 *
 * The sentence is written for whoever is at the screen and cannot fix it, so it
 * says who can. The command belongs in this comment, not on a screen a
 * receptionist reads.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SENTENCE THAT MATTERS IS THE FIELD ERROR'S, NOT `userTitle`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `clinica-web` renders `ApiError.userMessage`, which prefers
 * `errors[0].message` and falls back to `title`. This error ALWAYS carries a
 * field error, so `userTitle` is what a client without that rule would show and
 * the field error is what the administration screen actually displays. The
 * first version put the action in `userTitle` and a bare list of codes in the
 * field error — so the screen read «Permisos sin instalar: user:reset-mfa» and
 * every word about what to do next died on the way. Both say the same thing
 * now, and the one that is read names the codes.
 *
 * IT DOES NOT PROMISE A PARTIAL SAVE, because there is none: nothing is
 * written. «Desmárquelo para guardar el resto» is an instruction for the next
 * attempt, and the earlier wording — «los demás permisos sí se pueden
 * guardar» — could be read on a rejected save as «the rest went through».
 *
 * A CONFLICT AND NOT A VALIDATION ERROR: what was sent is perfectly valid and
 * the code does declare it. It is the state of the installation that prevents
 * the operation, which is exactly what 409 means here.
 */
export class PermissionNotInstalledError extends ConflictError {
  readonly code = 'PERMISSION_NOT_INSTALLED';
  override readonly userTitle =
    'Alguno de los permisos elegidos todavía no está instalado en el sistema, así que no se puede conceder. Avise a quien administra la instalación';

  constructor(missing: readonly string[], field = 'permissions') {
    super(
      'The permission catalogue in the database lags the one in the code; run the authorisation sync',
      {},
      [
        {
          field,
          code: 'PERMISSION_NOT_INSTALLED',
          // The codes are named for the same reason `UnknownPermissionError`
          // names its own: they came from the caller, they are not personal
          // data, and a support call that cannot quote the code is
          // unactionable.
          message: sentenceFor(missing, field),
        },
      ],
    );
  }
}

/**
 * Singular and plural, because the constructor takes a list and a screen that
 * says «estos permisos» over one line reads like a bug.
 *
 * AND THE REMEDY DEPENDS ON THE SCREEN. On the roles form the permission is
 * one tick among forty, so «desmárquelo» is an instruction that works. On the
 * site parameters form it is ONE value in a single box: there is nothing to
 * untick, and telling somebody to do it would send them looking for a checkbox
 * that is not there.
 */
function sentenceFor(missing: readonly string[], field: string): string {
  const ticked = field === 'permissions';
  const action = ticked
    ? 'para guardar el resto, y avise a quien administra la instalación'
    : 'y avise a quien administra la instalación';
  const one = ticked ? 'Desmárquelo' : 'Elija otro';
  const many = ticked ? 'Desmárquelos' : 'Elija otros';

  return missing.length === 1
    ? `«${missing[0]}» todavía no está instalado en el sistema. ${one} ${action}.`
    : `Estos permisos todavía no están instalados en el sistema: ${missing.join(', ')}. ${many} ${action}.`;
}
