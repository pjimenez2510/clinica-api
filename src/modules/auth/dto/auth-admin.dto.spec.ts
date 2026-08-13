import { describe, expect, it } from 'vitest';

import { PERMISSION_CATALOGUE } from '../../../shared/authorisation/permission.catalogue';

import {
  accountSchema,
  createAccountSchema,
  updateAccountSchema,
} from './auth-admin.dto';

/**
 * The administration contract at its boundary.
 *
 * These are here rather than only in `test/integration/auth-admin-http.spec.ts`
 * because what they pin is the SHAPE OF THE CONTRACT, not a database
 * guarantee: which values the door lets through, and whether the sentence a
 * clinic reads before granting a permission describes what the permission
 * actually hands over.
 */
describe('el contrato de administración de cuentas', () => {
  const account = {
    email: 'ana.villacis@clinica.ec',
    firstName: 'Ana',
    lastName: 'Villacís',
  };

  /** Synthetic cedula with a COMPUTED check digit; never a real person's. */
  const VALID_CEDULA = '1710034065';

  describe('AU-020 · la cédula del personal', () => {
    it('AU-020 rechaza una cédula que no son diez dígitos', () => {
      expect(
        createAccountSchema.safeParse({ ...account, cedula: 'abc' }).success,
      ).toBe(false);
      expect(updateAccountSchema.safeParse({ cedula: 'abc' }).success).toBe(
        false,
      );
    });

    it('AU-020 rechaza una cédula con el dígito verificador equivocado', () => {
      // The same number with the check digit altered by one. Length and shape
      // are right, so only the algorithm can tell them apart — which is the
      // whole point: `max(10)` accepted this.
      const wrong = `${VALID_CEDULA.slice(0, 9)}6`;

      expect(
        createAccountSchema.safeParse({ ...account, cedula: wrong }).success,
      ).toBe(false);
      expect(updateAccountSchema.safeParse({ cedula: wrong }).success).toBe(
        false,
      );
    });

    it('AU-020 rechaza una provincia que no existe y un tercer dígito de empresa', () => {
      for (const impossible of ['9999999999', '1790001563']) {
        expect(
          updateAccountSchema.safeParse({ cedula: impossible }).success,
        ).toBe(false);
      }
    });

    it('AU-020 admite una cédula válida y señala el campo cuando no lo es', () => {
      expect(
        createAccountSchema.safeParse({ ...account, cedula: VALID_CEDULA })
          .success,
      ).toBe(true);

      const rejected = updateAccountSchema.safeParse({ cedula: 'abc' });
      expect(rejected.success).toBe(false);
      expect(rejected.error?.issues[0]?.path).toEqual(['cedula']);
    });

    it('AU-020 la cadena vacía es «sin cédula» y se guarda como NULL', () => {
      // How a browser form sends a cleared field. Refusing it would make it
      // impossible to remove a cedula somebody typed by mistake.
      const parsed = updateAccountSchema.parse({ cedula: '' });
      expect(parsed.cedula).toBeNull();
    });

    it('AU-020 una cuenta sin cédula sigue siendo legítima: recepción no firma', () => {
      expect(createAccountSchema.safeParse(account).success).toBe(true);
      expect(
        createAccountSchema.safeParse({ ...account, cedula: null }).success,
      ).toBe(true);
    });
  });

  describe('AU-033 · lo que la descripción de un permiso promete', () => {
    it('AU-033 user:read declara la cédula porque el listado la lleva', () => {
      /**
       * ROLES ARE DATA (AU-030): a clinic invents «TALENTO HUMANO», ticks the
       * boxes it recognises, and lives with the result. The description is the
       * only thing it reads before ticking, so a description that omits the
       * national ID of every employee is not a wording problem — it is an
       * uninformed grant.
       *
       * The two halves are asserted TOGETHER on purpose: whoever drops
       * `cedula` from the listing may then soften the sentence, and whoever
       * softens the sentence must first drop the field.
       */
      const carriesCedula = 'cedula' in accountSchema.shape;
      const description = PERMISSION_CATALOGUE.find(
        (permission) => permission.code === 'user:read',
      )?.description;

      expect(carriesCedula).toBe(true);
      expect(description).toMatch(/cédula/i);
    });
  });
});
