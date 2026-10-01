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
