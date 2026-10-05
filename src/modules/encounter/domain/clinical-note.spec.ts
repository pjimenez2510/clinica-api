import { describe, expect, it } from 'vitest';

import {
  AmendmentReasonRequiredError,
  NoteAlreadySignedError,
  NoteContentIncompleteError,
  NoteNotAmendableError,
  UnknownClinicalFormError,
} from './encounter.errors';
import {
  CLINICAL_FORMS,
  assertAmendable,
  assertEditable,
  canonicalise,
  contentHashOf,
  planAmendment,
  requireAmendmentReason,
  requireForm,
} from './clinical-note';
import { assertNoteComplete, builtInTemplate } from './note-template';
import type { NoteStatus } from './encounter';

/**
 * The clinical note's rules, as far as pure code goes.
 *
 * ⚠️ THE GUARANTEE THIS MODULE EXISTS FOR IS NOT HERE AND CANNOT BE: that a
 * signed note cannot be edited is `trg_clinical_note_immutable`, and a double
 * proves nothing about it. It is exercised in
 * `test/integration/encounter-notes.spec.ts`, attacking the table directly.
 * What lives here is which correction is ADMISSIBLE and what the refusal says.
 */

const SIGNER = 'practitioner-1';
const SIGNED_AT = new Date('2026-09-14T15:00:00Z');

/** A complete form 002, as art. 6 of the A.M. 00115-2021 enumerates it. */
const COMPLETE_002 = {
  motivoConsulta: 'Dolor abdominal de dos días',
  antecedentes: 'Sin antecedentes patológicos de importancia',
  enfermedadActual: 'Dolor en epigastrio, sin irradiación',
  revisionOrganosSistemas: 'Resto de sistemas sin particularidades',
  examenFisico: 'Abdomen blando, depresible, doloroso a la palpación',
  planTratamiento: 'Dieta blanda y control en 72 horas',
};

/**
 * The same form MINUS one section, without a destructuring the linter reads as
 * a dead variable. Built by omission rather than by listing the survivors so
 * adding a mandatory section to the 002 does not silently make this a
 * different test.
 */
function without(section: keyof typeof COMPLETE_002) {
  return Object.fromEntries(
    Object.entries(COMPLETE_002).filter(([name]) => name !== section),
  );
}

