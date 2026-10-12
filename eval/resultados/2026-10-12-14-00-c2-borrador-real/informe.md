# Informe del arnés de evaluación — c2-borrador-real

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-12 14:00:45 → 2026-10-12 14:01:57 · commit `690fec01` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `gemini-3.8-flash` · sin clave, no medidos: openai
- Juez de la nota: anthropic `claude-sonnet-5` (juez-nota-v1), sin validar
- Prompts: draft D=c2-draft-2
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: draft 10 de nota.json `41ed1cabc1d5`
- CodiEsp: no se usó en esta corrida
- Techo: 100 USD al mes, contra el registro ~/.clinica-eval/gasto · gastado en esta corrida: 0.0797 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 10 | 10 | 0 | 0 | 0 | 0.0 % [0.0 %; 27.8 %] | 0.0 % [0.0 %; 27.8 %] |
| juez (anthropic) | 10 | 10 | 0 | 0 | 0 | 0.0 % [0.0 %; 27.8 %] | — |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| Borrador de la nota (C2) | gemini | 4.0 s | 5.2 s | 15.0 s ✓ | 0.0222 USD | 0.0022 USD |

Juez: 10 intentos, 0.0575 USD.

## Borrador de la nota (C2)

| Proveedor | Brazo | Respondidos | Con alguna sección inventada (todas sus frases «Nadie lo dijo») | Hechos esperados presentes (juez sin validar) | Frases «Nadie lo dijo» (por caso) | Borradores juzgados |
|---|---|---|---|---|---|---|
| gemini | D | 10/10 | 0.0 % [0.0 %; 27.8 %] n=10 | 94.3 % [88.6 %; 98.9 %] n=10 | 0.0 % [0.0 %; 0.0 %] n=10 | 100.0 % [72.2 %; 100.0 %] n=10 |

