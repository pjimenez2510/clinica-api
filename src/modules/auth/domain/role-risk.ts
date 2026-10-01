import type { Permission } from '../../../shared/authorisation/permission.catalogue';

import { RISKY_COMBINATIONS } from './default-roles';

/**
 * AU-034 — combinations worth warning about, WITHOUT refusing them.
 *
 * The distinction is the requirement, not a softening of it. A small clinic
 * where the owner is also the doctor is a real situation, and refusing it
 * outright pushes them to share one account — which is strictly worse for the
 * trail, because then nothing can be attributed to anybody. So the system says
 * it out loud, the clinic decides, and the decision is recorded.
 *
 * PURE DOMAIN: no I/O, no framework. The warnings are Spanish because they are
 * read by whoever assigns the role (ADR-005).
 */

/** The prefix that identifies a permission over the clinical record. */
const RECORD_RESOURCE_PREFIX = 'record:';

/**
 * Permissions that open the clinical record, whatever their code says.
 *
 * `vitals:write` and `prescription:write` are `record` in the CATALOGUE's
 * resource column but not in their code, and both write into a patient's
 * history. Matching on the prefix alone would silently leave them out, which
 * is the kind of gap that only shows up in an audit.
 */
const CLINICAL_RECORD_PERMISSIONS: readonly Permission[] = [
  'record:read',
  'record:write',
  'record:sign',
  'vitals:write',
  'prescription:write',
];

/** AU-024's permission, and one half of AU-034's pair. */
const ADMINISTERS_USERS: Permission = 'user:manage';

/**
 * AU-034's own sentence. It names the audit that asks for it, because «esto es
 * arriesgado» without a reason is a warning people learn to click through.
 */
const RECORD_AND_ADMIN_WARNING =
  'Este rol administra usuarios y además accede a la historia clínica. Podría concederse a sí mismo el acceso y retirarlo después, y es la separación que una auditoría de la SPDP pregunta primero. Puede guardarlo igualmente si su clínica lo necesita.';

/**
 * AU-045 (D-071). Permissions whose holder is in front of the allergy — who
 * prescribes, who writes the note — and the one that records it, which is
 * the letter of D-071. Signing does not write. Whether a custom NURSING role
 * (`nursing:write`) without the allergy record should warn too is a question
 * D-071 raised and did not resolve: it is with the author, not decided here.
 */
const WRITES_THE_RECORD: readonly Permission[] = [
  'prescription:write',
  'record:write',
];
const RECORDS_ALLERGIES: Permission = 'background:write';

/** AU-045's sentence, as the author fixed it (D-071, 30-09-2026). */
const NO_ALLERGY_RECORD_WARNING =
  'Este rol receta o escribe en la historia clínica pero no puede registrar alergias ni antecedentes. Puede guardarlo igualmente.';

/**
 * Prefix match OR the explicit list: see `CLINICAL_RECORD_PERMISSIONS` for the
 * permissions the prefix misses.
 */
function holdsAnyClinicalRecord(permissions: readonly string[]): boolean {
  return permissions.some(
    (code) =>
      code.startsWith(RECORD_RESOURCE_PREFIX) ||
      CLINICAL_RECORD_PERMISSIONS.includes(code as Permission),
  );
}

/**
 * Everything worth telling the administrator before this permission set is
 * saved. An empty array means nothing to say — never a refusal.
 *
 * AU-045 IS ITS OWN SENTENCE, about a gap rather than a combination, and
 * goes right after AU-034's.
 *
 * FOR THE PAIR OF AU-034, ONLY ONE SOURCE FIRES. AU-034 generalises the
 * first entry of `RISKY_COMBINATIONS` (`user:manage` + `record:read`) to the
 * whole `record:*` family, so that entry is skipped when the general rule
 * already covers it: two warnings about the same concern, worded differently,
 * is how a screen teaches people to stop reading them.
 */
export function warningsFor(permissions: readonly string[]): string[] {
  const held = new Set(permissions);
  const warnings: string[] = [];

  const administersUsers = held.has(ADMINISTERS_USERS);
  const readsRecord = holdsAnyClinicalRecord(permissions);

  // AU-034. WARNS, never refuses.
  if (administersUsers && readsRecord) warnings.push(RECORD_AND_ADMIN_WARNING);

  // AU-045. After AU-034, so each says its own thing once.
  if (
    WRITES_THE_RECORD.some((code) => held.has(code)) &&
    !held.has(RECORDS_ALLERGIES)
  ) {
    warnings.push(NO_ALLERGY_RECORD_WARNING);
  }

  for (const combination of RISKY_COMBINATIONS) {
    // Already said, in its general form.
    const isTheRecordPair =
      combination.permissions.includes(ADMINISTERS_USERS) &&
      holdsAnyClinicalRecord(combination.permissions);
    if (isTheRecordPair && administersUsers && readsRecord) continue;

    if (combination.permissions.every((code) => held.has(code))) {
      warnings.push(combination.warning);
    }
  }

  return warnings;
}
