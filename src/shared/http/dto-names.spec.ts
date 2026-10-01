import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The OpenAPI document names each schema after its DTO CLASS, and two classes
 * with the same name in two modules are ONE schema: the last one registered
 * silently replaces the other. It happened: `certificates` and `sri` both had
 * a `CertificateDto`, and the interface's generated types described the
 * medical certificate with the fields of the signing certificate. Nothing
 * failed — the compiler only sees the generated file.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('los nombres de los DTO del contrato', () => {
  it('ningún nombre de DTO se repite entre módulos: el OpenAPI los fundiría en uno', () => {
    const seen = new Map<string, string[]>();
    for (const file of sourceFiles(join(import.meta.dirname, '../..'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /export class (\w+Dto)\b/g,
      )) {
        const name = match[1]!;
        seen.set(name, [...(seen.get(name) ?? []), file]);
      }
    }

    // Control positivo: el recorrido encuentra los DTO de verdad.
    expect(seen.has('MedicalCertificateDto')).toBe(true);
    const repeated = [...seen].filter(([, files]) => files.length > 1);
    expect(repeated).toEqual([]);
  });
});
