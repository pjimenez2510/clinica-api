# Catálogos

Archivos de origen de los catálogos clínicos. **No son código: son datos**, y de
dónde vienen importa tanto como su contenido. Cada importador guarda en
`catalog_release` la versión, el origen y el SHA-256 del archivo que cargó, y
retira —nunca borra— la edición anterior desde el día de corte (el día clínico
siguiente a la importación, en `America/Guayaquil`).

| Archivo | Qué es | Origen | SHA-256 |
|---|---|---|---|
| `cie10-oms-deis-2026-08.xlsx` | CIE-10 de la OMS en español, lista tabular, 12 548 códigos de 4 caracteres en tres hojas (principal, asterisco, causa externa). La que usa el RDACAA | Centro FIC de Chile, DEIS MINSAL, agosto de 2026; entregado por el autor (`clinica-docs`) | `0d5e19d5d68856aee9379cc91ec16ac931cbfb60dcd06575dec5089cc0a5a75a` |
| `tarifario-sns-2014.csv` | Tarifario de Prestaciones para el SNS 2014, extraído del PDF de 363 páginas: 8 835 filas, 8 523 códigos | `scripts/extract-tariff.mts` sobre `clinica-docs/TARIFARIO-PRESTACIONES-SNS-2014.pdf` (su SHA-256 va en la primera línea del CSV) | PDF: `d26358f5d9850365a098b875820fe8d14727ae55bcfb3dbffc20082ebae0cdba` |
| `cnmb-2026.xlsx` | Cuadro Nacional de Medicamentos Básicos, 890 presentaciones | MSP / CONASA; entregado por el autor (`clinica-docs`) | `e968d14c9fa3896e7e5cfcb2eb9717b2cde25a7483387ce7f5ced3d62dbdf2e1` |

## CIE-10

`pnpm db:seed:cie10` (`seed-cie10.mts`, EN-233). La lista **no trae capítulos,
grupos ni categorías de tres caracteres**: los 22 capítulos de la OMS se
añaden como raíz del árbol desde `src/modules/catalogs/import/cie10-who.ts`, y
cada código se guarda con punto (`J02.9`; los de tres caracteres sin
subdivisión conservan la `X` de la lista: `I10.X`). La hoja de origen va en
`attributes.use`.

Antes de importar, el guion lista los códigos ya registrados que la edición no
trae, con su equivalencia propuesta (EN-234). No cambia ningún diagnóstico.

**No se usa la CIE-10-ES de España**: es una adaptación nacional derivada de la
CIE-10-CM estadounidense, con códigos que la OMS no tiene. La lista de
desarrollo que hubo aquí antes (`cie10-desarrollo.csv`, raspada de la
CIE-10-CM) se retiró el 06-10-2026; las bases que la cargaron conservan sus
filas, retiradas.

Otra edición: `CIE10_FILE`, `CIE10_VERSION`, `CIE10_SOURCE_URL`;
`CIE10_EFFECTIVE_FROM=AAAA-MM-DD` fija el día de corte.

## CNMB

`seedClinicalCatalogues` (`pnpm db:seed`) importa el cuadro (PR-114 a PR-116):
un concepto por «Código medicamento», con sus presentaciones, ATC, nivel de
prescripción y de atención, vía y riesgo en embarazo. La forma del cuadro
(«Sólido oral») se traduce a las formas de la receta que admite
(`src/modules/catalogs/import/cnmb.ts`). Los estupefacientes y psicotrópicos
se marcan por `CONTROLLED_CODES` (D-148, pendiente de un farmacéutico), y cada
medicamento lleva en `replaces` el código del cuadro de desarrollo que fue.

## Tarifario

El PDF no se versiona aquí (8,6 MB): vive en `clinica-docs`. El CSV se
regenera con poppler instalado:

```bash
node --experimental-strip-types scripts/extract-tariff.mts
```

Las filas se reconstruyen con los **bordes de las celdas**, no con el texto
(ver `tariff-rows.ts`). El guion informa de lo que no pudo leer: un ejemplo de
cálculo (p. 83), la tabla de ejemplos de anestesia (p. 102), dos totales
(p. 340) y la fila «Psicoanálisis médico» de la p. 290, que en el propio PDF
no tiene código. Un código puede aparecer más de una vez —casi siempre la
misma prestación en el componente institucional (sección B) y en honorarios
(sección D)—: el concepto es uno y `attributes.entries` guarda cada aparición.

`seedClinicalCatalogues` lo importa (ORD-133) como nomenclatura: guarda las
UVR y ningún importe, porque el factor de conversión está por decidir (D-149).
Los códigos anteriores que un examen activo todavía nombra siguen vigentes y se
informan, para ponerles el código oficial desde el catálogo de exámenes.
