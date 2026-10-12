import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeLlmProvider } from '../src/modules/assistant/infrastructure/fake-llm.provider.ts';

import { loadInventedCases } from './cases.ts';
import { loadCatalogues } from './catalogue.ts';
import { FileAiRunStore } from './ledger.ts';
import { runFromArgs } from './main.ts';
import { clientFor } from './providers.ts';
import { runEvaluation, TaggingStore } from './runner.ts';
import { cie10Task } from './tasks/cie10.ts';

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `eval-${name}-`));

afterEach(() => vi.restoreAllMocks());

describe('a run of the harness', () => {
  it('EV-8 runs the three tasks with the fake, without the network, and EV-7 versions what it measured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = scratch('out');
    const now = new Date();
    const lines: string[] = [];

    const folder = await runFromArgs(['--', '--falso', '--salida', out], {
      env: {},
      now: () => now,
      log: (line) => lines.push(line),
      ledgerDir: scratch('ledger'),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(folder).not.toBeNull();
    expect(readdirSync(folder!).sort()).toEqual([
      'informe.md',
      'resultado.json',
    ]);
    const result = JSON.parse(
      readFileSync(join(folder!, 'resultado.json'), 'utf8'),
    );
    expect(result).toMatchObject({
      label: 'falso',
      fake: true,
      seed: 42,
      ceilingUsd: 100,
      stopped: null,
      providers: [
        { name: 'gemini', model: 'fake-gemini' },
        { name: 'anthropic', model: 'fake-anthropic' },
        { name: 'openai', model: 'fake-openai' },
      ],
      judge: { name: 'fake', promptVersion: 'juez-nota-v1' },
      tasks: [
        { name: 'cie10', promptVersions: { A: 'cie10-a-v1', D: 'cie10-d-v1' } },
        {
          name: 'prescription',
          promptVersions: { A: 'receta-a-v1', D: 'receta-d-v1' },
        },
        { name: 'note', promptVersions: { D: 'nota-v1' } },
      ],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(result.catalogues.map((c: { sha256: string }) => c.sha256)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    const invented = loadInventedCases();
    expect(result.cases.map((c: { sha256: string }) => c.sha256)).toEqual([
      invented.cie10.sha256,
      invented.prescription.sha256,
      invented.note.sha256,
    ]);
    // Every case, provider and arm: 45×3×2 + 30×3×2 + 10×3.
    expect(result.calls).toHaveLength(480);
    // No case text in the result: ids and what was shown only.
    expect(JSON.stringify(result.calls)).not.toContain(
      invented.cie10.cases[0]!.phrase,
    );

    const report = readFileSync(join(folder!, 'informe.md'), 'utf8');
    for (const heading of [
      '## CIE-10 por problema',
      '## Receta dictada',
      '## Nota de la consulta',
      '### D − A',
      '### F1 por campo',
      'Juez sin validar',
      'Proveedor falso',
    ]) {
      expect(report).toContain(heading);
    }
    // Intervals in every task table, and the 503 of the fake Gemini counted with its own.
    expect(
      report.match(/\[\d+\.\d %; \d+\.\d %\] n=\d+/g)!.length,
    ).toBeGreaterThan(100);
    const [, attempts, , s503] = report.match(
      /^\| gemini \| (\d+) \| (\d+) \| (\d+) \|/m,
    )!;
    expect(Number(attempts)).toBeGreaterThan(0);
    expect(Number(s503)).toBeGreaterThan(0);
    expect(lines.some((line) => /peor caso \d+\.\d+ USD/.test(line))).toBe(
      true,
    );
  });

  it('EV-3 a real run without ASSISTANT_ALLOW_REMOTE calls nobody and writes nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = scratch('out');

    await expect(
      runFromArgs(['--salida', out], {
        env: {
          ASSISTANT_GEMINI_API_KEY: 'k',
          ASSISTANT_MONTHLY_SPEND_CEILING_USD: '100',
        },
        now: () => new Date(),
        log: () => undefined,
        ledgerDir: scratch('ledger'),
      }),
    ).rejects.toThrow(/ASSISTANT_ALLOW_REMOTE/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readdirSync(out)).toEqual([]);
  });

  it('--estimar says the calls and the worst case, and calls nobody', async () => {
    const lines: string[] = [];
    const folder = await runFromArgs(
      ['--falso', '--estimar', '--tareas', 'cie10'],
      {
        env: {},
        now: () => new Date(),
        log: (line) => lines.push(line),
        ledgerDir: scratch('ledger'),
      },
    );
    expect(folder).toBeNull();
    expect(lines.join('\n')).toMatch(
      /^270 llamadas \(sin reintentos\); peor caso \d+\.\d{2} USD; techo 100 USD/,
    );
  });
});

describe('the runner', () => {
  const catalogues = loadCatalogues();
  const cases = loadInventedCases().cie10.cases.slice(0, 5);
  const answer = (code: string) => ({
    kind: 'answer' as const,
    text: JSON.stringify({ codes: [code] }),
  });

  it('asks again a provider that was not available, and counts every attempt', async () => {
    const store = new TaggingStore(new FileAiRunStore(scratch('ledger')));
    const fake = new FakeLlmProvider(
      [{ kind: 'status', status: 503 }, answer('R51.X')],
      'gemini',
    );
    const outcome = await runEvaluation({
      tasks: [{ task: cie10Task(catalogues), cases: cases.slice(0, 1) }],
      providers: [
        {
          name: 'gemini',
          model: 'fake-quality',
          client: clientFor(fake, {
            store,
            ceilingUsd: 100,
            timeoutMs: 5_000,
            clock: () => new Date(),
          }),
        },
      ],
      judge: null,
      store,
      tries: 3,
      backoffMs: 0,
    });

    const first = outcome.calls[0]!;
    expect(first).toMatchObject({
      answered: true,
      requests: 2,
      failure: null,
    });
    expect(
      outcome.attempts
        .filter((a) => a.arm === first.arm)
        .map((a) => a.httpStatus),
    ).toEqual([503, 200]);
  });

  it('EV-4 the ceiling ends the run and keeps what was measured', async () => {
    const store = new TaggingStore(new FileAiRunStore(scratch('ledger')));
    const fake = new FakeLlmProvider([answer('R51.X')], 'gemini');
    const outcome = await runEvaluation({
      tasks: [{ task: cie10Task(catalogues), cases }],
      providers: [
        {
          name: 'gemini',
          model: 'fake-quality',
          client: clientFor(fake, {
            store,
            // Room for the worst case of arm A (≈ 0.0022 USD), not of D (its
            // catalogue makes the prompt longer, ≈ 0.003): the first D stops it.
            ceilingUsd: 0.0025,
            timeoutMs: 5_000,
            clock: () => new Date(),
          }),
        },
      ],
      judge: null,
      store,
      tries: 1,
      backoffMs: 0,
    });

    expect(outcome.stopped).toMatch(/techo/);
    expect(outcome.calls.length).toBeGreaterThan(0);
    expect(outcome.calls.length).toBeLessThan(cases.length * 2);
    expect(fake.calls).toHaveLength(outcome.calls.length);
  });
});
