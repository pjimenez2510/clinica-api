import { describe, expect, it } from 'vitest';

import { warningsFor } from './role-risk';

/**
 * AU-034 — the requirement whose whole point is that it does NOT refuse.
 *
 * These assertions are about what comes BACK, not about what is blocked: the
 * function returns sentences, and the caller has already saved the change by
 * the time it shows them. A test that asserted a throw would be testing the
 * opposite requirement.
 */
describe('las advertencias al componer un rol', () => {
  it('AU-034 advierte cuando un rol administra usuarios y además lee la historia clínica', () => {
    const warnings = warningsFor(['user:manage', 'record:read']);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('SPDP');
    expect(warnings[0]).toContain('historia clínica');
  });

  it('AU-034 advierte también con los permisos clínicos que no empiezan por record:', () => {
    // `vitals:write` y `prescription:write` escriben en la historia de un
    // paciente y su código no lo dice. Casar sólo por el prefijo los dejaría
    // fuera, y ese hueco sólo aparece en una auditoría.
    expect(warningsFor(['user:manage', 'vitals:write'])).not.toEqual([]);
    expect(warningsFor(['user:manage', 'prescription:write'])).not.toEqual([]);
    expect(warningsFor(['user:manage', 'record:sign'])).not.toEqual([]);
  });

  it('AU-034 no advierte nada cuando el rol sólo administra usuarios', () => {
    // El rol ADMIN por defecto. Si esto advirtiera, la pantalla mostraría una
    // alarma en la instalación recién montada y nadie volvería a leerlas.
    expect(warningsFor(['user:manage', 'site:manage', 'catalog:read'])).toEqual(
      [],
    );
  });

  it('AU-034 no advierte nada cuando el rol sólo lee la historia clínica', () => {
    expect(warningsFor(['record:read', 'record:write', 'agenda:read'])).toEqual(
      [],
    );
  });

  it('AU-034 dice la combinación UNA vez, no dos veces con distintas palabras', () => {
    // `RISKY_COMBINATIONS` declara `user:manage` + `record:read` y AU-034 la
    // generaliza a toda la familia `record:*`. Si se emitieran las dos, la
    // pantalla mostraría dos avisos sobre lo mismo redactados distinto, que es
    // como se enseña a la gente a cerrarlos sin leer.
    const warnings = warningsFor(['user:manage', 'record:read']);

    expect(warnings).toHaveLength(1);
  });

  it('AU-034 conserva las otras combinaciones que ya estaban declaradas', () => {
    // Quien audita los accesos también podría modificar quién accede.
    const warnings = warningsFor(['audit:read', 'user:manage']);

    expect(warnings.some((w) => w.includes('audita'))).toBe(true);
  });

  it('AU-034 acumula las advertencias cuando concurren varias', () => {
    const warnings = warningsFor([
      'user:manage',
      'record:sign',
      'audit:read',
      'billing:write',
    ]);

    // Historia + administración, auditoría + administración, y firmar +
    // facturar. Tres preocupaciones distintas, tres frases.
    expect(warnings).toHaveLength(3);
  });

  it('AU-034 no advierte nada sobre un rol vacío', () => {
    expect(warningsFor([])).toEqual([]);
  });
});
