# Informe del arnés de evaluación — d3-examenes-sonnet-final

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-12 14:07:23 → 2026-10-12 14:08:00 · commit `5bd13c59+cambios` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): anthropic `claude-sonnet-5` · sin clave, no medidos: openai
- Juez de la nota: ninguno
- Prompts: examenes-nota D=d3-exams-2
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: examenes-nota 20 de examenes-notas.json `f10bb20f455e` · examenes-nota 62 de catalogo-examenes.json `e19979daac7a`
- CodiEsp: no se usó en esta corrida
- Techo: 1.42 USD al mes, contra el registro ~/.clinica-eval/gasto · gastado en esta corrida: 0.1202 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| anthropic | 20 | 20 | 0 | 0 | 0 | 0.0 % [0.0 %; 16.1 %] | 0.0 % [0.0 %; 16.1 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| Exámenes propuestos desde la nota y la conversación (D3) | anthropic | 1.8 s | 2.2 s | 5.0 s ✓ | 0.1202 USD | 0.0060 USD |

## Exámenes propuestos desde la nota y la conversación (D3)

| Proveedor | Brazo | Respondidos | Exámenes pedidos con el correcto entre los candidatos | Exámenes pedidos con el correcto en primer lugar | Orden entera cubierta, sin líneas de más | Líneas con candidatos que nadie pidió (por caso) | Exámenes fuera del catálogo mostrados (por caso) |
|---|---|---|---|---|---|---|---|
| anthropic | D | 20/20 | 100.0 % [100.0 %; 100.0 %] n=18 | 100.0 % [100.0 %; 100.0 %] n=18 | 100.0 % [83.9 %; 100.0 %] n=20 | 0.0 % [0.0 %; 0.0 %] n=20 | 0.0 % [0.0 %; 0.0 %] n=20 |

