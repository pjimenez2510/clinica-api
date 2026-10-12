# Informe del arnés de evaluación — d2-receta-nota-sonnet

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-12 08:27:05 → 2026-10-12 08:28:31 · commit `ea47e57f+cambios` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): anthropic `claude-sonnet-5` · sin clave, no medidos: openai
- Juez de la nota: ninguno
- Prompts: receta-nota D=d2-lines-1+d2-mapping-1
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: receta-nota 20 de receta-notas.json `5a905d504a6b`
- CodiEsp: no se usó en esta corrida
- Techo: 0.94 USD al mes, contra el registro /Users/pjimenez/.clinica-eval/gasto · gastado en esta corrida: 0.2169 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| anthropic | 20 | 20 | 0 | 0 | 0 | 0.0 % [0.0 %; 16.1 %] | 0.0 % [0.0 %; 16.1 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| Receta propuesta desde la nota (D2) | anthropic | 2.5 s | 3.5 s | 5.0 s ✓ | 0.1705 USD | 0.0085 USD |

## Receta propuesta desde la nota (D2)

| Proveedor | Brazo | Respondidos | Líneas con el medicamento y la presentación correctos | Líneas con el medicamento correcto | Receta entera correcta | Medicamentos mostrados que la nota no receta (por caso) | Medicamentos fuera del CNMB mostrados (por caso) |
|---|---|---|---|---|---|---|---|
| anthropic | D | 20/20 | 100.0 % [100.0 %; 100.0 %] n=20 | 100.0 % [100.0 %; 100.0 %] n=20 | 100.0 % [83.9 %; 100.0 %] n=20 | 0.0 % [0.0 %; 0.0 %] n=20 | 0.0 % [0.0 %; 0.0 %] n=20 |

