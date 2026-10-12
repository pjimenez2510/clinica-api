import { describe, expect, it } from 'vitest';

import {
  allergyVerdictOf,
  backedLines,
  blockOf,
  canonicalLine,
  cnmbSearchName,
  knownCodes,
  presentationFor,
  proposedFields,
  totalOf,
  writtenByWeight,
  type BackedLine,
  type PrescriptionProposal,
  type ReadLine,
} from './prescription-reading';

const NOTE = [
  {
    key: 'plan',
    text: 'Amoxicilina 500 mg, una tableta cada 8 horas por 7 días. No dar ibuprofeno por la gastritis.',
  },
];

function read(overrides: Partial<ReadLine> = {}): ReadLine {
  return {
    drug: 'Amoxicilina',
    strength: '500 mg',
    form: 'TABLET',
    doseAmount: 1,
    doseUnit: 'TABLET',
    route: null,
    frequency: 'EVERY_8_HOURS',
    frequencyText: null,
    durationDays: 7,
    instructions: null,
    quote: 'Amoxicilina 500 mg, una tableta cada 8 horas por 7 días',
    ...overrides,
  };
}

function backed(overrides: Partial<BackedLine> = {}): BackedLine {
  return { ...read(), section: 'plan', ...overrides };
}

const TABLET_500 = {
  form: 'TABLET',
  forms: ['TABLET', 'COATED_TABLET', 'CAPSULE'],
  concentration: '500 mg',
  route: 'O - Oral',
};

describe('the phrase of each line (AS-063)', () => {
  const sameText = (text: string) => text;

  it('AS-063 keeps a line whose phrase the note writes, with the note’s own sentence and section', () => {
    const { kept, dropped } = backedLines({
      read: [read()],
      cleared: NOTE[0]!.text,
      sections: NOTE,
      restore: sameText,
    });

    expect(dropped).toBe(0);
    expect(kept).toEqual([
      backed({
        quote: 'Amoxicilina 500 mg, una tableta cada 8 horas por 7 días.',
      }),
    ]);
  });

  it('AS-063 drops a line whose phrase is not in the note, or that the note denies', () => {
    const { kept, dropped } = backedLines({
      read: [
        read({ quote: 'Azitromicina 500 mg una vez al día' }),
        read({ drug: 'Ibuprofeno', quote: 'dar ibuprofeno por la gastritis' }),
        read(),
      ],
      cleared: NOTE[0]!.text,
      sections: NOTE,
      restore: sameText,
    });

    expect(dropped).toBe(2);
    expect(kept.map((line) => line.drug)).toEqual(['Amoxicilina']);
  });

  it('AS-063 puts the pseudonymizer’s markers back before looking for the phrase in the note', () => {
    const note = [{ key: 'plan', text: 'Indicaciones de la doctora Pérez: paracetamol 500 mg cada 8 horas.' }]; // prettier-ignore
    const { kept } = backedLines({
      read: [read({ drug: 'Paracetamol', quote: 'doctora [PERSONA_1]: paracetamol 500 mg cada 8 horas' })], // prettier-ignore
      cleared:
        'Indicaciones de la doctora [PERSONA_1]: paracetamol 500 mg cada 8 horas.',
      sections: note,
      restore: (text) => text.replace('[PERSONA_1]', 'Pérez'),
    });

    expect(kept).toHaveLength(1);
  });
});

describe('the presentation (AS-066)', () => {
  it('AS-066 takes the presentation the note’s form and strength agree with, in the cuadro’s words', () => {
    expect(presentationFor(TABLET_500, { form: 'CAPSULE', strength: '500 MG' })).toEqual({ form: 'CAPSULE', concentration: '500 mg', route: 'O - Oral' }); // prettier-ignore
  });

  it('AS-066 a presentation that contradicts the written strength or form is no presentation', () => {
    expect(presentationFor(TABLET_500, { form: null, strength: '250 mg' })).toBeNull(); // prettier-ignore
    expect(presentationFor(TABLET_500, { form: 'SYRUP', strength: null })).toBeNull(); // prettier-ignore
    expect(presentationFor(undefined, { form: null, strength: null })).toBeNull(); // prettier-ignore
    // Control: with nothing written, the chosen presentation stands.
    expect(presentationFor(TABLET_500, { form: null, strength: null })?.form).toBe('TABLET'); // prettier-ignore
  });

  it('AS-066 a range of the cuadro takes the figure written inside it, and no figure when none was written', () => {
    const range = { form: 'TABLET', concentration: '1 mg - 5 mg' };
    expect(presentationFor(range, { form: null, strength: '2 mg' })?.concentration).toBe('2 mg'); // prettier-ignore
    expect(presentationFor(range, { form: null, strength: '7 mg' })).toBeNull();
    expect(presentationFor(range, { form: null, strength: null })?.concentration).toBeNull(); // prettier-ignore
  });
});