describe('el formulario de la nota clínica', () => {
  it('EN-021 identifica la nota por el código de formulario del MSP guardado como dato', () => {
    const form = requireForm('002', '1');

    expect(form.code).toBe('002');
    expect(form.name).toBe('Consulta externa');
  });

  it('EN-021 rechaza un formulario que esta instalación no sabe validar, nombrando los que sí', () => {
    /**
     * The CODE is data — a `VarChar(8)`, so a renumbering by the ministry
     * costs an UPDATE and not a migration — and WHICH shapes can be validated
     * is not: a note stored under a code nobody declared is a note nothing can
     * check, print or amend, discovered years later by whoever has to produce
     * it.
     */
    try {
      requireForm('033', '1');
      expect.unreachable('un formulario no configurado debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownClinicalFormError);
      const refusal = error as UnknownClinicalFormError;
      expect(refusal.code).toBe('UNKNOWN_CLINICAL_FORM');
      expect(refusal.params.admitted).toContain('002@1');
    }
  });

  it('EN-021 distingue la VERSIÓN del formulario, no solo su número', () => {
    expect(() => requireForm('002', '2')).toThrow(UnknownClinicalFormError);
  });

  it('EN-021 no declara el 004, que no existe en el A.M. 00115-2021', () => {
    /**
     * ⚠️ EL 004 NO EXISTE: el Anexo 1 salta del 003 al 005, y el número que
     * este documento arrastraba era de la numeración DEROGADA de 2008. Como
     * `form_code` se graba en cada fila, la equivocación habría quedado en los
     * datos.
     */
    expect(CLINICAL_FORMS.map((form) => form.code)).not.toContain('004');
  });

  it('EN-130 solo da el alta clínica al firmar la nota de consulta externa', () => {
    // Signing the vital-signs form means nursing finished the preparation;
    // treating the two the same would discharge the patient the moment their
    // weight was recorded — before anybody had seen them.
    expect(requireForm('002', '1').dischargesTheEncounter).toBe(true);
    expect(requireForm('005', '1').dischargesTheEncounter).toBe(false);
  });
});

describe('el contenido mínimo del artículo 6', () => {
  it('EN-020 acepta un formulario 002 con las seis secciones narrativas', () => {
    expect(() =>
      assertNoteComplete(builtInTemplate('002'), COMPLETE_002),
    ).not.toThrow();
  });

  it('EN-020 rechaza una nota sin motivo de consulta', () => {
    try {
      assertNoteComplete(builtInTemplate('002'), without('motivoConsulta'));
      expect.unreachable('la nota incompleta debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(NoteContentIncompleteError);
      const refusal = error as NoteContentIncompleteError;
      expect(refusal.code).toBe('NOTE_CONTENT_INCOMPLETE');
      expect(refusal.fieldErrors?.[0]?.field).toBe('content.motivoConsulta');
    }
  });

  it('EN-020 no acepta una sección en blanco como sección llena', () => {
    // Three spaces satisfy «the key exists» and satisfy nothing a reader —
    // or a court — needs.
    expect(() =>
      assertNoteComplete(builtInTemplate('002'), {
        ...COMPLETE_002,
        planTratamiento: '   ',
      }),
    ).toThrow(NoteContentIncompleteError);
  });

  it('EN-020 nombra TODAS las secciones que faltan, no la primera', () => {
    const refusal = (() => {
      try {
        assertNoteComplete(builtInTemplate('002'), {
          motivoConsulta: 'Control',
        });
        return undefined;
      } catch (error) {
        return error as NoteContentIncompleteError;
      }
    })();

    expect(refusal?.fieldErrors?.map((field) => field.field)).toEqual([
      'content.antecedentes',
      'content.enfermedadActual',
      'content.revisionOrganosSistemas',
      'content.examenFisico',
      'content.planTratamiento',
    ]);
  });
});

describe('el resumen criptográfico de la firma', () => {
  it('EN-027 calcula el mismo resumen para el mismo contenido, firmante e instante', () => {
    expect(
      contentHashOf({
        content: COMPLETE_002,
        signedById: SIGNER,
        signedAt: SIGNED_AT,
      }),
    ).toBe(
      contentHashOf({
        content: COMPLETE_002,
        signedById: SIGNER,
        signedAt: SIGNED_AT,
      }),
    );
  });

  it('EN-027 no depende del orden en que se escribieron las secciones', () => {
    /**
     * `JSON.stringify` of an object depends on insertion order, so the SAME
     * note read back through a different code path would serialise
     * differently — and SC-012, which recomputes the digest of every signed
     * note of the last year, would report a forgery that never happened.
     */
    const reordered = {
      planTratamiento: COMPLETE_002.planTratamiento,
      motivoConsulta: COMPLETE_002.motivoConsulta,
      examenFisico: COMPLETE_002.examenFisico,
      antecedentes: COMPLETE_002.antecedentes,
      revisionOrganosSistemas: COMPLETE_002.revisionOrganosSistemas,
      enfermedadActual: COMPLETE_002.enfermedadActual,
    };

    expect(
      contentHashOf({ content: reordered, signedById: SIGNER, signedAt: SIGNED_AT }), // prettier-ignore
    ).toBe(
      contentHashOf({ content: COMPLETE_002, signedById: SIGNER, signedAt: SIGNED_AT }), // prettier-ignore
    );
  });

  it('EN-027 cambia el resumen si cambia una sola letra del contenido', () => {
    expect(
      contentHashOf({
        content: { ...COMPLETE_002, planTratamiento: 'Dieta blanda' },
        signedById: SIGNER,
        signedAt: SIGNED_AT,
      }),
    ).not.toBe(
      contentHashOf({ content: COMPLETE_002, signedById: SIGNER, signedAt: SIGNED_AT }), // prettier-ignore
    );
  });

  it('EN-027 cambia el resumen si el mismo contenido lo firma otra persona', () => {
    /**
     * The signer and the instant are INSIDE the digest, not beside it: hashing
     * the content alone would let a note be re-attributed to another doctor
     * with the hash still checking out — and «quién firmó» is half of what
     * art. 4 demands be made to appear.
     */
    expect(
      contentHashOf({
        content: COMPLETE_002,
        signedById: 'practitioner-2',
        signedAt: SIGNED_AT,
      }),
    ).not.toBe(
      contentHashOf({ content: COMPLETE_002, signedById: SIGNER, signedAt: SIGNED_AT }), // prettier-ignore
    );
  });

  it('EN-027 escribe el resumen en hexadecimal de 64 caracteres, que es lo que la columna admite', () => {
    // `content_hash` is `Char(64)`: a longer digest would be refused by the
    // column with a `VALUE_TOO_LONG` nobody could act on.
    expect(
      contentHashOf({ content: COMPLETE_002, signedById: SIGNER, signedAt: SIGNED_AT }), // prettier-ignore
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('EN-027 canonicaliza conservando el orden de los arreglos, donde el orden es significado', () => {
    expect(canonicalise({ b: 1, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"b":1}');
    expect(canonicalise(null)).toBe('null');
    expect(canonicalise('texto')).toBe('"texto"');
    // `undefined` members drop exactly as `JSON.stringify` drops them, so a
    // value that round-trips through PostgreSQL hashes the same either way.
    expect(canonicalise({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(canonicalise(undefined)).toBe('null');
  });
});

describe('la enmienda y la retractación', () => {
  const previous = {
    id: 'note-1',
    chainId: 'chain-1',
    version: 1,
    status: 'SIGNED' as NoteStatus,
  };

  it('EN-023 solo deja editar un borrador', () => {
    expect(() => assertEditable('DRAFT')).not.toThrow();

    for (const status of [
      'SIGNED',
      'SUPERSEDED',
      'ENTERED_IN_ERROR',
    ] as const) {
      expect(() => assertEditable(status)).toThrow(NoteAlreadySignedError);
    }
  });

  it('EN-023 dice que la nota está firmada, no que falten permisos', () => {
    /**
     * `trg_clinical_note_immutable` raises `insufficient_privilege`, which on
     * its own comes out as a 403 telling the doctor they lack permissions when
     * what happened is that the note is signed. This is the sentence EN-023
     * asks for instead.
     */
    try {
      assertEditable('SIGNED');
      expect.unreachable('editar una nota firmada debía rechazarse');
    } catch (error) {
      const refusal = error as NoteAlreadySignedError;
      expect(refusal.code).toBe('NOTE_ALREADY_SIGNED');
      expect(refusal.userTitle).toContain('enmiéndela indicando el motivo');
    }
  });

  it('EN-025 solo deja enmendar o retractar una versión FIRMADA', () => {
    expect(() => assertAmendable('SIGNED')).not.toThrow();

    for (const status of ['DRAFT', 'SUPERSEDED', 'ENTERED_IN_ERROR'] as const) {
      expect(() => assertAmendable(status)).toThrow(NoteNotAmendableError);
    }
  });

  it('EN-025 le dice a quien enmienda un borrador que lo edite y lo firme', () => {
    // The three refusals share a code and not a sentence: what to do about a
    // draft is different from what to do about a version somebody superseded.
    try {
      assertAmendable('DRAFT');
      expect.unreachable('enmendar un borrador debía rechazarse');
    } catch (error) {
      const refusal = error as NoteNotAmendableError;
      expect(refusal.code).toBe('NOTE_NOT_AMENDABLE');
      expect(refusal.userTitle).toContain('borrador');
    }
  });

  it('EN-025 crea una versión NUEVA que apunta a la anterior, en la misma cadena', () => {
    const plan = planAmendment({
      previous,
      reason: 'Se anotó el peso de la paciente anterior',
    });

    expect(plan).toEqual({
      chainId: 'chain-1',
      version: 2,
      supersedesId: 'note-1',
      reason: 'Se anotó el peso de la paciente anterior',
    });
  });

  it('EN-025 exige el motivo escrito, y lo exige en el DOMINIO y no solo en el DTO', () => {
    /**
     * A `DEBERÁ` the transport alone enforces stops being true the first time
     * an internal caller amends one — the lesson
     * `CANCELLATION_REASON_REQUIRED` left in the agenda.
     */
    expect(() => planAmendment({ previous, reason: undefined })).toThrow(
      AmendmentReasonRequiredError,
    );
    expect(() => planAmendment({ previous, reason: '  ' })).toThrow(
      AmendmentReasonRequiredError,
    );
    expect(requireAmendmentReason('  se corrigió la dosis  ')).toBe(
      'se corrigió la dosis',
    );
  });
});
