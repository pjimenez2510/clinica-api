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
 */
registerConstraintMeanings({
  encounter_vitals_ranges: {
    code: 'VITALS_OUT_OF_RANGE',
    field: 'vitals',
    message: 'Alguno de los signos vitales está fuera de rango: revise los valores ingresados', // prettier-ignore
  },
  clinical_note_one_current_per_chain: {
    code: 'NOTE_ALREADY_CURRENT',
    field: 'chainId',
    message: 'Esta nota ya tiene una versión vigente',
  },
});
