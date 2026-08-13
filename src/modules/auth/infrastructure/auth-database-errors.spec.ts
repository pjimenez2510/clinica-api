import { describe, expect, it } from 'vitest';

import {
  EmailAlreadyRegisteredError,
  RoleCodeDuplicateError,
} from '../domain/auth.errors';

import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isLastAdministratorProtection,
  isRecordNotFound,
  isSystemRoleProtection,
} from './auth-database-errors';

/**
 * The translation table, against the error shapes the PostgreSQL 18 driver
 * adapter actually produces. What the real constraints REFUSE is proven in
 * `test/integration/auth-admin-http.spec.ts`; this proves each refusal is
 * recognised for what it IS, and — more importantly — that the four are not
 * confused with one another.
 *
 * WHY THAT MATTERS HERE MORE THAN ANYWHERE ELSE: three of these four refusals
 * offer the administrator a DIFFERENT way out. `ROLE_IN_USE` says «desactívelo»,
 * `SYSTEM_ROLE_PROTECTED` says «no es suyo, edítelo», and
 * `CANNOT_DEMOTE_SELF` says «concédalo antes a otro». Reading one as another
 * sends somebody down a path that cannot work, and the last of the three is
 * AU-024 — the requirement whose failure locks everybody out permanently.
 */

function prismaError(cause: Record<string, unknown>) {
  return {
    code: 'P2010',
    clientVersion: '7.9.1',
    meta: { driverAdapterError: { cause } },
  };
}

describe('la traducción de errores de la base en auth', () => {
  it('AU-020 reconoce el correo repetido y responde EMAIL_ALREADY_REGISTERED', () => {
    const duplicate = prismaError({
      code: '23505',
      constraint: { index: 'app_user_email_key' },
    });

    const error = duplicateErrorFrom(duplicate);
    expect(error).toBeInstanceOf(EmailAlreadyRegisteredError);
    expect(error?.fieldErrors?.[0]?.field).toBe('email');
  });

  it('AU-030 reconoce el código de rol repetido y responde ROLE_CODE_DUPLICATE', () => {
    const duplicate = prismaError({
      code: '23505',
      originalMessage:
        'duplicate key value violates unique constraint "role_code_key"',
    });

    expect(duplicateErrorFrom(duplicate)).toBeInstanceOf(
      RoleCodeDuplicateError,
    );
  });

  it('AU-020 deja pasar el duplicado de OTRO módulo sin tocarlo', () => {
    const foreign = prismaError({
      code: '23505',
      constraint: { index: 'site_msp_unicode_key' },
    });

    expect(duplicateErrorFrom(foreign)).toBeUndefined();
  });

  it('AU-031 reconoce el rechazo RESTRICT tal como llega de Prisma 7 sobre el adaptador', () => {
    // La forma REAL, capturada contra PostgreSQL 18 a través del adaptador:
    // `P2039`, `meta` vacío y el SQLSTATE sólo en el texto.
    const restricted = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {},
      message:
        'Database error. Code: `23001`. Message: `update or delete on table "role" violates RESTRICT setting of foreign key constraint "user_role_grant_role_id_fkey" on table "user_role_grant"`',
    };

    expect(isForeignKeyRestriction(restricted)).toBe(true);
  });

  it('AU-031 reconoce también el 23503 clásico por si el adaptador vuelve a informarlo', () => {
    const classic = prismaError({
      code: '23503',
      originalMessage:
        'update or delete on table "role" violates foreign key constraint "user_role_grant_role_id_fkey" on table "user_role_grant"',
    });

    expect(isForeignKeyRestriction(classic)).toBe(true);
  });

  it('AU-031 no confunde un único violado con «en uso»: son salidas distintas', () => {
    const duplicate = prismaError({
      code: '23505',
      constraint: { index: 'role_code_key' },
    });

    expect(isForeignKeyRestriction(duplicate)).toBe(false);
  });

  it('AU-031 reconoce el disparador que protege los roles del sistema', () => {
    // `trg_role_protect_system` levanta `insufficient_privilege` (42501).
    const trigger = prismaError({
      code: '42501',
      originalMessage: 'system role ADMIN cannot be deleted',
    });

    expect(isSystemRoleProtection(trigger)).toBe(true);
  });

  it('AU-031 lo reconoce también por el texto cuando el SQLSTATE no viaja', () => {
    const byText = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {},
      message:
        'Database error. Message: `system role MEDICO cannot be deleted`',
    };

    expect(isSystemRoleProtection(byText)).toBe(true);
  });

  it('AU-024 reconoce el disparador que mantiene vivo a un administrador', () => {
    // `trg_role_permission_keep_an_administrator`, diferido al COMMIT: la
    // última línea, y la única que aguanta un `DELETE FROM role_permission`
    // tecleado en `psql`.
    const trigger = prismaError({
      code: '23000',
      originalMessage: 'at least one active role must keep user:manage',
    });

    expect(isLastAdministratorProtection(trigger)).toBe(true);
  });

  it('AU-024 no confunde ese disparador con el de los roles del sistema', () => {
    // Uno dice «concédaselo antes a otro rol» y el otro «ese rol no es suyo».
    // Cambiarlos manda al administrador por un camino que no lleva a ningún
    // sitio.
    const systemRole = prismaError({
      code: '42501',
      originalMessage: 'system role ADMIN cannot be deleted',
    });

    expect(isLastAdministratorProtection(systemRole)).toBe(false);
    expect(isSystemRoleProtection(systemRole)).toBe(true);
  });

  it('ignora lo que no es un error de Prisma: un Error corriente sigue su camino', () => {
    for (const candidate of [
      new Error('boom'),
      undefined,
      null,
      { code: 'nope' },
    ]) {
      // prettier-ignore
      expect(duplicateErrorFrom(candidate)).toBeUndefined();
      expect(isForeignKeyRestriction(candidate)).toBe(false);
      expect(isSystemRoleProtection(candidate)).toBe(false);
      expect(isLastAdministratorProtection(candidate)).toBe(false);
    }
  });

  it('no inventa un duplicado cuando no hay nombre de constraint que leer', () => {
    expect(duplicateErrorFrom(prismaError({ code: '23505' }))).toBeUndefined();
    expect(
      duplicateErrorFrom({
        code: 'P2010',
        clientVersion: '7.9.1',
        meta: {},
      }),
    ).toBeUndefined();
  });

  it('reconoce P2025 como fila ausente, que es un 404 y no un conflicto', () => {
    expect(isRecordNotFound({ code: 'P2025' })).toBe(true);
    expect(isRecordNotFound({ code: 'P2002' })).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
  });
});
