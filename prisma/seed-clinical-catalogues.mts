import { createHash } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * CNMB y tarifario de prestaciones, EN VERSIÓN DE DESARROLLO.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LEA ESTO ANTES DE USARLO PARA ALGO QUE NO SEA PROBAR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **ESTO NO ES EL CNMB.** El Cuadro Nacional de Medicamentos Básicos vigente
 * es la **11.ª revisión, con 494 principios activos**, y la **12.ª —512— se
 * aprobó el 5 de agosto de 2026** y entra al publicarse en Registro Oficial.
 * Lo que hay aquí son **treinta y tantos principios activos reales** de los más
 * usados en consulta externa, cargados para que el módulo de receta se pueda
 * ejercitar. La carga real es un trabajo de datos, no de código, y está en el
 * ROADMAP.
 *
 * ⚠️ **Y ESTO NO ES EL TARIFARIO.** Son los conceptos mínimos para que una
 * orden de examen se pueda emitir, derivados de `exam_definition`. El Tarifario
 * de Prestaciones del SNS es un PDF de 2014 sin formato estructurado, y además
 * —esto importa— **no fija lo que la clínica cobra a un paciente particular**:
 * su ámbito se redujo en 2017 al relacionamiento dentro de la red pública. Aquí
 * sirve sólo como NOMENCLATURA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque sin él los dos módulos son inoperables y alguien acaba metiendo filas
 * a mano en la base para poder probar — que fue exactamente lo que pasó. Datos
 * escritos a mano no se reproducen, no se revisan y no se borran: aparecen un
 * año después con un código inventado dentro de una receta impresa.
 *
 * La versión lleva `DEV` en el nombre a propósito, para que ninguna instalación
 * confunda esto con la lista del ministerio.
 */

/** Principios activos por su Denominación Común Internacional. */
const CNMB_DEV: readonly { code: string; display: string; form: string }[] = [
  { code: 'PARACETAMOL', display: 'Paracetamol', form: 'tableta / jarabe' },
  { code: 'IBUPROFENO', display: 'Ibuprofeno', form: 'tableta / suspensión' },
  { code: 'AMOXICILINA', display: 'Amoxicilina', form: 'cápsula / suspensión' },
  { code: 'AMOXICILINA-CLAVULANICO', display: 'Amoxicilina + ácido clavulánico', form: 'tableta / suspensión' }, // prettier-ignore
  { code: 'AZITROMICINA', display: 'Azitromicina', form: 'tableta / suspensión' }, // prettier-ignore
  { code: 'CEFALEXINA', display: 'Cefalexina', form: 'cápsula / suspensión' },
  { code: 'CIPROFLOXACINO', display: 'Ciprofloxacino', form: 'tableta' },
  { code: 'TRIMETOPRIMA-SULFAMETOXAZOL', display: 'Trimetoprima + sulfametoxazol', form: 'tableta / suspensión' }, // prettier-ignore
  {
    code: 'METRONIDAZOL',
    display: 'Metronidazol',
    form: 'tableta / suspensión',
  },
  { code: 'NITROFURANTOINA', display: 'Nitrofurantoína', form: 'cápsula' },
  { code: 'LORATADINA', display: 'Loratadina', form: 'tableta / jarabe' },
  { code: 'CETIRIZINA', display: 'Cetirizina', form: 'tableta / gotas' },
  { code: 'SALBUTAMOL', display: 'Salbutamol', form: 'inhalador / solución para nebulizar' }, // prettier-ignore
  { code: 'PREDNISONA', display: 'Prednisona', form: 'tableta' },
  { code: 'DEXAMETASONA', display: 'Dexametasona', form: 'ampolla / tableta' },
  { code: 'OMEPRAZOL', display: 'Omeprazol', form: 'cápsula' },
  { code: 'RANITIDINA', display: 'Ranitidina', form: 'tableta' },
  {
    code: 'METOCLOPRAMIDA',
    display: 'Metoclopramida',
    form: 'tableta / ampolla',
  },
  { code: 'SALES-REHIDRATACION', display: 'Sales de rehidratación oral', form: 'sobre' }, // prettier-ignore
  { code: 'ALBENDAZOL', display: 'Albendazol', form: 'tableta / suspensión' },
  { code: 'ENALAPRIL', display: 'Enalapril', form: 'tableta' },
  { code: 'LOSARTAN', display: 'Losartán', form: 'tableta' },
  { code: 'AMLODIPINO', display: 'Amlodipino', form: 'tableta' },
  { code: 'HIDROCLOROTIAZIDA', display: 'Hidroclorotiazida', form: 'tableta' },
  { code: 'ATORVASTATINA', display: 'Atorvastatina', form: 'tableta' },
  { code: 'METFORMINA', display: 'Metformina', form: 'tableta' },
  { code: 'GLIBENCLAMIDA', display: 'Glibenclamida', form: 'tableta' },
  { code: 'INSULINA-NPH', display: 'Insulina humana NPH', form: 'vial' },
  { code: 'LEVOTIROXINA', display: 'Levotiroxina sódica', form: 'tableta' },
  { code: 'ACIDO-FOLICO', display: 'Ácido fólico', form: 'tableta' },
  {
    code: 'SULFATO-FERROSO',
    display: 'Sulfato ferroso',
    form: 'tableta / jarabe',
  },
  { code: 'CARBONATO-CALCIO', display: 'Carbonato de calcio', form: 'tableta' },
  { code: 'ACIDO-ACETILSALICILICO', display: 'Ácido acetilsalicílico', form: 'tableta' }, // prettier-ignore
  {
    code: 'DICLOFENACO',
    display: 'Diclofenaco sódico',
    form: 'tableta / ampolla',
  },
  { code: 'TRAMADOL', display: 'Tramadol', form: 'cápsula / ampolla' },
];

