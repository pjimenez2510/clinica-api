import { describe, expect, it } from 'vitest';

import {
  allergyVerdictOf,
  backedLines,
  blockOf,
  backedFields,
  canonicalLine,
  choosePresentation,
  chosenIsWritten,
  cnmbSearchName,
  cuadroStrength,
  knownCodes,
  presentationFor,
  proposedFields,
  strengthIn,
  totalOf,
  writtenByWeight,
  writtenStrength,
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

  it('AS-291 does not propose what the note only says to keep taking, unless it says how', () => {
    const plan = [
      {
        key: 'plan',
        text: 'Continuar con losartán habitual. Continuar con pastillas anticonceptivas de manera habitual. Continuar amoxicilina 500 mg cada 8 horas por 3 días más.',
      },
    ];
    const keep = (drug: string, quote: string, overrides: Partial<ReadLine> = {}) =>
      read({ drug, quote, strength: null, form: null, doseAmount: null, doseUnit: null, frequency: null, durationDays: null, ...overrides }); // prettier-ignore
    const { kept } = backedLines({
      read: [
        keep('losartán', 'Continuar con losartán habitual.'),
        keep('pastillas anticonceptivas', 'Continuar con pastillas anticonceptivas de manera habitual.', { form: 'TABLET' }), // prettier-ignore
        // Positive control: a continuation that says how is a prescription.
        keep('Amoxicilina', 'Continuar amoxicilina 500 mg cada 8 horas por 3 días más.', { strength: '500 mg', frequency: 'EVERY_8_HOURS', durationDays: 3 }), // prettier-ignore
      ],
      cleared: plan[0]!.text,
      sections: plan,
      restore: sameText,
    });

    expect(kept.map((line) => line.drug)).toEqual(['Amoxicilina']);
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

describe('a combination’s strength as the cuadro writes it (AS-066)', () => {
  it('AS-066 «500/125 mg» is «500 mg + 125 mg»; a strength per volume is left alone', () => {
    expect(cuadroStrength('500/125 mg')).toBe('500 mg + 125 mg');
    expect(cuadroStrength('875/125 MG')).toBe('875 mg + 125 mg');
    expect(cuadroStrength('250 mg/5 mL')).toBe('250 mg/5 mL');
    expect(cuadroStrength('500 mg')).toBe('500 mg');
    const combination = { form: 'TABLET', concentration: '500 mg + 125 mg' };
    expect(presentationFor(combination, { form: null, strength: '500/125 mg' })?.concentration).toBe('500 mg + 125 mg'); // prettier-ignore
    // Control: another combination is still not this one.
    expect(presentationFor(combination, { form: null, strength: '875/125 mg' })).toBeNull(); // prettier-ignore
  });
});

describe('a dose by weight never escapes (AS-068, D-084 §5 — clinical review G1)', () => {
  it.each([
    '15 mg/kg/día',
    '15 mg/kilo cada 6 horas',
    '15 mg/kilo/dosis',
    '10 mg x kg',
    '15 mg/kgr',
    '0.1 mg/k cada 8 horas',
    '100 mg/m2sc',
    '1,5 mg/m² SC',
    '1,5 mg/m²',
    '20 mg por kilo de peso',
    'según superficie corporal',
    '2 gotas por kilo',
  ])('AS-068 «%s» is a dose by weight', (text) => {
    expect(writtenByWeight(text)).toBe(true);
  });

  it.each([
    'Amoxicilina 500 mg cada 8 horas',
    '250 mg/5 mL cada 8 horas',
    'Losartán 50 mg diario',
    'Peso 70 kg',
  ])(
    // prettier-ignore
    'AS-068 control: «%s» is not',
    (text) => {
      expect(writtenByWeight(text)).toBe(false);
    },
  );

  it('AS-068 a dose by weight written in ANOTHER sentence of the note empties a dose in mg, not one in tablets', () => {
    const note =
      'Paracetamol jarabe 160 mg/5 mL cada 6 horas por 3 días. Dosis 15 mg/kg.';
    const inMilligrams = backed({ strength: '160 mg/5 mL', doseAmount: 15, doseUnit: 'MILLIGRAM', quote: 'Paracetamol jarabe 160 mg/5 mL cada 6 horas por 3 días' }); // prettier-ignore
    expect(
      proposedFields(inMilligrams, null, note).fields.doseAmount,
    ).toBeNull();
    // Control: a tablet is counted, not weighed.
    expect(proposedFields(backed(), null, note).fields.doseAmount).toBe(1);
  });
});

describe('every field backed by its sentence (AS-063 — clinical review G2)', () => {
  const NOTE_TEXT =
    'Amoxicilina 500 mg cada 8 horas por 7 días. Ibuprofeno 400 mg cada 8 horas por 3 días.';
  const sentence = 'Amoxicilina 500 mg cada 8 horas por 7 días.';

  it('AS-063 a medicine the sentence does not name is no line', () => {
    expect(backedFields(read({ drug: 'ibuprofeno' }), sentence, NOTE_TEXT)).toBeNull(); // prettier-ignore
    expect(backedFields(read(), sentence, NOTE_TEXT)).not.toBeNull();
  });

  it('AS-063 each figure the sentence does not write is emptied; what it writes stays', () => {
    const line = backedFields(read({ doseAmount: 2, durationDays: 10, strength: '875 mg' }), sentence, NOTE_TEXT)!; // prettier-ignore
    expect([line.doseAmount, line.durationDays, line.strength]).toEqual([null, null, null]); // prettier-ignore
    const said = backedFields(read({ doseAmount: 1 }), 'Amoxicilina 500 mg, una tableta cada 8 horas por una semana.', NOTE_TEXT)!; // prettier-ignore
    expect([said.doseAmount, said.durationDays, said.strength]).toEqual([1, 7, '500 mg']); // prettier-ignore
  });

  it('AS-063 «una vez por semana» never backs a daily frequency (methotrexate)', () => {
    const weekly =
      'Metotrexato 2,5 mg, 3 tabletas una vez por semana por 4 semanas.';
    expect(backedFields(read({ drug: 'metotrexato', strength: '2,5 mg', doseAmount: 3, frequency: 'ONCE_DAILY', durationDays: 28 }), weekly, weekly)!.frequency).toBeNull(); // prettier-ignore
    expect(backedFields(read({ drug: 'metotrexato', strength: '2,5 mg', doseAmount: 3, frequency: 'ONCE_WEEKLY' }), weekly, weekly)!.frequency).toBe('ONCE_WEEKLY'); // prettier-ignore
    // Control: «cada 8 horas» is backed, «cada 12» is not.
    expect(backedFields(read(), sentence, NOTE_TEXT)!.frequency).toBe('EVERY_8_HOURS'); // prettier-ignore
    expect(backedFields(read({ frequency: 'EVERY_12_HOURS' }), sentence, NOTE_TEXT)!.frequency).toBeNull(); // prettier-ignore
  });

  it('AS-063 free text the note does not write is not carried to the receta', () => {
    const line = backedFields(read({ instructions: 'tomar 2 tabletas cada 4 horas', frequencyText: 'después de comer' }), sentence, NOTE_TEXT)!; // prettier-ignore
    expect([line.instructions, line.frequencyText]).toEqual([null, null]);
    const noted = backedFields(read({ instructions: 'por 7 días' }), sentence, NOTE_TEXT)!; // prettier-ignore
    expect(noted.instructions).toBe('por 7 días');
  });

  it('AS-063 what the note suspends, already gives or is allergic to is no line', () => {
    const note = [{ key: 'plan', text: 'Se suspende el ibuprofeno 400 mg cada 8 horas. Ya toma metformina 850 mg cada 12 horas. Alérgico a amoxicilina 500 mg.' }]; // prettier-ignore
    const { kept, dropped } = backedLines({
      read: [
        read({ drug: 'ibuprofeno', strength: '400 mg', quote: 'ibuprofeno 400 mg cada 8 horas' }), // prettier-ignore
        read({ drug: 'metformina', strength: '850 mg', quote: 'metformina 850 mg cada 12 horas' }), // prettier-ignore
        read({ drug: 'amoxicilina', quote: 'amoxicilina 500 mg' }),
      ],
      cleared: note[0]!.text,
      sections: note,
      restore: (text) => text,
    });
    expect([kept.length, dropped]).toEqual([0, 3]);
  });

  it('AS-063 a decimal written with a point does not cut the sentence', () => {
    const note = [{ key: 'plan', text: 'Warfarina 2.5 mg, una tableta diaria por 30 días.' }]; // prettier-ignore
    const { kept } = backedLines({
      read: [read({ drug: 'warfarina', strength: '2.5 mg', frequency: 'ONCE_DAILY', durationDays: 30, quote: 'Warfarina 2.5 mg, una tableta diaria por 30 días' })], // prettier-ignore
      cleared: note[0]!.text,
      sections: note,
      restore: (text) => text,
    });
    expect(kept[0]).toMatchObject({ strength: '2.5 mg', frequency: 'ONCE_DAILY', durationDays: 30 }); // prettier-ignore
  });
});

describe('the medicine chosen is the one written (AS-064 — clinical review m3)', () => {
  it('AS-064 a plain amoxicillin is not the combination; a salt in the name does not stop the right one', () => {
    expect(chosenIsWritten('Amoxicilina + ácido clavulánico', 'Amoxicilina 500 mg cada 8 horas')).toBe(false); // prettier-ignore
    expect(chosenIsWritten('Amoxicilina + ácido clavulánico', 'Amoxicilina con ácido clavulánico 500/125 mg')).toBe(true); // prettier-ignore
    expect(chosenIsWritten('Levotiroxina sódica', 'Levotiroxina 50 mcg en ayunas')).toBe(true); // prettier-ignore
  });
});

/** The CNMB's own presentations (cnmb-2026.xlsx), as the reader gives them. */
const AMOXICILLIN = [
  { form: 'TABLET', forms: ['TABLET', 'COATED_TABLET', 'CHEWABLE_TABLET', 'CAPSULE'], concentration: '500 mg', route: 'O - Oral' }, // prettier-ignore
  { form: 'POWDER_FOR_ORAL_SUSPENSION', forms: ['POWDER_FOR_ORAL_SUSPENSION'], concentration: '250 mg/5 mL', route: 'O - Oral' }, // prettier-ignore
  { form: 'POWDER_FOR_ORAL_SUSPENSION', forms: ['POWDER_FOR_ORAL_SUSPENSION'], concentration: '100 mg/mL', route: 'O - Oral' }, // prettier-ignore
];
const PARACETAMOL = [
  { form: 'SUPPOSITORY', forms: ['SUPPOSITORY'], concentration: '100 mg', route: 'R - Rectal' }, // prettier-ignore
  { form: 'ORAL_SUSPENSION', forms: ['ORAL_SUSPENSION', 'SYRUP'], concentration: '150 mg/5 mL', route: 'O - Oral' }, // prettier-ignore
  { form: 'INJECTABLE_SOLUTION', forms: ['INJECTABLE_SOLUTION'], concentration: '10 mg/mL', route: 'P - Parenteral' }, // prettier-ignore
  { form: 'TABLET', forms: ['TABLET', 'COATED_TABLET', 'CHEWABLE_TABLET', 'CAPSULE'], concentration: '500 mg', route: 'O - Oral' }, // prettier-ignore
  { form: 'SUPPOSITORY', forms: ['SUPPOSITORY'], concentration: '300 mg', route: 'R - Rectal' }, // prettier-ignore
  { form: 'ORAL_DROPS', forms: ['ORAL_DROPS'], concentration: '100 mg/mL', route: 'O - Oral' }, // prettier-ignore
];

describe('the strength as the cuadro writes it (AS-269)', () => {
  it('AS-269 «500 miligramos», «500mg» and «500 MG» are «500 mg»; grams and micrograms too', () => {
    expect(writtenStrength('500 miligramos')).toBe('500 mg');
    expect(writtenStrength('500mg')).toBe('500 mg');
    expect(writtenStrength('500 MG')).toBe('500 mg');
    expect(writtenStrength('1 gramo')).toBe('1 g');
    expect(writtenStrength('100 microgramos')).toBe('100 mcg');
    expect(writtenStrength('500/125 mg')).toBe('500 mg + 125 mg');
    expect(writtenStrength('250 mg/5 mL')).toBe('250 mg/5 mL');
    expect(writtenStrength('500')).toBe('500');
    expect(writtenStrength(null)).toBeNull();
  });

  it('AS-269 a bare figure right after the medicine («paracetamol de 500») is its strength; elsewhere it is not', () => {
    expect(strengthIn('siga con el paracetamol de 500 cada 8 horas', 'paracetamol')).toBe('500'); // prettier-ignore
    expect(strengthIn('Amoxicilina 500 miligramos cada 8 horas', 'Amoxicilina')).toBe('500 mg'); // prettier-ignore
    expect(strengthIn('paracetamol cada 8 horas', 'paracetamol')).toBeNull();
    expect(strengthIn('y siga con el paracetamol de quinientos cada ocho horas', 'paracetamol')).toBe('500'); // prettier-ignore
    expect(strengthIn('amoxicilina de quinientos miligramos, una cápsula', 'amoxicilina')).toBe('500 mg'); // prettier-ignore
  });
});

describe('the presentation when the model chose none (AS-269, AS-270, AS-272)', () => {
  it('AS-270 amoxicillin 500 mg capsule: the only solid of 500 mg, as a capsule, with the cuadro’s oral route', () => {
    const chosen = choosePresentation(AMOXICILLIN, undefined, { form: 'CAPSULE', strength: '500 mg' }); // prettier-ignore

    expect(chosen).toEqual({
      chosen: { form: 'CAPSULE', concentration: '500 mg', route: 'O - Oral' },
      strength: '500 mg',
      strengthDeduced: false,
      gap: null,
    });
  });

  it('AS-269 «paracetamol de 500»: the 500 mg tablet, the figure read as its strength and marked', () => {
    const chosen = choosePresentation(PARACETAMOL, undefined, { form: null, strength: '500' }); // prettier-ignore

    expect(chosen.chosen).toEqual({ form: 'TABLET', concentration: '500 mg', route: 'O - Oral' }); // prettier-ignore
    expect(chosen.strength).toBe('500 mg');
    expect(chosen.strengthDeduced).toBe(true);
  });

  it('AS-270 a choice of the model that contradicts what was written gives way to the only one that agrees', () => {
    const chosen = choosePresentation(AMOXICILLIN, AMOXICILLIN[1], { form: 'CAPSULE', strength: '500 miligramos' }); // prettier-ignore

    expect(chosen.chosen?.concentration).toBe('500 mg');
    expect(chosen.gap).toBeNull();
  });

  it('AS-270 with several that agree, or none, the presentation stays empty and says why', () => {
    expect(choosePresentation(PARACETAMOL, undefined, { form: null, strength: null })).toMatchObject({ chosen: null, gap: 'several' }); // prettier-ignore
    expect(choosePresentation(AMOXICILLIN, undefined, { form: 'CAPSULE', strength: '875 mg' })).toMatchObject({ chosen: null, gap: 'none' }); // prettier-ignore
    expect(choosePresentation(PARACETAMOL, undefined, { form: 'SUPPOSITORY', strength: null })).toMatchObject({ chosen: null, gap: 'several' }); // prettier-ignore
  });

  it('AS-270 the model’s own choice stands when it agrees with what was written', () => {
    const chosen = choosePresentation(AMOXICILLIN, AMOXICILLIN[0], { form: null, strength: '500 mg' }); // prettier-ignore

    expect(chosen).toMatchObject({ chosen: { form: 'TABLET', concentration: '500 mg' }, gap: null }); // prettier-ignore
  });
});

describe('the libreto’s receta, every field (AS-269 to AS-272)', () => {
  it('AS-272 «amoxicilina de 500 miligramos, una cápsula cada 8 horas por 7 días»: capsule said, oral and 21 deduced', () => {
    const line = backed({ strength: '500 mg', form: 'CAPSULE', doseAmount: 1, doseUnit: null, route: null }); // prettier-ignore
    const { fields, unsaid } = proposedFields(line, { form: 'CAPSULE', concentration: '500 mg', route: 'O - Oral' }); // prettier-ignore

    expect(fields).toMatchObject({
      form: 'CAPSULE',
      concentration: '500 mg',
      route: 'ORAL',
      doseAmount: 1,
      doseUnit: 'CAPSULE',
      frequency: 'EVERY_8_HOURS',
      durationDays: 7,
      quantity: 21,
    });
    expect(unsaid).toEqual(['route', 'quantity']);
  });

  it('AS-272 «paracetamol de 500 cada 8 horas si tiene fiebre»: the tablet, oral and one tablet, all marked; no quantity without a duration', () => {
    const line = backed({ drug: 'paracetamol', strength: '500 mg', form: null, doseAmount: null, doseUnit: null, durationDays: null }); // prettier-ignore
    const { fields, unsaid } = proposedFields(line, { form: 'TABLET', concentration: '500 mg', route: 'O - Oral' }, '', { strengthDeduced: true }); // prettier-ignore

    expect(fields).toMatchObject({
      form: 'TABLET',
      concentration: '500 mg',
      route: 'ORAL',
      doseAmount: 1,
      doseUnit: 'TABLET',
      quantity: null,
    });
    expect(unsaid).toEqual(['presentation', 'route', 'dose']);
  });

  it('AS-272 a dose said in units with no unit written takes the unit of the form, marked when the form was deduced', () => {
    const line = backed({ form: null, doseAmount: 2, doseUnit: null, strength: '500 mg', quote: 'Amoxicilina 500 mg, dos tabletas cada 8 horas por 7 días' }); // prettier-ignore
    const { fields, unsaid } = proposedFields(line, { form: 'TABLET', concentration: '500 mg', route: 'O - Oral' }); // prettier-ignore

    expect(fields).toMatchObject({ doseAmount: 2, doseUnit: 'TABLET' });
    expect(unsaid).toContain('dose');
  });
});

describe('a dose read in milligrams of a tablet of that strength (AS-272)', () => {
  it('AS-272 «500 miligramos cada 8 horas» of the 500 mg tablet is 1 tablet, marked; 250 mg of it is not guessed', () => {
    const chosen = { form: 'TABLET' as const, concentration: '500 mg', route: 'O - Oral' }; // prettier-ignore
    const read = (doseAmount: number) =>
      proposedFields(backed({ form: null, strength: '500 mg', doseAmount, doseUnit: 'MILLIGRAM' }), chosen); // prettier-ignore

    expect(read(500).fields).toMatchObject({ doseAmount: 1, doseUnit: 'TABLET', quantity: 21 }); // prettier-ignore
    expect(read(500).unsaid).toContain('dose');
    expect(read(250).fields).toMatchObject({ doseAmount: 250, doseUnit: 'MILLIGRAM' }); // prettier-ignore
  });
});

describe('a count is said with its unit (AS-272, code review)', () => {
  const tablet = { form: 'TABLET' as const, concentration: '500 mg', route: 'O - Oral' }; // prettier-ignore

  it('AS-272 «paracetamol de 500» read as a dose of 500 with no unit is no dose of 500 tablets: one tablet, deduced', () => {
    const line = backed({ drug: 'paracetamol', strength: '500 mg', form: null, doseAmount: 500, doseUnit: null, durationDays: 3, quote: 'paracetamol de 500 cada 8 horas por 3 días' }); // prettier-ignore

    const { fields, unsaid } = proposedFields(line, tablet);

    expect(fields).toMatchObject({ doseAmount: 1, doseUnit: 'TABLET', quantity: 9 }); // prettier-ignore
    expect(unsaid).toContain('dose');
  });

  it('AS-272 «dos tabletas» is a count; «1 tableta» after the medicine is no strength', () => {
    const line = backed({ form: 'TABLET', doseAmount: 2, doseUnit: null, quote: 'Amoxicilina 500 mg, dos tabletas cada 8 horas por 7 días' }); // prettier-ignore
    expect(proposedFields(line, tablet).fields).toMatchObject({ doseAmount: 2, doseUnit: 'TABLET' }); // prettier-ignore
    expect(strengthIn('Paracetamol 1 tableta cada 8 horas', 'paracetamol')).toBeNull(); // prettier-ignore
    expect(strengthIn('amoxicilina de doscientos cincuenta', 'amoxicilina')).toBeNull(); // prettier-ignore
  });

  it('AS-270 a bare figure no presentation has leaves the model’s choice standing', () => {
    expect(choosePresentation(PARACETAMOL, PARACETAMOL[3], { form: null, strength: '1' }).chosen).toMatchObject({ concentration: '500 mg' }); // prettier-ignore
  });
});
