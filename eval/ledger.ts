import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AiExchangeRecord,
  AiRunRecord,
  AiRunStore,
} from '../src/modules/assistant/application/ai-run.store.ts';

/**
 * EV-4. Where the ledger lives: ONE per machine, outside every repository, so
 * the ceiling spans every run of the month from any worktree (this branch,
 * D1's, main) and survives `git worktree remove`. `EVAL_LEDGER_DIR` moves it.
 */
export function ledgerDirFrom(env: Record<string, string | undefined>): string {
  return env.EVAL_LEDGER_DIR || join(homedir(), '.clinica-eval', 'gasto');
}

/**
 * EV-4. The `ai_run` of the harness: one JSON line per attempt in a file
 * shared by every run on this machine, so the ceiling spans all of them
 * (SigmAI `spending-ceiling.ts`, `FileLedger`). It implements A4's
 * `AiRunStore`, so the SAME routing checks the ceiling before each attempt
 * and counts each one as the application does — refused attempts at 0 and
 * attempts without figures at their worst case (AS-017, D-241 §9).
 *
 * It keeps what `ai_run` keeps and nothing else: the exchange is never
 * written (the harness runs with the exchange log off).
 */
export class FileAiRunStore implements AiRunStore {
  /** The attempts of this run, for its report. */
  readonly recorded: AiRunRecord[] = [];
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'intentos.jsonl');
  }

  /** Every line carries its own id, which `record` answers (AS-036). */
  record(run: AiRunRecord, exchange: AiExchangeRecord | null): Promise<string> {
    if (exchange !== null) {
      throw new Error(
        'El arnés no guarda texto: corra con el registro de intercambios apagado',
      );
    }
    const id = randomUUID();
    appendFileSync(this.file, `${JSON.stringify({ id, ...run })}\n`);
    this.recorded.push(run);
    return Promise.resolve(id);
  }

  /** Every attempt the ledger holds, from every run. */
  read(): AiRunRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const row = JSON.parse(line) as AiRunRecord & { startedAt: string };
        return { ...row, startedAt: new Date(row.startedAt) };
      });
  }

  spentSince(from: Date): Promise<number> {
    const spent = this.read()
      .filter((row) => row.startedAt.getTime() >= from.getTime())
      .reduce((total, row) => total + (row.costUsd ?? row.worstCaseUsd), 0);
    return Promise.resolve(spent);
  }

  /** Nothing to purge: no text is ever written. */
  purgeExchanges(): Promise<number> {
    return Promise.resolve(0);
  }
}

/**
 * AS-098, D-241. A provider's own cap on top of the month's ceiling: as much
 * as the provider may have spent IN TOTAL in the shared ledger, counting the
 * attempt about to be made (the author: 2 USD per provider across every
 * delivery, 12-10-2026).
 *
 * The routing admits an attempt when `spentSince + worstCase ≤ ceiling`
 * (AS-017). Answering the larger of the month's spending and this provider's
 * total moved up by `ceiling − cap` makes it admit one only when BOTH fit:
 * the month under its ceiling, and the provider under its cap. Nothing else
 * of the routing changes.
 */
export class ProviderCapStore implements AiRunStore {
  constructor(
    private readonly inner: AiRunStore,
    private readonly ledger: FileAiRunStore,
    private readonly provider: string,
    private readonly capUsd: number,
    private readonly ceilingUsd: number,
  ) {}

  record(run: AiRunRecord, exchange: AiExchangeRecord | null): Promise<string> {
    return this.inner.record(run, exchange);
  }

  /** What this provider has spent in the ledger, every run of every branch. */
  spentByProvider(): number {
    return this.ledger
      .read()
      .filter((row) => row.provider === this.provider)
      .reduce((total, row) => total + (row.costUsd ?? row.worstCaseUsd), 0);
  }

  async spentSince(from: Date): Promise<number> {
    const month = await this.inner.spentSince(from);
    return Math.max(month, this.spentByProvider() + this.ceilingUsd - this.capUsd); // prettier-ignore
  }

  purgeExchanges(now: Date): Promise<number> {
    return this.inner.purgeExchanges(now);
  }
}
