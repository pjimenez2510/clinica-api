import { beforeEach, describe, expect, it } from 'vitest';

import { RevocationReason } from '../../../shared/request/client-context';
import { CannotResetOwnMfaError, UserNotFoundError } from '../domain/auth.errors'; // prettier-ignore

import type {
  AccountAdminRepositoryPort,
  AccountListItem,
  AccountView,
  GrantView,
  MfaResetAuthor,
} from './admin-ports';
import { MfaResetService } from './mfa-reset.service';

/**
 * AU-035 and AU-036 as the SERVICE's rules, against a double of its port.
 *
 * WHAT IS DELIBERATELY NOT HERE. That the secret, the backup codes and the
 * sessions actually disappear — and disappear TOGETHER — is a property of one
 * PostgreSQL transaction, and a double answering «yes I did it» would prove
 * only that the double answers. That half is
 * `test/integration/auth-admin-http.spec.ts`.
 *
 * What IS here is everything the service owns and the database cannot know:
 * who may ask, what happens to an id that does not exist, whether an account
 * with no second factor is a refusal, and that the author of the act reaches
 * the trail — which since the adversarial review of 13-08-2026 travels INTO
 * the port instead of being recorded afterwards, because a reset nobody can be
 * held to must not happen. That the two really share a transaction is again
 * `test/integration/auth-admin-http.spec.ts`.
 */

const OPERATOR_ID = 'user-soporte';
const TARGET_ID = 'user-medico';
const REQUESTER = { userId: OPERATOR_ID, ip: '10.0.0.7', userAgent: 'Firefox' };

const RESET_ACCOUNT: AccountView = {
  id: TARGET_ID,
  email: 'medico@clinica.ec',
  firstName: 'Ana',
  lastName: 'Villacís',
  cedula: null,
  active: true,
  // What the account looks like AFTER the reset: the factor is gone.
  mfaEnabled: false,
  credentialPending: false,
};

interface Call {
  method: string;
  args: unknown[];
}

class AccountsDouble implements AccountAdminRepositoryPort {
  readonly calls: Call[] = [];
  resetAnswer: AccountView | null = RESET_ACCOUNT;

  resetMfa(
    userId: string,
    revocationReason: string,
    author: MfaResetAuthor,
  ): Promise<AccountView | null> {
    this.calls.push({
      method: 'resetMfa',
      args: [userId, revocationReason, author],
    });
    return Promise.resolve(this.resetAnswer);
  }

  // The rest of the port is not this service's business. They THROW rather
  // than return a plausible value: a silent stub would let a future version of
  // the service read the account first, or deactivate it, and nobody would
  // notice.
  list(): Promise<readonly AccountListItem[]> {
    throw new Error('not used');
  }
  findById(): Promise<AccountView | null> {
    throw new Error('not used');
  }
  create(): Promise<AccountView> {
    throw new Error('not used');
  }
  update(): Promise<AccountView | null> {
    throw new Error('not used');
  }
  setActive(): Promise<AccountView | null> {
    throw new Error('not used');
  }
  listGrants(): Promise<readonly GrantView[]> {
    throw new Error('not used');
  }
  replaceGrants(): Promise<readonly GrantView[]> {
    throw new Error('not used');
  }
}

