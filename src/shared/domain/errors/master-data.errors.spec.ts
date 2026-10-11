import { describe, expect, it } from 'vitest';

import { NotFoundError } from './domain-error';
import { DOMAIN_ERROR_CODES } from './error-catalogue';
import { ConsultationNotFoundError } from './master-data.errors';

/**
 * The contract of «that consultation does not exist», answered by `agenda`
 * (SP-028, AG-112) and `staff` (ST-009) alike — which is why it lives here.
 * NotFoundError is what `problem-details.filter.ts` turns into a 404.
 */
describe('ConsultationNotFoundError', () => {
  const error = new ConsultationNotFoundError();

  it('SP-028 answers CONSULTATION_NOT_FOUND as a 404 registered in the catalogue', () => {
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe('CONSULTATION_NOT_FOUND');
    expect(DOMAIN_ERROR_CODES).toContain('CONSULTATION_NOT_FOUND');
  });

  it('SP-028 says in Spanish that the consultation is not offered, pointing at serviceId', () => {
    expect(error.userTitle).toBe(
      'La consulta elegida no existe o ya no se ofrece. Actualice la lista e intente de nuevo',
    );
    expect(error.fieldErrors).toEqual([
      {
        field: 'serviceId',
        code: 'CONSULTATION_NOT_FOUND',
        message: 'Elija una consulta activa de la especialidad',
      },
    ]);
    // Never whether it once existed: an inactive one and a ghost read alike.
    expect(error.message).not.toMatch(/existed|deleted|inactive/i);
  });
});
