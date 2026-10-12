import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AiExchangeRecord,
  AiRunRecord,
  AiRunStore,
} from '../src/modules/assistant/application/ai-run.store.ts';

/** Where the ledger lives unless a run says otherwise; ignored by git. */
export const DEFAULT_LEDGER_DIR = join(process.cwd(), 'eval', '.gasto');

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

  constructor(dir: string = DEFAULT_LEDGER_DIR) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'intentos.jsonl');
  }

  /**
   * Every line carries its own id: `feat/ia-d1-cie10` makes `record` answer
   * the id of the row (`Promise<string>`), and then this returns `id`.
   */
  record(run: AiRunRecord, exchange: AiExchangeRecord | null): Promise<void> {
    if (exchange !== null) {
      throw new Error(
        'El arnés no guarda texto: corra con el registro de intercambios apagado',
      );
    }
    const id = randomUUID();
    appendFileSync(this.file, `${JSON.stringify({ id, ...run })}\n`);
    this.recorded.push(run);
    return Promise.resolve();
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
