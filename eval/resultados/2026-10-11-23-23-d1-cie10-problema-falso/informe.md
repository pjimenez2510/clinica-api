# Informe del arnés de evaluación — d1-cie10-problema-falso

> **Proveedor falso.** Respuestas, latencias, errores y costos simulados con semilla: esta corrida prueba el arnés, no mide a ningún proveedor.

- Fecha: 2026-10-11 23:23:15 → 2026-10-11 23:23:16 · commit `696981ed+cambios` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `fake-gemini`, anthropic `fake-anthropic`, openai `fake-openai`
- Juez de la nota: ninguno
- Prompts: cie10-problema A=d1-codes-2, D=d1-codes-2
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: cie10-problema 45 de cie10-propios.json `e85307a4b2c6`
- CodiEsp: no se usó en esta corrida
- Techo: 100 USD al mes, contra el registro propio de la corrida falsa · gastado en esta corrida: 0.2080 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 130 | 86 | 35 | 9 | 0 | 33.8 % [26.3 %; 42.3 %] | 31.1 % [22.5 %; 41.3 %] |
| anthropic | 93 | 90 | 3 | 0 | 0 | 3.2 % [1.1 %; 9.1 %] | 3.3 % [1.1 %; 9.3 %] |
| openai | 98 | 90 | 5 | 3 | 0 | 8.2 % [4.2 %; 15.3 %] | 7.8 % [3.8 %; 15.2 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| CIE-10 por problema (D1) frente a la línea base | gemini | 3.9 s | 5.6 s | 5.0 s ✗ | 0.0672 USD | 0.0008 USD |
| CIE-10 por problema (D1) frente a la línea base | anthropic | 9.7 s | 12.7 s | 5.0 s ✗ | 0.0704 USD | 0.0008 USD |
| CIE-10 por problema (D1) frente a la línea base | openai | 6.2 s | 8.6 s | 5.0 s ✗ | 0.0704 USD | 0.0008 USD |

## CIE-10 por problema (D1) frente a la línea base

| Proveedor | Brazo | Respondidos | R@5 | R@5 de la línea base | R@5 menos el de la línea base (por caso) | Acierto@1 | Categoría en las 5 (3 caracteres) | Códigos inexistentes escritos (por caso) | Categoría en las 5 de la línea base (3 caracteres) |
|---|---|---|---|---|---|---|---|---|---|
| gemini | A | 42/45 | 81.0 % [66.7 %; 90.0 %] n=42 | — [—; —] n=0 | — [—; —] n=0 | 81.0 % [66.7 %; 90.0 %] n=42 | 95.2 % [84.2 %; 98.7 %] n=42 | 7.1 % [3.2 %; 11.9 %] n=42 | — [—; —] n=0 |
| gemini | D | 44/45 | 93.2 % [81.8 %; 97.7 %] n=44 | — [—; —] n=0 | — [—; —] n=0 | 93.2 % [81.8 %; 97.7 %] n=44 | 100.0 % [92.0 %; 100.0 %] n=44 | 0.0 % [0.0 %; 0.0 %] n=44 | — [—; —] n=0 |
| anthropic | A | 45/45 | 75.6 % [61.3 %; 85.8 %] n=45 | — [—; —] n=0 | — [—; —] n=0 | 75.6 % [61.3 %; 85.8 %] n=45 | 95.6 % [85.2 %; 98.8 %] n=45 | 8.9 % [4.4 %; 13.7 %] n=45 | — [—; —] n=0 |
| anthropic | D | 45/45 | 82.2 % [68.7 %; 90.7 %] n=45 | — [—; —] n=0 | — [—; —] n=0 | 82.2 % [68.7 %; 90.7 %] n=45 | 100.0 % [92.1 %; 100.0 %] n=45 | 0.0 % [0.0 %; 0.0 %] n=45 | — [—; —] n=0 |
| openai | A | 45/45 | 75.6 % [61.3 %; 85.8 %] n=45 | — [—; —] n=0 | — [—; —] n=0 | 75.6 % [61.3 %; 85.8 %] n=45 | 93.3 % [82.1 %; 97.7 %] n=45 | 9.3 % [4.8 %; 14.4 %] n=45 | — [—; —] n=0 |
| openai | D | 45/45 | 84.4 % [71.2 %; 92.3 %] n=45 | — [—; —] n=0 | — [—; —] n=0 | 84.4 % [71.2 %; 92.3 %] n=45 | 97.8 % [88.4 %; 99.6 %] n=45 | 0.0 % [0.0 %; 0.0 %] n=45 | — [—; —] n=0 |

### D − A, caso por caso (mismo proveedor)

| Proveedor | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| gemini | R@5 | 12.2 % [-2.4 %; 26.8 %] | 41 | no concluyente (incluye 0) |
| gemini | R@5 menos el de la línea base (por caso) | — [—; —] | 0 | sin pares |
| anthropic | R@5 | 6.7 % [-8.9 %; 24.4 %] | 45 | no concluyente (incluye 0) |
| anthropic | R@5 menos el de la línea base (por caso) | — [—; —] | 0 | sin pares |
| openai | R@5 | 8.9 % [-6.7 %; 24.4 %] | 45 | no concluyente (incluye 0) |
| openai | R@5 menos el de la línea base (por caso) | — [—; —] | 0 | sin pares |

### Proveedores contra gemini, brazo D, caso por caso

| Proveedor − gemini | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| anthropic | R@5 | -11.4 % [-25.0 %; 2.3 %] | 44 | no concluyente (incluye 0) |
| anthropic | R@5 menos el de la línea base (por caso) | — [—; —] | 0 | sin pares |
| openai | R@5 | -9.1 % [-22.7 %; 2.3 %] | 44 | no concluyente (incluye 0) |
| openai | R@5 menos el de la línea base (por caso) | — [—; —] | 0 | sin pares |

> **Qué es A y qué es D aquí.** A no tiene catálogo (el modelo escribe de memoria); D recibe candidatos del catálogo y una barrera quita lo que no existe, sin corregir nada. El A del §5 ya buscaba en un catálogo plano: esta diferencia se parece más a «C − A más la barrera» que al D − A del §5. La invención cuenta lo que el modelo escribió, en los dos brazos; en D la barrera no lo muestra.

