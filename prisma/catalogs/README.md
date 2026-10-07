# Catálogos

Archivos de origen de los catálogos clínicos. **No son código: son datos**, y de
dónde vienen importa tanto como su contenido. Cada importador guarda en
`catalog_release` la versión, el origen y el SHA-256 del archivo que cargó, y
retira —nunca borra— la edición anterior desde el día de corte (el día clínico
siguiente a la importación, en `America/Guayaquil`).

| Archivo | Qué es | Origen | SHA-256 |
|---|---|---|---|
| `cie10-oms-deis-2026-08.xlsx` | CIE-10 de la OMS en español, lista tabular, 12 548 códigos de 4 caracteres en tres hojas (principal, asterisco, causa externa). La que usa el RDACAA | Centro FIC de Chile, DEIS MINSAL, agosto de 2026; entregado por el autor (`clinica-docs`) | `0d5e19d5d68856aee9379cc91ec16ac931cbfb60dcd06575dec5089cc0a5a75a` |
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
