import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Every file the audio passes through, from the socket to `clinica-ai`. */
const AUDIO_PATH = [
  '../domain/listening.ts',
  '../application/listening.service.ts',
  '../application/speech-recognizer.port.ts',
  './listening.gateway.ts',
  './clinica-ai.speech-recognizer.ts',
];

const FILE_SYSTEM =
  /from ['"](node:)?fs(\/promises)?['"]|require\(['"](node:)?fs/;

describe('the audio never touches the disk (AS-053)', () => {
  it.each(AUDIO_PATH)('AS-053: %s does not import the file system', (file) => {
    const source = readFileSync(resolve(__dirname, file), 'utf8');

    // Positive control: the pattern does catch an import of the file system.
    expect(`import { writeFileSync } from 'node:fs';`).toMatch(FILE_SYSTEM);
    expect(source).not.toMatch(FILE_SYSTEM);
  });
});
