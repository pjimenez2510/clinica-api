import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLES } from './default-roles';

const permissionsOf = (code: string): readonly string[] => {
  const role = DEFAULT_ROLES.find((candidate) => candidate.code === code);
  if (role === undefined) throw new Error(`No default role ${code}`);
  return role.permissions;
};

describe('CER-038 D-101 quién corrige en la ficha los datos que pide el reposo', () => {
  it('CER-038 el médico recibe patient:write de fábrica', () => {
    expect(permissionsOf('MEDICO')).toContain('patient:write');
  });

  it('CER-038 control: caja no lo recibe, y recepción lo sigue teniendo', () => {
    expect(permissionsOf('CAJA')).not.toContain('patient:write');
    expect(permissionsOf('RECEPCION')).toContain('patient:write');
  });
});
