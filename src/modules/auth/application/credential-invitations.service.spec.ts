import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessAuditEntry } from '../../../shared/audit/access-audit.port';
import {
  MailDeliveryFailedError,
  MailNotConfiguredError,
} from '../../../shared/mail/mail.errors';
import type { Mailer, MailMessage } from '../../../shared/mail/mail.port';
import { InvalidCredentialTokenError, UserNotFoundError } from '../domain/auth.errors'; // prettier-ignore
import { WeakPasswordError } from '../domain/password-policy';

import { AuthAdminAuditTrail } from './auth-admin-audit.trail';
import { CredentialInvitationsService } from './credential-invitations.service';
import type {
  CredentialInvitationRepositoryPort,
  CredentialRecipient,
  CredentialTokenPort,
  IssueCredentialInvitationInput,
  StoredCredentialInvitation,
} from './credential-ports';
import type { PasswordHasherPort } from './ports';

/**
 * What the SERVICE is responsible for, against doubles of its ports.
 *
 * Two of these are the reason this delivery exists at all and neither can be
 * demonstrated end to end without either a real SMTP server or a real outage:
 *
 *   - AU-029: the account SURVIVES a mail failure, and the caller is told. The
 *     mail port throws on purpose — the opposite policy to the audit port —
 *     and this is the only place that catches it. A double that never fails
 *     would leave the whole branch unexercised.
 *   - AU-028: an unknown, a spent and an expired link produce the SAME
 *     refusal. Assertable here as three calls whose thrown values are equal.
 */

const USER_ID = '00000000-0000-0000-0000-0000000000a1';
const ADMIN_ID = '00000000-0000-0000-0000-0000000000b2';
const REQUESTER = { userId: ADMIN_ID, ip: '10.0.0.1' };

const RECIPIENT: CredentialRecipient = {
  userId: USER_ID,
  email: 'nueva@clinica.ec',
  firstName: 'Ana',
  lastName: 'Villacís',
  cedula: null,
  inviterName: 'Gabriela Mera',
  clinicName: 'Centro Médico Santa Ana',
};

class InvitationsRepositoryDouble implements CredentialInvitationRepositoryPort {
  issued: IssueCredentialInvitationInput[] = [];
  stored: StoredCredentialInvitation | null = null;
  recipientAnswer: CredentialRecipient | null = RECIPIENT;
  redeemAnswer = true;
  redeemedWith: { invitationId: string; passwordHash: string } | null = null;

  supersedeAndIssue(input: IssueCredentialInvitationInput): Promise<void> {
    this.issued.push(input);
    return Promise.resolve();
  }

  findByTokenHash(): Promise<StoredCredentialInvitation | null> {
    return Promise.resolve(this.stored);
  }

  redeem(input: {
    invitationId: string;
    userId: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    this.redeemedWith = {
      invitationId: input.invitationId,
      passwordHash: input.passwordHash,
    };
    return Promise.resolve(this.redeemAnswer);
  }

  recipient(): Promise<CredentialRecipient | null> {
    return Promise.resolve(this.recipientAnswer);
  }
}

const PLAIN_TOKEN = 'plain-token';

/**
 * Deterministic on purpose: a failing test has to be reproducible.
 *
 * The fake hash does NOT contain the token as a substring — reversing it is
 * enough — because one of the assertions below is that the plain token never
 * reaches persistence, and a fake like `hash-of-${token}` would make that
 * assertion fail for a reason that has nothing to do with the code.
 */
class TokensDouble implements CredentialTokenPort {
  generate(): { token: string; hash: string } {
    return { token: PLAIN_TOKEN, hash: this.hash(PLAIN_TOKEN) };
  }
  hash(token: string): string {
    return `sha:${[...token].reverse().join('')}`;
  }
}

class MailerDouble implements Mailer {
  readonly sent: MailMessage[] = [];
  failWith: Error | null = null;

  send(message: MailMessage): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve();
  }
}

const HASHER: PasswordHasherPort = {
  hash: (plain) => Promise.resolve(`argon2-of-${plain}`),
  verify: () => Promise.resolve(false),
  needsRehash: () => false,
  burnTime: () => Promise.resolve(),
};

const STRONG_PASSWORD = 'el caballo come alfalfa';