describe('el reinicio del segundo factor de otra cuenta', () => {
  let accounts: AccountsDouble;
  let service: MfaResetService;

  /** Lo que el servicio le pidió a la base que registrase, si es que se lo pidió. */
  const authorOf = (call?: Call): MfaResetAuthor | undefined =>
    call?.args[2] as MfaResetAuthor | undefined;

  beforeEach(() => {
    accounts = new AccountsDouble();
    service = new MfaResetService(accounts);
  });

  it('AU-035 retira el segundo factor de la cuenta indicada y la devuelve sin él', async () => {
    const account = await service.reset(TARGET_ID, REQUESTER);

    expect(accounts.calls[0]?.method).toBe('resetMfa');
    expect(accounts.calls[0]?.args[0]).toBe(TARGET_ID);
    // La pantalla necesita ver el cambio: la fila deja de decir «con segundo
    // factor» en la misma respuesta, sin recargar la lista.
    expect(account.mfaEnabled).toBe(false);
  });

  it('AU-036 pide el cierre de sesiones con un motivo propio, no con el de una desactivación', async () => {
    // El motivo viaja a `refresh_token.revocation_reason` y es lo que una
    // auditoría lee. «ACCOUNT_DEACTIVATED» diría que a esta persona se le
    // retiró el acceso, y no es lo que pasó: se le retiró el segundo factor.
    await service.reset(TARGET_ID, REQUESTER);

    expect(accounts.calls[0]?.args[1]).toBe(RevocationReason.MFA_RESET);
  });

  it('AU-035 deja en la bitácora el autor, el sujeto y de dónde se pidió', async () => {
    await service.reset(TARGET_ID, REQUESTER);

    // El sujeto es el argumento de la propia operación: no hay forma de pedir
    // el reinicio de una cuenta y registrar otra.
    expect(accounts.calls[0]?.args[0]).toBe(TARGET_ID);
    expect(authorOf(accounts.calls[0])).toEqual({
      userId: OPERATOR_ID,
      ip: '10.0.0.7',
      userAgent: 'Firefox',
    });
  });

  it('AU-035 pide el registro EN la misma operación, no después de ella', async () => {
    // Lo que esto afirma es una AUSENCIA: el servicio no tiene ningún camino
    // para registrar por su cuenta una vez la base ha confirmado. Si lo
    // tuviera, un `INSERT` fallido dejaría al médico sin segundo factor, sin
    // sesiones y sin nadie a quien atribuirlo, con un 200 en pantalla.
    await service.reset(TARGET_ID, REQUESTER);

    expect(accounts.calls).toHaveLength(1);
    expect(authorOf(accounts.calls[0])).toBeDefined();
  });

  it('AU-035 no registra jamás una credencial en la bitácora', async () => {
    // AU-025 lo dice y la forma de `MfaResetAuthor` es lo que lo hace cierto:
    // no hay dónde poner un secreto. Esto lo afirma sobre el reinicio, que es
    // justo la operación que manipula uno.
    await service.reset(TARGET_ID, REQUESTER);

    const author = JSON.stringify(authorOf(accounts.calls[0]));
    expect(author).not.toMatch(/secret|password|hash|backup/i);
  });

  it('AU-035 responde «la cuenta no existe» cuando el identificador no es de nadie', async () => {
    accounts.resetAnswer = null;

    await expect(service.reset('user-fantasma', REQUESTER)).rejects.toThrow(
      UserNotFoundError,
    );
  });

  it('AU-035 no deja rastro de un reinicio que no ocurrió', async () => {
    // Una entrada de bitácora sobre una cuenta inexistente es ruido que una
    // auditoría tendría que descartar a mano, y peor: sugiere que alguien
    // reinició algo. Con la entrada dentro de la transacción lo garantiza el
    // ROLLBACK, y lo que aquí se afirma es que el servicio no añade una
    // segunda escritura por su cuenta detrás del rechazo.
    accounts.resetAnswer = null;

    await expect(service.reset('user-fantasma', REQUESTER)).rejects.toThrow(
      UserNotFoundError,
    );
    expect(accounts.calls).toHaveLength(1);
  });

  it('AU-035 acepta sin quejarse una cuenta que no tenía segundo factor', async () => {
    // NO ES UN ERROR: lo que se pide es un estado —«esta cuenta no tiene
    // segundo factor»— y ya se cumple. Ver el porqué en el servicio.
    accounts.resetAnswer = RESET_ACCOUNT;

    const account = await service.reset(TARGET_ID, REQUESTER);

    expect(account.mfaEnabled).toBe(false);
    // Y se registra igual: que el estado ya se cumpliera no quita que alguien
    // haya ejercido el permiso sobre una cuenta ajena.
    expect(authorOf(accounts.calls[0])?.userId).toBe(OPERATOR_ID);
  });

  it('AU-035 impide reiniciarse el segundo factor a uno mismo', async () => {
    await expect(service.reset(OPERATOR_ID, REQUESTER)).rejects.toThrow(
      CannotResetOwnMfaError,
    );
  });

  it('AU-035 comprueba que no es uno mismo ANTES de tocar nada', async () => {
    // Si la comprobación fuese después de la escritura, la negativa llegaría
    // con el factor ya retirado: una negativa que no niega nada.
    await expect(service.reset(OPERATOR_ID, REQUESTER)).rejects.toThrow(
      CannotResetOwnMfaError,
    );

    expect(accounts.calls).toEqual([]);
  });
});
