import { describe, expect, it } from 'vitest';

import {
  isSerialisationFailure,
  withSerialisationRetry,
} from './serialisation-retry';

/**
 * The retry around a transaction PostgreSQL aborted for serialisation.
 *
 * Its reason for existing is AG-026: without it, the loser of a race for the
 * same slot is sometimes told `CONCURRENT_UPDATE` ("try again") for a slot
 * that is genuinely taken, and sometimes `PRACTITIONER_SLOT_TAKEN` ("pick
 * another time") — depending on how PostgreSQL happened to resolve the race
 * that millisecond. Retrying turns the first case into the second.
 */

/** A Prisma error as the pg driver adapter delivers it. */
function serialisationFailure(sqlState = '40001'): Error {
  return Object.assign(new Error('could not serialize access'), {
    code: 'P2010',
    clientVersion: '7.9.1',
    meta: {
      driverAdapterError: {
        cause: {
          code: sqlState,
          originalMessage:
            'could not serialize access due to concurrent update',
        },
      },
    },
  });
}

/**
 * The other shape, and it is not hypothetical: a failure inside
 * `$transaction` arrives as a bare `DriverAdapterError` with no `P####` code
 * and the SQLSTATE in `cause.originalCode`. Captured from PostgreSQL 18
 * through this driver in `agenda-daily.spec.ts`.
 */
function transactionWriteConflict(sqlState = '40001'): Error {
  return Object.assign(new Error('TransactionWriteConflict'), {
    name: 'DriverAdapterError',
    cause: {
      originalCode: sqlState,
      originalMessage:
        'could not serialize access due to read/write dependencies among transactions',
      kind: 'TransactionWriteConflict',
    },
  });
}

const neverSleep = (): Promise<void> => Promise.resolve();

describe('recognising a serialisation failure', () => {
  it('recognises the two SQLSTATEs PostgreSQL uses for a transient abort', () => {
    // 40001 serialization_failure and 40P01 deadlock_detected. Both mean the
    // same thing to the caller: nothing is wrong with the data, try again.
    expect(isSerialisationFailure(serialisationFailure('40001'))).toBe(true);
    expect(isSerialisationFailure(serialisationFailure('40P01'))).toBe(true);
  });

  it('recognises the abort of an interactive transaction, which arrives bare', () => {
    // Reading only Prisma's wrapped shape is how the retry stops retrying
    // without anybody noticing: the error simply stops matching.
    expect(isSerialisationFailure(transactionWriteConflict('40001'))).toBe(
      true,
    );
    expect(isSerialisationFailure(transactionWriteConflict('40P01'))).toBe(
      true,
    );
    expect(isSerialisationFailure(transactionWriteConflict('23P01'))).toBe(
      false,
    );
  });

  it('does not mistake a constraint rejection for a transient one', () => {
    // 23P01 is the exclusion constraint: the slot IS taken, and retrying would
    // fail forever while the receptionist waits.
    expect(isSerialisationFailure(serialisationFailure('23P01'))).toBe(false);
    expect(isSerialisationFailure(new Error('boom'))).toBe(false);
    expect(isSerialisationFailure(undefined)).toBe(false);
  });
});

describe('AG-026 retrying a serialisation failure', () => {
  it('AG-026 retries the operation and returns the result of a later attempt', async () => {
    let attempts = 0;
    const slept: number[] = [];

    const result = await withSerialisationRetry(
      () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(serialisationFailure());
        return Promise.resolve('booked');
      },
      {
        attempts: 3,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    );

    expect(result).toBe('booked');
    expect(attempts).toBe(3);
    // It waits between attempts: hammering the same row immediately makes the
    // contention it is retrying worse.
    expect(slept).toHaveLength(2);
    expect(slept.every((ms) => ms > 0)).toBe(true);
  });

  it('AG-026 gives up after the last attempt and rethrows the failure', async () => {
    let attempts = 0;

    await expect(
      withSerialisationRetry(
        () => {
          attempts += 1;
          return Promise.reject(serialisationFailure());
        },
        { attempts: 3, sleep: neverSleep },
      ),
    ).rejects.toMatchObject({ code: 'P2010' });

    // Exactly the budget, not one more: each retry holds a connection.
    expect(attempts).toBe(3);
  });

  it('AG-026 does not retry a rejection that is not a serialisation failure', async () => {
    let attempts = 0;

    await expect(
      withSerialisationRetry(
        () => {
          attempts += 1;
          return Promise.reject(serialisationFailure('23P01'));
        },
        { attempts: 3, sleep: neverSleep },
      ),
    ).rejects.toBeInstanceOf(Error);

    // A taken slot stays taken. Retrying it would delay the honest answer.
    expect(attempts).toBe(1);
  });

  it('AG-026 reports each retry so the caller can log it', async () => {
    const retries: number[] = [];
    let attempts = 0;

    await withSerialisationRetry(
      () => {
        attempts += 1;
        return attempts < 2
          ? Promise.reject(serialisationFailure())
          : Promise.resolve('ok');
      },
      { attempts: 2, sleep: neverSleep, onRetry: (n) => retries.push(n) },
    );

    expect(retries).toEqual([1]);
  });
});
