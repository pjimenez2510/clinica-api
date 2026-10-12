# Informe del arnés de evaluación — d3-examenes-gemini

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-12 14:02:44 → 2026-10-12 14:04:31 · commit `6e74a3a9` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `gemini-3.8-flash` · sin clave, no medidos: openai
- Juez de la nota: ninguno
- Prompts: examenes-nota D=d3-exams-2
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: examenes-nota 50 de examenes-notas.json `f10bb20f455e` · examenes-nota 62 de catalogo-examenes.json `e19979daac7a`
- CodiEsp: no se usó en esta corrida
- Techo: 1.24 USD al mes, contra el registro ~/.clinica-eval/gasto · gastado en esta corrida: 0.0656 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 50 | 50 | 0 | 0 | 0 | 0.0 % [0.0 %; 7.1 %] | 0.0 % [0.0 %; 7.1 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| Exámenes propuestos desde la nota y la conversación (D3) | gemini | 1.9 s | 2.6 s | 5.0 s ✓ | 0.0656 USD | 0.0013 USD |

## Exámenes propuestos desde la nota y la conversación (D3)

| Proveedor | Brazo | Respondidos | Exámenes pedidos con el correcto entre los candidatos | Exámenes pedidos con el correcto en primer lugar | Orden entera cubierta, sin líneas de más | Líneas con candidatos que nadie pidió (por caso) | Exámenes fuera del catálogo mostrados (por caso) |
|---|---|---|---|---|---|---|---|
| gemini | D | 50/50 | 97.8 % [93.3 %; 100.0 %] n=45 | 97.8 % [93.3 %; 100.0 %] n=45 | 98.0 % [89.5 %; 99.6 %] n=50 | 0.0 % [0.0 %; 0.0 %] n=50 | 0.0 % [0.0 %; 0.0 %] n=50 |

