import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeLlmProvider } from '../src/modules/assistant/infrastructure/fake-llm.provider.ts';

import { loadInventedCases } from './cases.ts';
import { loadCatalogues } from './catalogue.ts';
import { FileAiRunStore, ledgerDirFrom } from './ledger.ts';
import { runFromArgs } from './main.ts';
import { renderReport, type RunMetadata } from './report.ts';
import { clientFor } from './providers.ts';
import { runEvaluation, TaggingStore } from './runner.ts';
import { cie10Task, inventedCie10Cases } from './tasks/cie10.ts';
import { noteTask } from './tasks/note.ts';

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
      print: (line) => lines.push(line),
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
    ) as {
      commit: string;
      catalogues: { file: string; sha256: string }[];
      cases: { sha256: string }[];
      calls: unknown[];
    };
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
      judge: { name: 'fake', promptVersion: 'juez-nota-v2' },
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
    expect(result.catalogues).toEqual([
      {
        file: 'cie10-oms-deis-2026-08.xlsx',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        file: 'cnmb-2026.xlsx',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        file: 'llm-pricing.json',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
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
        print: () => undefined,
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
        print: (line) => lines.push(line),
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
  const cases = inventedCie10Cases(loadInventedCases().cie10.cases.slice(0, 5));
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

  const client = (fake: FakeLlmProvider, store: TaggingStore) =>
    clientFor(fake, {
      store,
      ceilingUsd: 100,
      timeoutMs: 5_000,
      clock: () => new Date(),
    });

  it("an error that is not the provider's ends the run instead of reading as an unanswered case", async () => {
    const store = new TaggingStore(new FileAiRunStore(scratch('ledger')));
    // A model with no price in force: the routing refuses it (AS-016).
    const unpriced = new FakeLlmProvider([answer('R51.X')], 'gemini', {
      fast: 'sin-precio',
      quality: 'sin-precio',
    });
    const outcome = await runEvaluation({
      tasks: [{ task: cie10Task(catalogues), cases }],
      providers: [
        {
          name: 'gemini',
          model: 'sin-precio',
          client: client(unpriced, store),
        },
      ],
      judge: null,
      store,
      tries: 1,
      backoffMs: 0,
    });
    expect(outcome.stopped).toMatch(/no es del proveedor/);
    expect(outcome.calls).toHaveLength(0);
  });

  it('an attempt the ledger did not take ends the run, and is still in the report', async () => {
    const ledger = new FileAiRunStore(scratch('ledger'));
    vi.spyOn(ledger, 'record').mockRejectedValue(new Error('EACCES'));
    const store = new TaggingStore(ledger);
    const fake = new FakeLlmProvider([answer('R51.X')], 'gemini');
    const outcome = await runEvaluation({
      tasks: [{ task: cie10Task(catalogues), cases }],
      providers: [
        { name: 'gemini', model: 'fake-quality', client: client(fake, store) },
      ],
      judge: null,
      store,
      tries: 1,
      backoffMs: 0,
    });
    expect(outcome.stopped).toMatch(/registro de gasto/);
    expect(fake.calls).toHaveLength(1);
    expect(outcome.attempts).toHaveLength(1);
  });

  it('a provider that also judges keeps the judge out of its availability', async () => {
    const store = new TaggingStore(new FileAiRunStore(scratch('ledger')));
    const note = loadInventedCases().note.cases[0]!;
    const written = JSON.stringify({
      sections: [
        { section: 'motivo', segments: [{ text: 'Odinofagia', source: 2 }] },
      ],
    });
    // The provider writes the note, then — as the judge — fails twice with 503 and answers.
    const verdicts = JSON.stringify({
      facts: note.facts.map((_, i) => ({ n: i + 1, present: true })),
      segments: [{ n: 1, supported: true }],
    });
    const fake = new FakeLlmProvider(
      [
        { kind: 'answer', text: written },
        { kind: 'status', status: 503 },
        { kind: 'status', status: 503 },
        { kind: 'answer', text: verdicts },
      ],
      'anthropic',
    );
    const measured = {
      name: 'anthropic' as const,
      model: 'fake-quality',
      client: client(fake, store),
    };
    const outcome = await runEvaluation({
      tasks: [{ task: noteTask(), cases: [note] }],
      providers: [measured],
      judge: measured,
      store,
      tries: 3,
      backoffMs: 0,
    });
    const meta = {
      label: 'x',
      fake: true,
      ledger: 'x',
      startedAt: 'x',
      finishedAt: 'x',
      commit: 'x',
      seed: 1,
      ceilingUsd: 100,
      providers: [{ name: 'anthropic', model: 'fake-quality' }],
      withoutKey: [],
      judge: {
        name: 'anthropic',
        model: 'fake-quality',
        promptVersion: 'juez-nota-v2',
      },
      tasks: [],
      catalogues: [],
      cases: [],
      codiesp: null,
    } satisfies RunMetadata;
    const report = renderReport(
      meta,
      outcome,
      [noteTask()],
      new Map([[note.id, note]]),
    );

    expect(report).toMatch(/^\| anthropic \| 1 \| 1 \| 0 \| 0 \| 0 \|/m);
    expect(report).toMatch(/^\| juez \(anthropic\) \| 3 \| 1 \| 2 \|/m);
    expect(report).toContain(
      'El juez es uno de los proveedores comparados (anthropic)',
    );
    expect(outcome.calls[0]!.scores).toMatchObject({ judged: 1 });
  });
});

describe('the command line', () => {
  it('EV-8 `pnpm eval` loads under plain Node with register.mjs, not only under vitest', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '--no-warnings',
        '--import',
        './eval/register.mjs',
        'eval/main.ts',
        '--falso',
        '--estimar',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, EVAL_LEDGER_DIR: scratch('ledger') },
      },
    );
    expect(output).toMatch(
      /^\d+ llamadas \(sin reintentos\); peor caso \d+\.\d{2} USD/,
    );
  });

  it('EV-4 the ledger is one per machine, the same from every worktree, unless EVAL_LEDGER_DIR moves it', () => {
    const here = ledgerDirFrom({});
    expect(here).not.toContain(process.cwd());
    expect(here).toMatch(/\.clinica-eval[/\\]gasto$/);
    expect(ledgerDirFrom({ EVAL_LEDGER_DIR: '/x/y' })).toBe('/x/y');
  });

  it('refuses numbers and labels that would quietly change the run', async () => {
    const deps = {
      env: {},
      now: () => new Date(),
      print: () => undefined,
      ledgerDir: scratch('ledger'),
    };
    for (const args of [
      ['--intentos', '0'],
      ['--intentos', 'abc'],
      ['--casos', 'abc'],
      ['--muestra', '-1'],
      ['--semilla', 'x'],
      ['--etiqueta', '../fuera'],
    ]) {
      await expect(
        runFromArgs(['--falso', '--estimar', ...args], deps),
        args.join(' '),
      ).rejects.toThrow(/--/);
    }
    // Positive control: the same flags, well formed.
    await expect(
      runFromArgs(
        [
          '--falso',
          '--estimar',
          '--intentos',
          '2',
          '--casos',
          '3',
          '--semilla',
          '0',
          '--etiqueta',
          'prueba-1',
        ],
        deps,
      ),
    ).resolves.toBeNull();
  });

  it('AS-098 --tope-proveedor stops the run before an attempt that would pass it', async () => {
    const lines: string[] = [];
    const folder = await runFromArgs(
      ['--', '--falso', '--tareas', 'borrador', '--casos', '2', '--tope-proveedor', '0.000001', '--salida', scratch('out')], // prettier-ignore
      { env: {}, now: () => new Date(), print: (line) => lines.push(line), ledgerDir: scratch('ledger') }, // prettier-ignore
    );

    const result = JSON.parse(readFileSync(join(folder!, 'resultado.json'), 'utf8')) as { stopped: string | null; calls: { answered: boolean }[] }; // prettier-ignore
    expect(result.stopped).not.toBeNull();
    expect(result.calls.filter((call) => call.answered)).toHaveLength(0);
  });
});
