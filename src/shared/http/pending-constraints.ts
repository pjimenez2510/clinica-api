import { registerConstraintMeanings } from './constraint-meanings';

/**
 * Constraints whose OWNING MODULE does not exist yet.
 *
 * The `encounter` and `clinical_note` tables were migrated in Fase 0 with the
 * rest of the clinical core, so these constraints are real and integration
 * tests exercise them — but no module owns them, because encounter is not
 * built. Their meanings wait here, quarantined and visible, instead of mixed
 * into a shared map that pretends they belong to nobody.
 *
 * WHEN THE ENCOUNTER MODULE IS CREATED: move each entry into its
 * `encounter.constraints.ts` and delete it here. This file should end up
 * empty and removed. Adding a NEW entry here instead of in a module is a
 * mistake unless the module genuinely does not exist yet.
 *
 * `encounter_vitals_ranges` left on 30-09-2026: the constraint was split into
 * one per measure (D-058, `20260930124150_encounter_vitals_ranges_per_measure`)
 * and each one is registered in `encounter.constraints.ts` with its own field.
 */
registerConstraintMeanings({
  clinical_note_one_current_per_chain: {
    code: 'NOTE_ALREADY_CURRENT',
    field: 'chainId',
    message: 'Esta nota ya tiene una versión vigente',
  },
});
