import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLES } from './default-roles';

const permissionsOf = (code: string): readonly string[] => {
  const role = DEFAULT_ROLES.find((candidate) => candidate.code === code);
  if (role === undefined) throw new Error(`No default role ${code}`);
  return role.permissions;
};

/**
 * D-101, corregida por el autor: LOS ROLES LOS ARMA CADA CLÍNICA. `patient:write`
 * no es sólo corregir la ficha: registra pacientes, el consentimiento LOPDP y
 * la orientación sexual. El médico de fábrica no lo lleva; la clínica se lo da
 * si quiere, y el certificado de reposo se emite igual, con su aviso (CER-038).
 */
describe('CER-038 D-101 quién corrige en la ficha los datos que pide el reposo', () => {
  it('CER-038 el médico de fábrica no recibe patient:write: lo decide la clínica', () => {
    expect(permissionsOf('MEDICO')).not.toContain('patient:write');
  });

  it('CER-038 control: recepción sí lo trae, y caja no', () => {
    expect(permissionsOf('RECEPCION')).toContain('patient:write');
    expect(permissionsOf('CAJA')).not.toContain('patient:write');
  });
});

/**
 * D-199.1. Las dos llaves de la dirección médica —qué prestaciones exigen el
 * 024 y anular certificados ajenos— vienen en un rol propio de fábrica, que
 * nace sin usuarios: la clínica sólo lo asigna a quien dirige.
 */
describe('AU-059 el rol de fábrica «Dirección médica»', () => {
  it('AU-059 lleva record:consent-rule, certificate:revoke-any y billing:read, y nada más', () => {
    const role = DEFAULT_ROLES.find((each) => each.code === 'DIRECCION_MEDICA');
    expect(role?.name).toBe('Dirección médica');
    expect([...(role?.permissions ?? [])].sort()).toEqual([
      'billing:read',
      'certificate:revoke-any',
      'record:consent-rule',
    ]);
  });

  it('AU-059 control: ningún otro rol de fábrica lleva sus dos llaves', () => {
    const others = DEFAULT_ROLES.filter(
      (each) => each.code !== 'DIRECCION_MEDICA',
    );
    for (const role of others) {
      expect(role.permissions).not.toContain('record:consent-rule');
      expect(role.permissions).not.toContain('certificate:revoke-any');
    }
    expect(others.length).toBeGreaterThan(0);
  });
});

/**
 * AS-026, D-244 §3. Until the per-site switch of A3, the assistant answers to
 * the installation's `ASSISTANT_ENABLED` and to this permission. Who attends
 * carries it from the factory; nobody who does not diagnose does.
 */
describe('AS-026 quién trae el asistente de fábrica', () => {
  it('AS-026 el médico trae assistant:use', () => {
    expect(permissionsOf('MEDICO')).toContain('assistant:use');
  });

  it('AS-026 control: enfermería, recepción y caja no lo traen', () => {
    for (const code of ['ENFERMERIA', 'RECEPCION', 'CAJA']) {
      expect(permissionsOf(code)).not.toContain('assistant:use');
    }
  });
});

/**
 * AS-187, D-255 §1. Dictating the vital signs is the taking's, not the
 * consultation's: nursing and medicine carry it, and nursing does NOT get
 * `assistant:use` with it (the listening, the drafts, the proposals).
 */
describe('AS-187 quién dicta los signos de fábrica', () => {
  it('AS-187 enfermería y el médico traen assistant:dictate-vitals', () => {
    expect(permissionsOf('ENFERMERIA')).toContain('assistant:dictate-vitals');
    expect(permissionsOf('MEDICO')).toContain('assistant:dictate-vitals');
  });

  it('AS-187 control: recepción y caja no lo traen, y enfermería sigue sin assistant:use', () => {
    for (const code of ['RECEPCION', 'CAJA']) {
      expect(permissionsOf(code)).not.toContain('assistant:dictate-vitals');
    }
    expect(permissionsOf('ENFERMERIA')).not.toContain('assistant:use');
  });
});

describe('AS-310 quién registra su voz de fábrica', () => {
  it('AS-310 el médico y enfermería traen assistant:voiceprint', () => {
    expect(permissionsOf('MEDICO')).toContain('assistant:voiceprint');
    expect(permissionsOf('ENFERMERIA')).toContain('assistant:voiceprint');
  });

  it('AS-310 control: recepción y caja no lo traen', () => {
    for (const code of ['RECEPCION', 'CAJA']) {
      expect(permissionsOf(code)).not.toContain('assistant:voiceprint');
    }
  });
});