describe('la primera credencial de una cuenta', () => {
  let repository: InvitationsRepositoryDouble;
  let mailer: MailerDouble;
  let recorded: AccessAuditEntry[];
  let service: CredentialInvitationsService;

  beforeEach(() => {
    repository = new InvitationsRepositoryDouble();
    mailer = new MailerDouble();
    recorded = [];

    service = new CredentialInvitationsService(
      repository,
      new TokensDouble(),
      HASHER,
      mailer,
      'http://localhost:3001',
      new AuthAdminAuditTrail({
        record: (entry) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      }),
      {
        setContext: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      } as unknown as PinoLogger,
    );
  });

  describe('emisión y envío', () => {
    it('AU-021 guarda sólo el hash del token, nunca el token', async () => {
      await service.issue(USER_ID, REQUESTER);

      const [issued] = repository.issued;
      expect(issued?.tokenHash).toBe('sha:nekot-nialp');
      // Lo que se guarda no permite reconstruir el enlace: una copia robada de
      // la base no contiene ninguna credencial utilizable.
      expect(JSON.stringify(repository.issued)).not.toContain('plain-token');
    });

    it('AU-021 manda el enlace con el token en claro al correo de la persona', async () => {
      await service.issue(USER_ID, REQUESTER);

      const [message] = mailer.sent;
      expect(message?.to).toBe('nueva@clinica.ec');
      expect(message?.text).toContain(
        'http://localhost:3001/acceso/credencial?token=plain-token',
      );
    });

    it('AU-026 fija la caducidad 72 horas después de emitir', async () => {
      await service.issue(USER_ID, REQUESTER);

      const [issued] = repository.issued;
      const hours =
        ((issued?.expiresAt.getTime() ?? 0) - (issued?.now.getTime() ?? 0)) /
        3_600_000;
      expect(hours).toBe(72);
    });

    it('AU-021 deja en la bitácora que se invitó, y nunca el token', async () => {
      await service.issue(USER_ID, REQUESTER);

      expect(recorded).toEqual([
        {
          userId: ADMIN_ID,
          resourceType: 'auth',
          resourceId: USER_ID,
          action: 'UPDATE',
          ip: '10.0.0.1',
          userAgent: undefined,
        },
      ]);
      expect(JSON.stringify(recorded)).not.toContain('plain-token');
    });

    it('AU-029 informa de que el envío falló en lugar de tragárselo', async () => {
      // El puerto de correo LANZA a propósito —política contraria a la del
      // puerto de bitácora— y éste es el único sitio que lo captura. Sin esta
      // rama, un servidor de correo caído produciría una pantalla verde sobre
      // una persona que nunca va a recibir nada.
      mailer.failWith = new MailDeliveryFailedError();

      const result = await service.issue(USER_ID, REQUESTER);

      expect(result.sent).toBe(false);
      // Y la invitación SÍ se escribió: es lo que permite reenviarla.
      expect(repository.issued).toHaveLength(1);
    });

    it('AU-029 responde igual cuando la instalación no tiene servidor de correo', async () => {
      // `SMTP_HOST` es opcional a propósito: una instalación que no da de alta
      // a nadie tiene que poder arrancar. El rechazo llega aquí, al usarlo.
      mailer.failWith = new MailNotConfiguredError();

      const result = await service.issue(USER_ID, REQUESTER);

      expect(result.sent).toBe(false);
      expect(repository.issued).toHaveLength(1);
    });

    it('AU-027 emite anulando lo anterior en una sola operación', async () => {
      // El reenvío es «anula la viva y emite otra». Expresarlo como una sola
      // llamada es lo que impide que un fallo entre las dos deje a la persona
      // sin ninguna forma de entrar, o dos enlaces vivos a la vez.
      await service.issue(USER_ID, REQUESTER);
      await service.issue(USER_ID, REQUESTER);

      expect(repository.issued).toHaveLength(2);
      expect(mailer.sent).toHaveLength(2);
    });

    it('AU-021 rechaza invitar a una cuenta que no existe', async () => {
      repository.recipientAnswer = null;

      await expect(service.issue(USER_ID, REQUESTER)).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });
  });

  describe('comprobación del enlace', () => {
    it('AU-028 dice que un enlace vivo sirve, y hasta cuándo', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      repository.stored = { id: 'inv-1', userId: USER_ID, expiresAt, usedAt: null }; // prettier-ignore

      await expect(service.check('plain-token')).resolves.toEqual({
        valid: true,
        expiresAt,
      });
    });

    it('AU-028 responde exactamente lo mismo para un enlace desconocido, uno usado y uno caducado', async () => {
      // Distinguirlos es un oráculo: «ya se usó» confirma que el token existía
      // y «caducó» confirma que a alguien se le invitó, en un endpoint que es
      // público por necesidad.
      const answers = [];

      repository.stored = null;
      answers.push(await service.check('desconocido'));

      repository.stored = {
        id: 'inv-1',
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 3_600_000),
        usedAt: new Date(),
      };
      answers.push(await service.check('usado'));

      repository.stored = {
        id: 'inv-2',
        userId: USER_ID,
        expiresAt: new Date(Date.now() - 1_000),
        usedAt: null,
      };
      answers.push(await service.check('caducado'));

      expect(answers).toEqual([
        { valid: false, expiresAt: null },
        { valid: false, expiresAt: null },
        { valid: false, expiresAt: null },
      ]);
    });
  });

  describe('canje del enlace', () => {
    beforeEach(() => {
      repository.stored = {
        id: 'inv-1',
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 3_600_000),
        usedAt: null,
      };
    });

    it('AU-021 fija la contraseña que eligió la persona y gasta la invitación', async () => {
      await service.redeem('plain-token', STRONG_PASSWORD);

      expect(repository.redeemedWith).toEqual({
        invitationId: 'inv-1',
        passwordHash: `argon2-of-${STRONG_PASSWORD}`,
      });
    });

    it('AU-021 aplica la MISMA política de contraseñas del cambio de contraseña', async () => {
      // Importada, no reescrita: éste es el camino alcanzable SIN estar
      // autenticado, que es donde una segunda copia más laxa importaría más.
      await expect(
        service.redeem('plain-token', 'corta'),
      ).rejects.toBeInstanceOf(WeakPasswordError);

      // Y no se gastó la invitación: la persona vuelve a intentarlo con el
      // mismo enlace, que es lo único que tiene.
      expect(repository.redeemedWith).toBeNull();
    });

    it('AU-021 rechaza una contraseña que contiene el nombre de la propia persona', async () => {
      await expect(
        service.redeem('plain-token', 'villacis villacis'),
      ).rejects.toBeInstanceOf(WeakPasswordError);
    });

    it('AU-021 deja en la bitácora que la credencial la fijó la propia cuenta', async () => {
      // El autor es la persona, no el administrador: nadie más pudo hacerlo,
      // porque nadie más conoció nunca la contraseña. Es la mitad de D-013 que
      // hace posible el no repudio.
      await service.redeem('plain-token', STRONG_PASSWORD, { ip: '190.0.0.9' });

      expect(recorded).toEqual([
        {
          userId: USER_ID,
          resourceType: 'auth',
          resourceId: USER_ID,
          action: 'UPDATE',
          ip: '190.0.0.9',
          userAgent: undefined,
        },
      ]);
      expect(JSON.stringify(recorded)).not.toContain(STRONG_PASSWORD);
    });

    it('AU-028 responde INVALID_CREDENTIAL_TOKEN igual para desconocido, usado y caducado', async () => {
      const codes: string[] = [];
      const titles: (string | undefined)[] = [];

      const attempt = async (): Promise<void> => {
        try {
          await service.redeem('cualquiera', STRONG_PASSWORD);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidCredentialTokenError);
          const problem = error as InvalidCredentialTokenError;
          codes.push(problem.code);
          titles.push(problem.userTitle);
        }
      };

      repository.stored = null;
      await attempt();

      repository.stored = {
        id: 'inv-1',
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 3_600_000),
        usedAt: new Date(),
      };
      await attempt();

      repository.stored = {
        id: 'inv-2',
        userId: USER_ID,
        expiresAt: new Date(Date.now() - 1_000),
        usedAt: null,
      };
      await attempt();

      expect(codes).toEqual([
        'INVALID_CREDENTIAL_TOKEN',
        'INVALID_CREDENTIAL_TOKEN',
        'INVALID_CREDENTIAL_TOKEN',
      ]);
      // Ni siquiera la frase cambia: leerla no dice cuál de los tres fue.
      expect(new Set(titles).size).toBe(1);
    });

    it('AU-028 responde lo mismo cuando pierde la carrera contra otro envío del mismo enlace', async () => {
      // Dos envíos del mismo formulario. Sólo uno puede ganar la actualización
      // condicional; el otro recibe la misma respuesta que un enlace gastado,
      // porque eso es exactamente lo que acaba de ser.
      repository.redeemAnswer = false;

      await expect(
        service.redeem('plain-token', STRONG_PASSWORD),
      ).rejects.toBeInstanceOf(InvalidCredentialTokenError);
    });

    it('AU-028 no confirma que la cuenta existía cuando desaparece a mitad', async () => {
      repository.recipientAnswer = null;

      await expect(
        service.redeem('plain-token', STRONG_PASSWORD),
      ).rejects.toBeInstanceOf(InvalidCredentialTokenError);
    });
  });
});