const CNMB_VERSION = 'DEV-2026-08';
const TARIFF_VERSION = 'DEV-2026-08';
const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00Z');

function checksumOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function seedClinicalCatalogues(prisma: PrismaClient) {
  // ── CNMB ────────────────────────────────────────────────────────────────
  const cnmb = await prisma.catalogSystem.upsert({
    where: { code: 'CNMB' },
    update: { name: 'Cuadro Nacional de Medicamentos Básicos', hierarchical: false }, // prettier-ignore
    create: { code: 'CNMB', name: 'Cuadro Nacional de Medicamentos Básicos', hierarchical: false }, // prettier-ignore
  });

  const cnmbChecksum = checksumOf(CNMB_DEV);
  const cnmbExisting = await prisma.catalogRelease.findUnique({
    where: { systemId_version: { systemId: cnmb.id, version: CNMB_VERSION } },
  });

  let cnmbCount = 0;
  if (!cnmbExisting) {
    await prisma.$transaction(async (tx) => {
      const release = await tx.catalogRelease.create({
        data: {
          systemId: cnmb.id,
          version: CNMB_VERSION,
          publishedOn: EFFECTIVE_FROM,
          effectiveFrom: EFFECTIVE_FROM,
          sourceUrl: 'https://www.conasa.gob.ec/biblioteca/',
          sourceChecksum: cnmbChecksum,
        },
      });
      // Retirar, no borrar: hay recetas que apuntan a estas filas por su id.
      await tx.catalogConcept.updateMany({
        where: { systemId: cnmb.id, validTo: null },
        data: { validTo: EFFECTIVE_FROM, retiredByReleaseId: release.id },
      });
      const created = await tx.catalogConcept.createMany({
        data: CNMB_DEV.map((item) => ({
          systemId: cnmb.id,
          introducedByReleaseId: release.id,
          code: item.code,
          display: item.display,
          validFrom: EFFECTIVE_FROM,
          attributes: {
            form: item.form,
            source: 'DEV FIXTURE — no es el CNMB',
          },
        })),
      });
      cnmbCount = created.count;
    });
  } else {
    cnmbCount = await prisma.catalogConcept.count({
      where: { systemId: cnmb.id, validTo: null },
    });
  }

  // ── Tarifario, derivado de los exámenes que la clínica sabe hacer ───────
  const tariff = await prisma.catalogSystem.upsert({
    where: { code: 'TARIFF' },
    update: { name: 'Tarifario de prestaciones', hierarchical: false },
    create: { code: 'TARIFF', name: 'Tarifario de prestaciones', hierarchical: false }, // prettier-ignore
  });

  const exams = await prisma.examDefinition.findMany({
    where: { active: true },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  });

  let tariffCount = 0;
  if (exams.length > 0) {
    const tariffChecksum = checksumOf(exams);
    const existing = await prisma.catalogRelease.findUnique({
      where: { systemId_version: { systemId: tariff.id, version: TARIFF_VERSION } }, // prettier-ignore
    });
    if (!existing) {
      await prisma.$transaction(async (tx) => {
        const release = await tx.catalogRelease.create({
          data: {
            systemId: tariff.id,
            version: TARIFF_VERSION,
            publishedOn: EFFECTIVE_FROM,
            effectiveFrom: EFFECTIVE_FROM,
            sourceUrl: 'derivado de exam_definition',
            sourceChecksum: tariffChecksum,
          },
        });
        await tx.catalogConcept.updateMany({
          where: { systemId: tariff.id, validTo: null },
          data: { validTo: EFFECTIVE_FROM, retiredByReleaseId: release.id },
        });
        const created = await tx.catalogConcept.createMany({
          data: exams.map((exam) => ({
            systemId: tariff.id,
            introducedByReleaseId: release.id,
            code: exam.code,
            display: exam.name,
            validFrom: EFFECTIVE_FROM,
            attributes: { source: 'DEV FIXTURE — derivado de exam_definition' },
          })),
        });
        tariffCount = created.count;
      });
    } else {
      tariffCount = await prisma.catalogConcept.count({
        where: { systemId: tariff.id, validTo: null },
      });
    }
  }

  console.log('Catálogos clínicos de desarrollo:');
  console.log(`  CNMB    ${String(cnmbCount).padStart(4)}  ⚠️ NO es el CNMB: el vigente tiene 494 principios activos`); // prettier-ignore
  console.log(`  TARIFF  ${String(tariffCount).padStart(4)}  derivado de exam_definition, sólo como nomenclatura`); // prettier-ignore
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  await seedClinicalCatalogues(prisma);
  await prisma.$disconnect();
}
