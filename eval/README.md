# Arnés de evaluación del asistente

Mide lo que el asistente propone antes de encenderlo (`PLAN-ASISTENTE-IA.md`
§5 y §7 A6) y compara los tres proveedores sobre los mismos casos para
confirmar o cambiar el principal (**D-239 §5**). Corre **fuera del verify**:
no lo ejecutan `pnpm verify` ni `pnpm test`, sólo `pnpm typecheck` lo compila.

## Reglas

- **Ningún dato real.** Sólo casos inventados (`casos/*.json`, cada uno con
  `"origin": "invented"`) o públicos: CodiEsp. El cargador detiene la corrida
  ante cualquier otro origen antes de construir una llamada (EV-1). Nunca se
  añade un caso sacado de una base, un volcado o una historia.
- **Una sola puerta** del texto de un caso al tipo `PseudonymizedText`:
  `case-text.ts` (EV-2). Una prueba recorre `eval/` y falla con cualquier
  otra conversión.
- **Las claves nunca se commitean.** Viven en el `.env` del worktree (que git
  ignora). Sin `ASSISTANT_ALLOW_REMOTE=true` no se construye ningún proveedor
  y no sale ninguna petición (EV-3).
- **Techo de gasto:** el menor entre `ASSISTANT_MONTHLY_SPEND_CEILING_USD` y
  **100 USD al mes** (D-241 §1). Se mira antes de cada intento con su peor
  caso, con la misma lógica de la aplicación (AS-017), contra el registro de
  intentos de todas las corridas del mes en `eval/.gasto/` (sin texto; git lo
  ignora). Si no cabe, la corrida se detiene y el informe recoge lo medido
  (EV-4). La corrida falsa lleva su propio registro (`eval/.gasto/falso/`).

## Cómo se corre

```bash
pnpm eval:test                 # pruebas del arnés (con el proveedor falso, sin red)
pnpm eval -- --falso           # corrida completa simulada: prueba el arnés, no mide a nadie
pnpm eval -- --ayuda           # todas las opciones
```

**Corrida real (la hace el autor).** En el `.env` del worktree:
`ASSISTANT_ALLOW_REMOTE=true`, `ASSISTANT_GEMINI_API_KEY`,
`ASSISTANT_ANTHROPIC_API_KEY`, `ASSISTANT_OPENAI_API_KEY` y
`ASSISTANT_MONTHLY_SPEND_CEILING_USD=100`. Después, primero la estimación y
luego la corrida:

```bash
pnpm eval -- --codiesp /Users/pjimenez/Documents/Personal/TESIS/PROYECTO/analisis/crudos/codiesp/train_dev --estimar
```

```bash
pnpm eval -- --codiesp /Users/pjimenez/Documents/Personal/TESIS/PROYECTO/analisis/crudos/codiesp/train_dev --etiqueta proveedores
```

Con las tres tareas, 200 frases de CodiEsp y los sets propios son unas 1 700
llamadas (más los reintentos) y un peor caso de unos pocos dólares; `--estimar`
da la cifra exacta antes de gastar. Una clave **gratuita** de Gemini permite
al proveedor usar las peticiones (D-241 §10): con casos inventados y públicos
no hay dato personal en juego, pero conviene usar la de pago.

## Qué mide

Cada proveedor por separado, con su modelo del nivel `quality` de
`src/modules/assistant/infrastructure/model-routing.ts`, por el mismo
`RoutingLlmClient` de la aplicación y **sin respaldo**: un 503 es error de ese
proveedor. El orden de los proveedores rota con cada caso. Un proveedor no
disponible se reintenta hasta `--intentos` veces; todos los intentos cuentan
en la tasa de error.

| Tarea | Casos | Brazos | Métricas |
|---|---|---|---|
| CIE-10 por problema | `cie10-propios.json` + CodiEsp-X (frases de diagnóstico) | A, D | acierto@1, R@5, categoría@1, códigos inexistentes mostrados |
| Receta dictada | `receta.json` | A, D | acierto y F1 por campo (principio activo, forma, concentración, dosis, vía, frecuencia, duración), fuera del CNMB |
| Nota de la consulta | `nota.json` | una | secciones fuera de plantilla y frases sin línea (sin modelo); hechos omitidos y frases sin respaldo (juez) |

- **A** — sin catálogo: el modelo escribe de memoria y nada lo comprueba.
- **D** — se buscan candidatos en la CIE-10 OMS o en el CNMB del repositorio
  (`prisma/catalogs/`, con su SHA-256), van al prompt, el modelo elige y una
  barrera determinista quita lo que el catálogo no tiene.
- B, C y E del §5 necesitan historias estructuradas: son de la fase F.
- **El juez de la nota no está validado.** Es un único modelo (`--juez`, por
  defecto Anthropic) con instrucciones fijas en `tasks/note.ts`; sus cifras
  orientan y no deciden hasta medir su κ (`stats.ts::cohenKappa`) contra una
  submuestra revisada por médicos.

**Estadística** (`stats.ts`, de SigmAI): Wilson 95 % para cada proporción;
bootstrap de casos (10 000 remuestras, semilla fija) para las fracciones por
caso y las diferencias pareadas (D − A con el mismo proveedor; cada proveedor
contra Gemini en el brazo D). **Regla escrita antes de medir (§5):** una
diferencia cuenta sólo si su intervalo excluye el cero, sin empeorar la
invención ni pasar el presupuesto de latencia (p90 ≤ 5 s para código y receta;
≤ 15 s para la nota). La calidad se mide sobre los casos respondidos; la
disponibilidad, aparte.

## Resultados

Cada corrida escribe `resultados/<fecha>-<etiqueta>/` (EV-7):

- `resultado.json` — proveedor y modelo, versión de cada prompt, SHA-256 de
  cada catálogo y de cada archivo de casos, fecha en America/Guayaquil,
  semilla, commit, cada llamada (id del caso y lo que se mostró, nunca el texto
  del caso) y cada intento (resultado, estado HTTP, latencia, costo; nunca
  texto);
- `informe.md` — las tablas con sus intervalos.

`resultados/ejemplo-falso/` es la corrida con el proveedor falso, de muestra.

## Fuentes

- **CodiEsp** — Miranda-Escalada A., Gonzalez-Agirre A., Armengol-Estapé J.,
  Krallinger M. *Overview of automatic clinical coding: annotations, guidelines,
  and solutions for non-English clinical cases at CodiEsp track of CLEF eHealth
  2020.* Corpus en Zenodo, registro 3837305, licencia **CC BY 4.0**. Se lee de
  su carpeta `train_dev` (`--codiesp`) y no se versiona aquí; los resultados
  guardan su SHA-256 y los códigos, no sus frases. Sus códigos (CIE-10-ES) se
  llevan a la CIE-10 OMS de 4 caracteres (`catalogue.ts::toWhoCode`); los que
  no tienen equivalente se cuentan y se dejan fuera.
- **Infraestructura** copiada y adaptada de SigmAI
  (`TESIS/PROYECTO/sigmai-api/src/batch/`: `stats.ts`, `spending-ceiling.ts`,
  `relevance-judge.ts`, `compare-providers.ts`). Sin sus datos.
- **Casos propios** escritos para el arnés por el desarrollador: el código, la
  receta y los hechos esperados deben confirmarlos un codificador, un
  farmacéutico o un médico antes de usar las cifras para decidir.
