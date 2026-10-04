import type { NewPrescriptionItem } from './prescription.repository';
import {
  doseText,
  dosageFormLabel,
  frequencyText,
  type DosageForm,
  type DoseUnit,
  type Frequency,
} from './prescription-vocabulary';

/** PR-101, PR-102. A line as the prescriber writes it: codes, not sentences. */
export interface WrittenItem {
  conceptId: string | null;
  genericName: string | null;
  dosageForm: DosageForm;
  concentration: string;
  routeCode: string;
  quantity: number;
  doseAmount: number;
  doseUnit: DoseUnit;
  frequency: Frequency | null;
  frequencyText: string | null;
  durationDays: number;
  instructions: string | null;
  offFormularyJustification: string | null;
}

/**
 * PR-101, PR-102. The line as it is stored: the sentences composed here from
 * the codes — never sent by the caller — and the codes kept beside them.
 */
export function writeItem(item: WrittenItem): NewPrescriptionItem {
  return {
    conceptId: item.conceptId,
    genericName: item.genericName,
    presentation: dosageFormLabel(item.dosageForm),
    concentration: item.concentration,
    routeCode: item.routeCode,
    quantity: item.quantity,
    doseText: doseText(item.doseAmount, item.doseUnit),
    frequencyText: frequencyText(item.frequency, item.frequencyText),
    durationDays: item.durationDays,
    instructions: item.instructions,
    offFormularyJustification: item.offFormularyJustification,
    dosageFormCode: item.dosageForm,
    doseAmount: item.doseAmount,
    doseUnitCode: item.doseUnit,
    frequencyCode: item.frequency,
  };
}
