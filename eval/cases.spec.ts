import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CODIESP_SHA256,
  loadCaseFile,
  loadInventedCases,
  readCodiEsp,
  verifyCodiEsp,
} from './cases.ts';

const EVAL_ROOT = join(process.cwd(), 'eval');
const DOOR = 'eval/case-text.ts';

function sources(directory = EVAL_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name.startsWith('.') ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

const CAST =
  /(as\s+(PseudonymizedText|SystemInstruction)\b|<(PseudonymizedText|SystemInstruction)>|\bas\s+(never|any)\b)/;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'eval-cases-'));
}

describe('cases of the harness', () => {
  it('EV-1 loads the invented sets the repository versions, every case invented', () => {
    const sets = loadInventedCases();

    expect(sets.cie10.cases.length).toBeGreaterThanOrEqual(30);
    expect(sets.prescription.cases.length).toBeGreaterThanOrEqual(30);
    expect(sets.note.cases.length).toBeGreaterThanOrEqual(10);
    for (const set of [sets.cie10, sets.prescription, sets.note]) {
      expect(set.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(set.cases.every((c) => c.origin === 'invented')).toBe(true);
    }
  });

  it('EV-1 stops on a case without an allowed origin, before anything is called', () => {
    const dir = scratch();
    const path = join(dir, 'cie10.json');
    const valid = {
      id: 'x-1',
      origin: 'invented',
      phrase: 'cefalea',
      code: 'R51.X',
    };
    writeFileSync(path, JSON.stringify({ cases: [valid] }));
    // Positive control: the same file with an allowed origin loads.
    expect(loadCaseFile(path, 'cie10').cases).toHaveLength(1);

    for (const origin of [undefined, 'asclepio', 'real', 'codiesp']) {
      writeFileSync(path, JSON.stringify({ cases: [{ ...valid, origin }] }));
      expect(() => loadCaseFile(path, 'cie10')).toThrow(/origen/);
    }
  });

  it('EV-1 reads CodiEsp only from its own annotation files, as public cases', () => {
    const dir = scratch();
    for (const part of ['train', 'dev']) {
      const folder = join(dir, part);
      mkdirSync(folder);
      writeFileSync(
        join(folder, `${part}_annotations_task3_processed.tsv`),
        [
          `S0001-${part}\tDIAGNOSTICO\tn39.0\tinfección del tracto urinario\t1 2`,
          `S0001-${part}\tPROCEDIMIENTO\tbt41zzz\tecografía renal\t3 4`,
          `S0002-${part}\tDIAGNOSTICO\ti10\thipertensión arterial\t5 6`,
        ].join('\n'),
      );
    }

    const read = readCodiEsp(dir);

    expect(read.rows).toEqual([
      {
        article: 'S0001-train',
        phrase: 'infección del tracto urinario',
        code: 'n39.0',
      },
      { article: 'S0002-train', phrase: 'hipertensión arterial', code: 'i10' },
      {
        article: 'S0001-dev',
        phrase: 'infección del tracto urinario',
        code: 'n39.0',
      },
      { article: 'S0002-dev', phrase: 'hipertensión arterial', code: 'i10' },
    ]);
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => readCodiEsp(scratch())).toThrow(/CodiEsp/);
    // Same names, other content: it is not CodiEsp and nothing of it is sent.
    expect(() => verifyCodiEsp(read)).toThrow(/SHA-256/);
    // Positive control: the digests it was read with pass.
    expect(verifyCodiEsp(read, read.files)).toBe(read);
    expect(Object.keys(CODIESP_SHA256).sort()).toEqual(
      Object.keys(read.files).sort(),
    );
  });

  it('EV-2 mints case text in one file of eval/ and nowhere else', () => {
    const offenders = sources()
      .map((path) => relative(process.cwd(), path))
      .filter((path) => path !== DOOR)
      .filter((path) => {
        const source = readFileSync(join(process.cwd(), path), 'utf8');
        return (
          CAST.test(source) ||
          /type\s+\w+\s*=\s*(PseudonymizedText|SystemInstruction)\b/.test(
            source,
          )
        );
      });

    expect(offenders).toEqual([]);
    // Positive control: the scan sees the one door.
    expect(readFileSync(join(process.cwd(), DOOR), 'utf8')).toMatch(CAST);
  });
});