describe('what the system fills in, and marks (AS-067, AS-068)', () => {
  it('AS-067 amoxicillin 500 mg every 8 hours for 7 days: 21 tablets, the quantity and the route marked «Nadie lo dijo»', () => {
    const chosen = presentationFor(TABLET_500, { form: 'TABLET', strength: '500 mg' }); // prettier-ignore
    const { fields, unsaid } = proposedFields(backed(), chosen);

    expect(fields).toEqual({
      form: 'TABLET',
      concentration: '500 mg',
      route: 'ORAL',
      doseAmount: 1,
      doseUnit: 'TABLET',
      frequency: 'EVERY_8_HOURS',
      frequencyText: null,
      durationDays: 7,
      quantity: 21,
    });
    expect(unsaid).toEqual(['route', 'quantity']);
  });

  it('AS-067 «500 mg» of a 500 mg tablet is one tablet, marked; of a 1 000 mg tablet nothing is guessed', () => {
    const line = backed({ doseAmount: null, doseUnit: null });
    const once = proposedFields(line, presentationFor(TABLET_500, { form: null, strength: '500 mg' })); // prettier-ignore
    expect(once.fields.doseAmount).toBe(1);
    expect(once.unsaid).toContain('dose');

    const bigger = { ...TABLET_500, concentration: '1000 mg' };
    const none = proposedFields(
      backed({ doseAmount: null, doseUnit: null, strength: '500 mg' }),
      presentationFor(bigger, { form: null, strength: null }),
    );
    expect(none.fields.doseAmount).toBeNull();
    expect(none.fields.quantity).toBeNull();
  });

  it('AS-067 a presentation chosen with no strength written is marked', () => {
    const { unsaid } = proposedFields(
      backed({ strength: null }),
      presentationFor(TABLET_500, { form: null, strength: null }),
    );
    expect(unsaid).toContain('presentation');
  });

  it('AS-067 the quantity only for a counted unit with a fixed frequency and a duration', () => {
    expect(totalOf(1, 'TABLET', 'EVERY_12_HOURS', 10)).toBe(20);
    expect(totalOf(0.5, 'TABLET', 'ONCE_DAILY', 5)).toBe(3);
    expect(totalOf(1, 'TABLET', 'ONCE_WEEKLY', 28)).toBe(4);
    expect(totalOf(2, 'TABLET', 'SINGLE_DOSE', null)).toBe(2);
    // A syrup goes by the bottle; a written frequency or no duration is not counted.
    expect(totalOf(5, 'MILLILITRE', 'EVERY_8_HOURS', 5)).toBeNull();
    expect(totalOf(1, 'TABLET', null, 5)).toBeNull();
    expect(totalOf(1, 'TABLET', 'EVERY_8_HOURS', null)).toBeNull();
  });

  it('AS-068 a dose written by weight leaves the dose and the quantity empty, and nothing reads the weight', () => {
    const line = backed({
      quote:
        'Amoxicilina suspensión 50 mg/kg/día dividido cada 8 horas por 7 días',
      doseAmount: 50,
      doseUnit: 'MILLIGRAM',
    });
    const { fields, unsaid, doseByWeight } = proposedFields(line, null);

    expect(doseByWeight).toBe(true);
    expect(fields.doseAmount).toBeNull();
    expect(fields.doseUnit).toBeNull();
    expect(fields.quantity).toBeNull();
    expect(unsaid).not.toContain('quantity');
    expect(writtenByWeight('15 mg por kilo cada 6 horas')).toBe(true);
    // Control: a plain dose is not «by weight».
    expect(writtenByWeight('Amoxicilina 500 mg cada 8 horas')).toBe(false);
  });

  it('AS-067 «Dosis única» carries no duration (PR-105)', () => {
    const { fields } = proposedFields(
      backed({ frequency: 'SINGLE_DOSE', durationDays: 1 }),
      null,
    );
    expect(fields.durationDays).toBeNull();
  });
});

