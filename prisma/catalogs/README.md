# Catálogos

Archivos de origen de los catálogos clínicos. **No son código: son datos**, y de
dónde vienen importa tanto como su contenido.

---

## ⚠️ `cie10-desarrollo.csv` NO ES LA FUENTE OFICIAL

Es un conjunto de **desarrollo**. Sirve para construir y probar la búsqueda, la
jerarquía y la vigencia temporal; **no sirve para reportar al MSP**.

| | |
|---|---|
| Origen | `github.com/verasativa/CIE-10`, obtenido a su vez por raspado de `icdcode.info` |
| Filas | 14 498 — 21 capítulos, 209 grupos, y categorías hasta el quinto nivel |
| SHA-256 | `c3963d12c44706be2bc629c2beb401cd249a51db45cc24a4e22198f771824765` |
| Verificado | Sin duplicados, sin descripciones vacías, sin códigos que apunten a un capítulo inexistente |

Se importa con la versión `desarrollo-2019` precisamente para que nadie la
confunda con una edición oficial, y el importador **se niega** a cargarlo si
`NODE_ENV=production`.

### Por qué no se usa la API de la OMS

Se comprobó: **la API de la OMS no publica la CIE-10 en español.** Sus
lanzamientos de CIE-10 (2008, 2010, 2016, 2019) están en inglés, y sólo el de
2008 añade francés. El español existe únicamente en CIE-11, que Ecuador todavía
no exige.

### Y por qué no la CIE-10-ES

La CIE-10-ES del Ministerio de Sanidad español es una **adaptación nacional**
—de hecho derivada de la CIE-10-CM estadounidense— con códigos que no existen
en la CIE-10 de la OMS. Usarla produciría diagnósticos que el MSP rechaza.

### Qué hace falta para producción

La edición oficial en español de la CIE-10 la distribuye la **OPS/OMS** como
Centro Colaborador para la Familia de Clasificaciones Internacionales, y el MSP
publica la lista que exige el RDACAA. Ninguna de las dos está disponible en un
formato de datos abierto: hay que solicitarla o extraerla del PDF, y verificarla
contra la lista del ministerio.

**El sistema no depende de resolver eso para funcionar.** El importador acepta
cualquier archivo con el formato descrito abajo, y `catalog_release` guarda la
URL y el SHA-256 de lo que se cargó — así que el día que llegue el archivo
oficial se importa como una versión nueva y los diagnósticos históricos siguen
resolviéndose con el catálogo de su época, que es para lo que existe la
vigencia temporal.

---

## Formato que espera el importador

CSV con cabecera y estas columnas:

| Columna | Contenido |
|---|---|
| `code` | Código sin punto: `A09`, `T230` |
| `code_0` … `code_4` | Cadena de ancestros, de capítulo a categoría. Vacías las que no apliquen |
| `description` | Texto en español |
| `level` | `0` capítulo, `1` grupo, `2`+ categorías |

El importador inserta el punto de la CIE-10 al guardar (`T230` → `T23.0`),
porque es la forma que un médico lee y escribe. La búsqueda acepta las dos.
