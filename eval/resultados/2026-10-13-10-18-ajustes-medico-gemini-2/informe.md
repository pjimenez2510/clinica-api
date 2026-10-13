# Informe del arnés de evaluación — ajustes-medico-gemini-2

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-13 10:18:00 → 2026-10-13 10:22:30 · commit `bf9d1a6c+cambios` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `gemini-3.8-flash` · sin clave, no medidos: anthropic, openai
- Juez de la nota: ninguno
- Prompts: receta-nota D=d2-lines-2+d2-mapping-1 · receta-campos D=d2-lines-2+d2-mapping-1 · ficha D=chart-2
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: receta-nota 40 de receta-notas.json `5a905d504a6b` · receta-campos 7 de receta-campos.json `ec13e7c724ef` · ficha 8 de ficha.json `70a4ea9c24d4`
- CodiEsp: no se usó en esta corrida
- Techo: 100 USD al mes, contra el registro ~/.clinica-eval/gasto · gastado en esta corrida: 0.1037 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 101 | 101 | 0 | 0 | 0 | 0.0 % [0.0 %; 3.7 %] | 0.0 % [0.0 %; 6.5 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| Receta propuesta desde la nota (D2) | gemini | 5.1 s | 6.6 s | 5.0 s ✗ | 0.0800 USD | 0.0020 USD |
| Receta completa desde la nota, campo por campo (SC-102) | gemini | 5.7 s | 8.1 s | 5.0 s ✗ | 0.0169 USD | 0.0024 USD |
| Alergias y antecedentes dichos, propuestos como registro (SC-104) | gemini | 2.1 s | 3.0 s | 5.0 s ✓ | 0.0067 USD | 0.0008 USD |

## Receta propuesta desde la nota (D2)

| Proveedor | Brazo | Respondidos | Líneas con el medicamento y la presentación correctos | Líneas con el medicamento correcto | Receta entera correcta | Medicamentos mostrados que la nota no receta (por caso) | Medicamentos fuera del CNMB mostrados (por caso) |
|---|---|---|---|---|---|---|---|
| gemini | D | 40/40 | 94.9 % [87.2 %; 100.0 %] n=39 | 100.0 % [100.0 %; 100.0 %] n=39 | 95.0 % [83.5 %; 98.6 %] n=40 | 0.0 % [0.0 %; 0.0 %] n=40 | 0.0 % [0.0 %; 0.0 %] n=40 |

## Receta completa desde la nota, campo por campo (SC-102)

| Proveedor | Brazo | Respondidos | Campos dichos o deducibles llenos y correctos | Campos llenos con otro valor o en una línea de más (por caso) | Campos deducidos sin la marca «Nadie lo dijo» (por caso) |
|---|---|---|---|---|---|
| gemini | D | 7/7 | 92.9 % [78.6 %; 100.0 %] n=7 | 0.0 % [0.0 %; 0.0 %] n=7 | 0.0 % [0.0 %; 0.0 %] n=7 |

## Alergias y antecedentes dichos, propuestos como registro (SC-104)

| Proveedor | Brazo | Respondidos | Alergias y antecedentes dichos, propuestos con su línea | Propuestos que no se dijeron (por caso) |
|---|---|---|---|---|
| gemini | D | 8/8 | 100.0 % [100.0 %; 100.0 %] n=6 | 0.0 % [0.0 %; 0.0 %] n=8 |

