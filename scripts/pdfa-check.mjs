/**
 * SC-062, DOC-020 to DOC-025. Validates the generator's output with veraPDF,
 * the reference PDF/A validator, run from its official image (`verapdf/cli`)
 * so no JVM is needed on the machine.
 *
 * WHY OUTSIDE THE PROCESS. A test that uses the library that generated a file
 * proves consistency, not conformance. The unit tests check the signs DOC-020
 * to DOC-024 name — necessary and not sufficient; this is the sufficient half.
 *
 * Usage:
 *   pnpm pdfa:check                  renders a sample of each class from `dist/`
 *                                    (run `pnpm build` first) and validates them
 *   pnpm pdfa:check a.pdf b.pdf      validates the files given
 *
 * Writes veraPDF's report beside the PDFs and exits non-zero if any fails.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const IMAGE = 'verapdf/cli:latest';

/** Renders one sample PDF of each class with the compiled generator. */
async function renderSamples(outDir) {
  require('reflect-metadata');
  const dist = resolve('dist/modules/documents');
  const { composeLayout } = require(`${dist}/domain/document-layout.js`);
  const { sampleSubject } = require(`${dist}/domain/document-samples.js`);
  const { PdfKitDocumentRenderer } = require(
    `${dist}/infrastructure/pdfkit-document.renderer.js`,
  );

  const context = {
    siteName: 'Sede Norte',
    siteLine: 'Sede Norte · Unicódigo 000000',
    verificationBaseUrl: 'http://localhost:3001/verificar',
    establishment: {
      name: 'Clínica de Muestra',
      ruc: '1790000000001',
      addressLine: 'Av. Amazonas N34-120, Quito',
      phone: '02-2456789',
      email: 'contacto@example.com',
      operatingPermit: 'ACESS-0000-0000',
      logo: null,
      keepsAccounting: true,
      specialTaxpayerResolution: null,
      withholdingAgentResolution: null,
      rimpeRegime: 'NONE',
    },
  };
  const renderer = new PdfKitDocumentRenderer();
  const issuedAt = new Date();
  const files = [];

  for (const kind of [
    'PRESCRIPTION',
    'SERVICE_ORDER',
    'MEDICAL_CERTIFICATE',
    'INVOICE_RIDE',
  ]) {
    const template = {
      id: 'sample',
      kind,
      version: 1,
      publishedAt: issuedAt,
      accentColour: '#0f6b5c',
      footerText: 'Pie de muestra',
      headerFields: [],
      showEstablishmentRuc: true,
      showEstablishmentAddress: true,
      showEstablishmentPhone: true,
    };
    const layout = composeLayout(
      sampleSubject(kind, issuedAt),
      context,
      template,
    );
    const pdf = await renderer.render(
      layout,
      { logo: null, seal: null, signature: null },
      {
        title: layout.frame.title,
        author: 'Clínica de Muestra',
        createdAt: issuedAt,
      },
    );
    const file = join(outDir, `${kind.toLowerCase()}.pdf`);
    writeFileSync(file, pdf);
    files.push(file);
  }
  return files;
}

const given = process.argv.slice(2).map((file) => resolve(file));
const files =
  given.length > 0
    ? given
    : await renderSamples(mkdtempSync(join(tmpdir(), 'pdfa-')));

let failed = 0;
for (const file of files) {
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-v',
      `${dirname(file)}:/data:ro`,
      IMAGE,
      '--flavour',
      '1b',
      '--format',
      'text',
      `/data/${basename(file)}`,
    ],
    { encoding: 'utf8' },
  );
  if (run.error) {
    console.error(`✘ no se pudo ejecutar docker: ${run.error.message}`);
    process.exit(2);
  }
  const report = `${run.stdout}${run.stderr}`;
  writeFileSync(`${file}.verapdf.txt`, report);
  const passed = /^PASS /m.test(report);
  if (!passed) failed += 1;
  console.log(`${passed ? '✔' : '✘'} ${file}`);
  if (!passed) console.log(report);
}

process.exit(failed === 0 ? 0 : 1);
