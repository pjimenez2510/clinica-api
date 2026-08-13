import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_INVITATION_TTL_HOURS,
  credentialInvitationExpiry,
  isCredentialInvitationUsable,
} from './credential-invitation';

/**
 * The deadline and the three ways of not working.
 *
 * The time is passed in, never read, which is what makes «caduca a las 72
 * horas» assertable at all rather than a comment nobody can check.
 */
const ISSUED_AT = new Date('2026-08-14T16:00:00.000Z');

describe('la invitación de primera credencial', () => {
  it('AU-026 caduca exactamente 72 horas después de emitirse', () => {
    // Un viernes por la tarde. El plazo tiene que llegar al lunes por la
    // mañana: con 24 horas, todo el que entra un viernes recibe un enlace
    // muerto y el administrador acaba reenviando para media plantilla, que es
    // como una caducidad deja de significar nada.
    const expiry = credentialInvitationExpiry(ISSUED_AT);

    expect(expiry.toISOString()).toBe('2026-08-17T16:00:00.000Z');
    expect(CREDENTIAL_INVITATION_TTL_HOURS).toBe(72);
  });

  it('AU-026 sigue sirviendo un segundo antes de caducar', () => {
    const expiresAt = credentialInvitationExpiry(ISSUED_AT);
    const justBefore = new Date(expiresAt.getTime() - 1_000);

    expect(isCredentialInvitationUsable({ expiresAt, usedAt: null }, justBefore)).toBe(true); // prettier-ignore
  });

  it('AU-026 deja de servir en el instante exacto de la caducidad', () => {
    // El borde, y no «un minuto después»: es donde vive el error de signo.
    const expiresAt = credentialInvitationExpiry(ISSUED_AT);

    expect(isCredentialInvitationUsable({ expiresAt, usedAt: null }, expiresAt)).toBe(false); // prettier-ignore
  });

  it('AU-028 deja de servir en cuanto se usa, aunque no haya caducado', () => {
    // Un solo uso: el enlace reenviado desde un correo antiguo no vale nada.
    const expiresAt = credentialInvitationExpiry(ISSUED_AT);

    expect(
      isCredentialInvitationUsable(
        { expiresAt, usedAt: new Date('2026-08-14T16:05:00.000Z') },
        new Date('2026-08-14T16:06:00.000Z'),
      ),
    ).toBe(false);
  });

  it('AU-028 responde lo mismo para una invitación usada que para una caducada', () => {
    // El mismo `false`, sin nada que las distinga. Distinguirlas convertiría
    // un endpoint público en un oráculo: «ya se usó» confirma que el token
    // existió, y «caducó» confirma que a alguien se le invitó.
    const expiresAt = credentialInvitationExpiry(ISSUED_AT);
    const later = new Date('2026-08-20T00:00:00.000Z');

    const used = isCredentialInvitationUsable(
      { expiresAt, usedAt: new Date('2026-08-14T17:00:00.000Z') },
      new Date('2026-08-14T18:00:00.000Z'),
    );
    const expired = isCredentialInvitationUsable({ expiresAt, usedAt: null }, later); // prettier-ignore

    expect(used).toBe(expired);
    expect(used).toBe(false);
  });
});