describe('the line as one text (AS-072, AS-074)', () => {
  it('AS-074 two lines that say the same compare equal, and a changed dose does not', () => {
    const fields = proposedFields(backed(), presentationFor(TABLET_500, { form: 'TABLET', strength: '500 mg' })).fields; // prettier-ignore
    const same = canonicalLine('c-1', { ...fields, doseAmount: 1.0 });
    expect(canonicalLine('c-1', fields)).toBe(same);
    expect(canonicalLine('c-1', { ...fields, doseAmount: 2 })).not.toBe(same);
    expect(canonicalLine('c-1', fields)).toBe(
      'c-1 | TABLET | 500 mg | ORAL | 1 TABLET | EVERY_8_HOURS | 7 | 21',
    );
  });
});

describe('the allergy rule and what blocks a line (AS-065, AS-069, AS-071)', () => {
  const amoxicillin = 'concept-amoxicillin';
  const keys = new Map([
    [amoxicillin, ['J01CA04', 'dci:amoxicilina']],
    ['concept-penicillin', ['J01CE01', 'dci:bencilpenicilina']],
    ['concept-old-amoxicillin', ['AMOXICILINA', 'dci:amoxicilina']],
  ]);
  const allergy = (substanceConceptId: string | null) => ({
    id: 'a-1',
    substanceConceptId,
    substanceText: 'Alergia',
  });

  it('AS-069 exact by substance key across editions, the same ATC class, or nothing', () => {
    expect(allergyVerdictOf(amoxicillin, [allergy('concept-old-amoxicillin')], keys)).toBe('exact'); // prettier-ignore
    expect(allergyVerdictOf(amoxicillin, [allergy('concept-penicillin')], keys)).toBe('class'); // prettier-ignore
    // PR-064. Free text never matches: comparing texts makes false alerts.
    expect(allergyVerdictOf(amoxicillin, [allergy(null)], keys)).toBe('none');
    expect(allergyVerdictOf(amoxicillin, [], keys)).toBe('none');
  });

  const proposal = (overrides: Partial<PrescriptionProposal> = {}) =>
    ({
      medicine: { conceptId: amoxicillin, code: 'J01CA04', display: 'Amoxicilina' }, // prettier-ignore
      controlled: false,
      ...overrides,
    }) as PrescriptionProposal;
  const none = new Set<string>();

  it('AS-065 AS-070 AS-071 a line without medicine, controlled, unchecked, allergic or already prescribed does not go', () => {
    expect(blockOf(proposal({ medicine: null }), { prescribed: none, allergy: 'none' })).toBe('not-in-cnmb'); // prettier-ignore
    expect(blockOf(proposal({ controlled: true }), { prescribed: none, allergy: 'none' })).toBe('controlled'); // prettier-ignore
    expect(blockOf(proposal(), { prescribed: none, allergy: 'failed' })).toBe('allergy-check-failed'); // prettier-ignore
    expect(blockOf(proposal(), { prescribed: none, allergy: 'exact' })).toBe('allergy-exact'); // prettier-ignore
    expect(blockOf(proposal(), { prescribed: new Set(['J01CA04']), allergy: 'none' })).toBe('already-prescribed'); // prettier-ignore
    // Control: the class informs and the line goes (AS-071).
    expect(blockOf(proposal(), { prescribed: none, allergy: 'class' })).toBeNull(); // prettier-ignore
    expect(blockOf(proposal(), { prescribed: none, allergy: 'none' })).toBeNull(); // prettier-ignore
  });
});

describe('the codes the model wrote (AS-063)', () => {
  it('AS-063 keeps a code of the receta’s lists and empties anything else, never guessing', () => {
    const line = knownCodes({ ...read(), form: 'COMPRIMIDO', doseUnit: 'TABLET', route: 'oral', frequency: 'EVERY_8_HOURS' }); // prettier-ignore

    expect([line.form, line.doseUnit, line.route, line.frequency]).toEqual([null, 'TABLET', null, 'EVERY_8_HOURS']); // prettier-ignore
    expect(knownCodes({ ...read(), form: 'toString' }).form).toBeNull();
  });
});

describe('the name the cuadro is searched by (AS-064)', () => {
  it('AS-064 a combination written «con», «y» or «/» is searched as the cuadro writes it, with «+»', () => {
    expect(cnmbSearchName('amoxicilina con ácido clavulánico')).toBe('amoxicilina + ácido clavulánico'); // prettier-ignore
    expect(cnmbSearchName('Telmisartán y amlodipino')).toBe('Telmisartán + amlodipino'); // prettier-ignore
    expect(cnmbSearchName('sulfametoxazol/trimetoprima')).toBe('sulfametoxazol + trimetoprima'); // prettier-ignore
    // Control: a plain name is searched as written.
    expect(cnmbSearchName('Amoxicilina')).toBe('Amoxicilina');
  });
});
