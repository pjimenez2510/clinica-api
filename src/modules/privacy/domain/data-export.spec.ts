import { describe, expect, it } from 'vitest';

import { answerProposal, EXPORT_OMISSIONS } from './data-export';

const DECISION_REFERENCE = /\((?:[A-Z]{1,3}-\d{2,3}[^)]*)\)/;

describe('lo que el archivo no lleva, dicho al titular', () => {
  it('PD-049 la propuesta dice que no es todo y una línea por sección, en el orden de omitted, sin referencias a decisiones', () => {
    const lines = answerProposal(EXPORT_OMISSIONS).split('\n');

    expect(lines[0]).toBe('El archivo con sus datos no lo incluye todo:');
    expect(lines.slice(1)).toHaveLength(EXPORT_OMISSIONS.length);
    lines.slice(1).forEach((line) => {
      expect(line.startsWith('- ')).toBe(true);
      expect(line).not.toMatch(DECISION_REFERENCE);
      expect(line).not.toContain('`');
      expect(line).not.toMatch(/\s[.;,]/);
    });
    expect(lines[1]).toContain('La historia clínica');
    expect(lines[1]).toContain('se entrega por otra vía');
  });

  it('PD-049 cada motivo sale con sus palabras: lo que el archivo dice, menos la referencia', () => {
    const proposal = answerProposal([
      { section: 'access_log', reason: 'No va todavía (D-098 §7).' },
      { section: 'contacts', reason: 'Van en `versions` (D-131.1, PA-042).' },
    ]);

    expect(proposal).toBe(
      [
        'El archivo con sus datos no lo incluye todo:',
        '- No va todavía.',
        '- Van en «versions».',
      ].join('\n'),
    );
  });

  it('PD-049 cabe en el texto de una respuesta (PD-033, 4 000 caracteres)', () => {
    expect(answerProposal(EXPORT_OMISSIONS).length).toBeLessThanOrEqual(4_000);
  });

  it('PD-050 citas y facturación: las vigentes no van todavía, sus versiones anteriores sí', () => {
    const reasonOf = (section: string) =>
      EXPORT_OMISSIONS.find((one) => one.section === section)?.reason;

    for (const section of ['appointments', 'billing']) {
      expect(reasonOf(section)).toContain(
        'las vigentes no se incluyen todavía; sus versiones anteriores sí',
      );
    }
  });
});
