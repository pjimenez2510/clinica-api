# Informe del arnés de evaluación — ajustes-medico-gemini

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-13 10:15:17 → 2026-10-13 10:16:34 · commit `39e81a75` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `gemini-3.8-flash` · sin clave, no medidos: anthropic, openai
- Juez de la nota: ninguno
- Prompts: receta-campos D=d2-lines-1+d2-mapping-1 · sintomas D=d1-problems-3+d1-codes-2 · ficha D=chart-1
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: receta-campos 7 de receta-campos.json `ec13e7c724ef` · sintomas 4 de sintomas.json `836eb2659744` · ficha 8 de ficha.json `70a4ea9c24d4`
- CodiEsp: no se usó en esta corrida
- Techo: 100 USD al mes, contra el registro ~/.clinica-eval/gasto · gastado en esta corrida: 0.0260 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 30 | 30 | 0 | 0 | 0 | 0.0 % [0.0 %; 11.4 %] | 0.0 % [0.0 %; 16.8 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| Receta completa desde la nota, campo por campo (SC-102) | gemini | 5.1 s | 6.8 s | 5.0 s ✗ | 0.0161 USD | 0.0023 USD |
| Sin códigos de síntoma junto a un diagnóstico (SC-103) | gemini | 4.4 s | 5.7 s | 5.0 s ✗ | 0.0031 USD | 0.0008 USD |
| Alergias y antecedentes dichos, propuestos como registro (SC-104) | gemini | 2.3 s | 2.9 s | 5.0 s ✓ | 0.0068 USD | 0.0009 USD |

## Receta completa desde la nota, campo por campo (SC-102)

| Proveedor | Brazo | Respondidos | Campos dichos o deducibles llenos y correctos | Campos llenos con otro valor o en una línea de más (por caso) | Campos deducidos sin la marca «Nadie lo dijo» (por caso) |
|---|---|---|---|---|---|
| gemini | D | 7/7 | 91.1 % [76.8 %; 100.0 %] n=7 | 14.3 % [0.0 %; 42.9 %] n=7 | 0.0 % [0.0 %; 0.0 %] n=7 |

## Sin códigos de síntoma junto a un diagnóstico (SC-103)

| Proveedor | Brazo | Respondidos | Códigos R00–R99 mostrados junto a un diagnóstico (por caso) | El diagnóstico entre los códigos mostrados | Síntomas que el modelo nombró como problema (por caso, antes de la barrera) |
|---|---|---|---|---|---|
| gemini | D | 4/4 | 0.0 % [0.0 %; 0.0 %] n=4 | 100.0 % [51.0 %; 100.0 %] n=4 | 0.0 % [0.0 %; 0.0 %] n=4 |

## Alergias y antecedentes dichos, propuestos como registro (SC-104)

| Proveedor | Brazo | Respondidos | Alergias y antecedentes dichos, propuestos con su línea | Propuestos que no se dijeron (por caso) |
|---|---|---|---|---|
| gemini | D | 8/8 | 91.7 % [75.0 %; 100.0 %] n=6 | 0.0 % [0.0 %; 0.0 %] n=8 |

