import { registerConstraintMeanings } from './constraint-meanings';

/**
 * EN-210, D-127. `record_version_archive` is ONE trigger shared by every
 * versioned table, so its meaning belongs to no module: it lives beside the
 * mapping that reads it, like `pending-constraints.ts`.
 *
 * Reaching it from the API is a bug in the adapter — every edit path stamps
 * who and when — but a script or an assistant that skips the stamp gets a
 * 422 that says what is missing instead of a 500.
 */
registerConstraintMeanings({
  record_version_change_is_stamped: {
    code: 'EDIT_NOT_STAMPED',
    field: 'record',
    message: 'Toda corrección dice quién la hizo y cuándo',
  },
});
