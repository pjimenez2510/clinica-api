# Informe del arnés de evaluación — ejemplo

> **Proveedor falso.** Respuestas, latencias, errores y costos simulados con semilla: esta corrida prueba el arnés, no mide a ningún proveedor.

- Fecha: 2026-10-11 22:01:41 → 2026-10-11 22:01:49 · commit `c97301c` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `fake-gemini`, anthropic `fake-anthropic`, openai `fake-openai`
- Juez de la nota: fake `fake-judge` (juez-nota-v1), sin validar
- Prompts: cie10 A=cie10-a-v1, D=cie10-d-v1 · prescription A=receta-a-v1, D=receta-d-v1 · note D=nota-v1
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`
- Casos: cie10 45 de cie10-propios.json `e85307a4b2c6` · prescription 30 de receta.json `fa94c651e12e` · note 10 de nota.json `41ed1cabc1d5`
- CodiEsp: no se usó en esta corrida
- Techo: 100 USD al mes · gastado en esta corrida: 0.4227 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Intentos | Correctos | 503 | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] |
|---|---|---|---|---|---|---|
| gemini | 237 | 152 | 67 | 18 | 0 | 35.9 % [30.0 %; 42.2 %] |
| anthropic | 163 | 160 | 3 | 0 | 0 | 1.8 % [0.6 %; 5.3 %] |
| openai | 172 | 160 | 8 | 4 | 0 | 7.0 % [4.0 %; 11.8 %] |
| fake | 29 | 29 | 0 | 0 | 0 | 0.0 % [0.0 %; 11.7 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por caso respondido |
|---|---|---|---|---|---|---|
| CIE-10 por problema | gemini | 3.9 s | 5.6 s | 5.0 s ✗ | 0.0716 USD | 0.0008 USD |
| CIE-10 por problema | anthropic | 9.7 s | 12.7 s | 5.0 s ✗ | 0.0745 USD | 0.0008 USD |
| CIE-10 por problema | openai | 6.2 s | 8.6 s | 5.0 s ✗ | 0.0745 USD | 0.0008 USD |
| Receta dictada | gemini | 4.1 s | 5.5 s | 5.0 s ✗ | 0.0455 USD | 0.0008 USD |
| Receta dictada | anthropic | 8.4 s | 12.9 s | 5.0 s ✗ | 0.0482 USD | 0.0008 USD |
| Receta dictada | openai | 5.8 s | 8.3 s | 5.0 s ✗ | 0.0482 USD | 0.0008 USD |
| Nota de la consulta | gemini | 3.2 s | 5.2 s | 15.0 s ✓ | 0.0081 USD | 0.0009 USD |
| Nota de la consulta | anthropic | 8.4 s | 12.0 s | 15.0 s ✓ | 0.0090 USD | 0.0009 USD |
| Nota de la consulta | openai | 6.0 s | 8.5 s | 15.0 s ✓ | 0.0090 USD | 0.0009 USD |

Juez: 29 intentos, 0.0342 USD.

## CIE-10 por problema

| Proveedor | Brazo | Respondidos | Acierto@1 | R@5 | Categoría@1 (3 caracteres) | Códigos inexistentes mostrados (por caso) | Sin propuesta |
|---|---|---|---|---|---|---|---|
| gemini | A | 42/45 | 81.0 % [66.7 %; 90.0 %] n=42 | 81.0 % [66.7 %; 90.0 %] n=42 | 81.0 % [66.7 %; 90.0 %] n=42 | 7.1 % [3.2 %; 11.9 %] n=42 | 0.0 % [0.0 %; 8.4 %] n=42 |
| gemini | D | 44/45 | 93.2 % [81.8 %; 97.7 %] n=44 | 93.2 % [81.8 %; 97.7 %] n=44 | 100.0 % [92.0 %; 100.0 %] n=44 | 0.0 % [0.0 %; 0.0 %] n=44 | 0.0 % [0.0 %; 8.0 %] n=44 |
| anthropic | A | 45/45 | 75.6 % [61.3 %; 85.8 %] n=45 | 75.6 % [61.3 %; 85.8 %] n=45 | 75.6 % [61.3 %; 85.8 %] n=45 | 8.9 % [4.4 %; 13.7 %] n=45 | 0.0 % [0.0 %; 7.9 %] n=45 |
| anthropic | D | 45/45 | 82.2 % [68.7 %; 90.7 %] n=45 | 82.2 % [68.7 %; 90.7 %] n=45 | 100.0 % [92.1 %; 100.0 %] n=45 | 0.0 % [0.0 %; 0.0 %] n=45 | 0.0 % [0.0 %; 7.9 %] n=45 |
| openai | A | 45/45 | 75.6 % [61.3 %; 85.8 %] n=45 | 75.6 % [61.3 %; 85.8 %] n=45 | 75.6 % [61.3 %; 85.8 %] n=45 | 9.3 % [4.8 %; 14.4 %] n=45 | 0.0 % [0.0 %; 7.9 %] n=45 |
| openai | D | 45/45 | 84.4 % [71.2 %; 92.3 %] n=45 | 84.4 % [71.2 %; 92.3 %] n=45 | 97.8 % [88.4 %; 99.6 %] n=45 | 0.0 % [0.0 %; 0.0 %] n=45 | 0.0 % [0.0 %; 7.9 %] n=45 |

### D − A, caso por caso (mismo proveedor)

| Proveedor | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| gemini | Acierto@1 | 12.2 % [-2.4 %; 26.8 %] | 41 | no concluyente (incluye 0) |
| gemini | R@5 | 12.2 % [-2.4 %; 26.8 %] | 41 | no concluyente (incluye 0) |
| gemini | Códigos inexistentes mostrados (por caso) | -7.3 % [-12.2 %; -2.8 %] | 41 | mejor (excluye 0) |
| anthropic | Acierto@1 | 6.7 % [-8.9 %; 24.4 %] | 45 | no concluyente (incluye 0) |
| anthropic | R@5 | 6.7 % [-8.9 %; 24.4 %] | 45 | no concluyente (incluye 0) |
| anthropic | Códigos inexistentes mostrados (por caso) | -8.9 % [-13.7 %; -4.4 %] | 45 | mejor (excluye 0) |
| openai | Acierto@1 | 8.9 % [-6.7 %; 24.4 %] | 45 | no concluyente (incluye 0) |
| openai | R@5 | 8.9 % [-6.7 %; 24.4 %] | 45 | no concluyente (incluye 0) |
| openai | Códigos inexistentes mostrados (por caso) | -9.3 % [-14.4 %; -4.8 %] | 45 | mejor (excluye 0) |

### Proveedores contra gemini, brazo D, caso por caso

| Proveedor − gemini | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| anthropic | Acierto@1 | -11.4 % [-25.0 %; 2.3 %] | 44 | no concluyente (incluye 0) |
| anthropic | R@5 | -11.4 % [-25.0 %; 2.3 %] | 44 | no concluyente (incluye 0) |
| anthropic | Códigos inexistentes mostrados (por caso) | 0.0 % [0.0 %; 0.0 %] | 44 | no concluyente (incluye 0) |
| openai | Acierto@1 | -9.1 % [-22.7 %; 2.3 %] | 44 | no concluyente (incluye 0) |
| openai | R@5 | -9.1 % [-22.7 %; 2.3 %] | 44 | no concluyente (incluye 0) |
| openai | Códigos inexistentes mostrados (por caso) | 0.0 % [0.0 %; 0.0 %] | 44 | no concluyente (incluye 0) |

## Receta dictada

| Proveedor | Brazo | Respondidos | Principio activo correcta | Forma correcta | Concentración correcta | Dosis correcta | Vía correcta | Frecuencia correcta | Duración correcta | Receta completa correcta | Medicamento fuera del CNMB | Sin medicamento |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini | A | 30/30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 80.0 % [62.7 %; 90.5 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 80.0 % [62.7 %; 90.5 %] n=30 | 0.0 % [0.0 %; 11.4 %] n=30 | 0.0 % [0.0 %; 11.4 %] n=30 |
| gemini | D | 27/30 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 92.6 % [76.6 %; 97.9 %] n=27 | 0.0 % [0.0 %; 13.3 %] n=25 | 7.4 % [2.1 %; 23.4 %] n=27 |
| anthropic | A | 30/30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 93.3 % [78.7 %; 98.2 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 93.3 % [78.7 %; 98.2 %] n=30 | 93.3 % [78.7 %; 98.2 %] n=30 | 0.0 % [0.0 %; 11.4 %] n=30 | 0.0 % [0.0 %; 11.4 %] n=30 |
| anthropic | D | 30/30 | 83.3 % [66.4 %; 92.7 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 86.7 % [70.3 %; 94.7 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 83.3 % [66.4 %; 92.7 %] n=30 | 0.0 % [0.0 %; 13.3 %] n=25 | 16.7 % [7.3 %; 33.6 %] n=30 |
| openai | A | 30/30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 73.3 % [55.6 %; 85.8 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 100.0 % [88.6 %; 100.0 %] n=30 | 80.0 % [62.7 %; 90.5 %] n=30 | 73.3 % [55.6 %; 85.8 %] n=30 | 0.0 % [0.0 %; 11.4 %] n=30 | 0.0 % [0.0 %; 11.4 %] n=30 |
| openai | D | 30/30 | 90.0 % [74.4 %; 96.5 %] n=30 | 90.0 % [74.4 %; 96.5 %] n=30 | 90.0 % [74.4 %; 96.5 %] n=30 | 90.0 % [74.4 %; 96.5 %] n=30 | 90.0 % [74.4 %; 96.5 %] n=30 | 93.3 % [78.7 %; 98.2 %] n=30 | 90.0 % [74.4 %; 96.5 %] n=30 | 90.0 % [74.4 %; 96.5 %] n=30 | 0.0 % [0.0 %; 12.5 %] n=27 | 10.0 % [3.5 %; 25.6 %] n=30 |

### D − A, caso por caso (mismo proveedor)

| Proveedor | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| gemini | Concentración correcta | 11.1 % [-7.4 %; 29.6 %] | 27 | no concluyente (incluye 0) |
| gemini | Receta completa correcta | 11.1 % [-7.4 %; 29.6 %] | 27 | no concluyente (incluye 0) |
| gemini | Medicamento fuera del CNMB | 0.0 % [0.0 %; 0.0 %] | 25 | no concluyente (incluye 0) |
| anthropic | Concentración correcta | -10.0 % [-23.3 %; 3.3 %] | 30 | no concluyente (incluye 0) |
| anthropic | Receta completa correcta | -10.0 % [-23.3 %; 3.3 %] | 30 | no concluyente (incluye 0) |
| anthropic | Medicamento fuera del CNMB | 0.0 % [0.0 %; 0.0 %] | 25 | no concluyente (incluye 0) |
| openai | Concentración correcta | 16.7 % [-3.3 %; 33.3 %] | 30 | no concluyente (incluye 0) |
| openai | Receta completa correcta | 16.7 % [-3.3 %; 33.3 %] | 30 | no concluyente (incluye 0) |
| openai | Medicamento fuera del CNMB | 0.0 % [0.0 %; 0.0 %] | 27 | no concluyente (incluye 0) |

### Proveedores contra gemini, brazo D, caso por caso

| Proveedor − gemini | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| anthropic | Concentración correcta | -7.4 % [-22.2 %; 7.4 %] | 27 | no concluyente (incluye 0) |
| anthropic | Receta completa correcta | -7.4 % [-22.2 %; 7.4 %] | 27 | no concluyente (incluye 0) |
| anthropic | Medicamento fuera del CNMB | 0.0 % [0.0 %; 0.0 %] | 22 | no concluyente (incluye 0) |
| openai | Concentración correcta | -3.7 % [-18.5 %; 11.1 %] | 27 | no concluyente (incluye 0) |
| openai | Receta completa correcta | -3.7 % [-18.5 %; 11.1 %] | 27 | no concluyente (incluye 0) |
| openai | Medicamento fuera del CNMB | 0.0 % [0.0 %; 0.0 %] | 22 | no concluyente (incluye 0) |

### F1 por campo (un campo vacío es abstención: baja el recall, no la precisión)

| Proveedor | Brazo | Principio activo | Forma | Concentración | Dosis | Vía | Frecuencia | Duración |
|---|---|---|---|---|---|---|---|---|
| gemini | A | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 88.9 % (P 100.0 %, R 80.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 89.8 % (P 100.0 %, R 81.5 %) |
| gemini | D | 96.2 % (P 100.0 %, R 92.6 %) | 96.2 % (P 100.0 %, R 92.6 %) | 96.2 % (P 100.0 %, R 92.6 %) | 96.2 % (P 100.0 %, R 92.6 %) | 96.2 % (P 100.0 %, R 92.6 %) | 95.2 % (P 100.0 %, R 90.9 %) | 95.7 % (P 100.0 %, R 91.7 %) |
| anthropic | A | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 96.6 % (P 100.0 %, R 93.3 %) | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 96.2 % (P 100.0 %, R 92.6 %) |
| anthropic | D | 90.9 % (P 100.0 %, R 83.3 %) | 90.9 % (P 100.0 %, R 83.3 %) | 90.9 % (P 100.0 %, R 83.3 %) | 90.9 % (P 100.0 %, R 83.3 %) | 90.9 % (P 100.0 %, R 83.3 %) | 91.3 % (P 100.0 %, R 84.0 %) | 89.8 % (P 100.0 %, R 81.5 %) |
| openai | A | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 84.6 % (P 100.0 %, R 73.3 %) | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 100.0 % (P 100.0 %, R 100.0 %) | 87.5 % (P 100.0 %, R 77.8 %) |
| openai | D | 94.7 % (P 100.0 %, R 90.0 %) | 94.7 % (P 100.0 %, R 90.0 %) | 94.7 % (P 100.0 %, R 90.0 %) | 94.7 % (P 100.0 %, R 90.0 %) | 94.7 % (P 100.0 %, R 90.0 %) | 95.8 % (P 100.0 %, R 92.0 %) | 94.1 % (P 100.0 %, R 88.9 %) |

## Nota de la consulta

| Proveedor | Brazo | Respondidos | Secciones fuera de la plantilla (por caso) | Frases sin línea de origen (por caso) | Hechos omitidos (juez sin validar) | Frases sin respaldo (juez sin validar) | Notas juzgadas |
|---|---|---|---|---|---|---|---|
| gemini | D | 9/10 | 0.0 % [0.0 %; 0.0 %] n=9 | 1.9 % [0.0 %; 5.6 %] n=9 | 28.0 % [18.1 %; 38.1 %] n=9 | 15.9 % [10.0 %; 21.7 %] n=9 | 100.0 % [70.1 %; 100.0 %] n=9 |
| anthropic | D | 10/10 | 0.0 % [0.0 %; 0.0 %] n=10 | 1.7 % [0.0 %; 5.0 %] n=10 | 12.2 % [5.5 %; 19.4 %] n=10 | 30.5 % [24.3 %; 36.2 %] n=10 | 100.0 % [72.2 %; 100.0 %] n=10 |
| openai | D | 10/10 | 0.0 % [0.0 %; 0.0 %] n=10 | 0.0 % [0.0 %; 0.0 %] n=10 | 29.9 % [21.4 %; 39.4 %] n=10 | 28.7 % [22.1 %; 35.4 %] n=10 | 100.0 % [72.2 %; 100.0 %] n=10 |

### Proveedores contra gemini, brazo D, caso por caso

| Proveedor − gemini | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| anthropic | Frases sin línea de origen (por caso) | 0.0 % [-5.6 %; 5.6 %] | 9 | no concluyente (incluye 0) |
| anthropic | Hechos omitidos (juez sin validar) | -15.5 % [-28.8 %; -5.1 %] | 9 | mejor (excluye 0) |
| anthropic | Frases sin respaldo (juez sin validar) | 14.0 % [6.1 %; 22.5 %] | 9 | peor (excluye 0) |
| openai | Frases sin línea de origen (por caso) | -1.9 % [-5.6 %; 0.0 %] | 9 | no concluyente (incluye 0) |
| openai | Hechos omitidos (juez sin validar) | 1.2 % [-12.4 %; 15.8 %] | 9 | no concluyente (incluye 0) |
| openai | Frases sin respaldo (juez sin validar) | 14.0 % [4.3 %; 22.7 %] | 9 | peor (excluye 0) |

> **Juez sin validar.** La omisión y la invención las decide un único modelo (el juez de la cabecera) que ningún médico ha contrastado todavía; hasta medir su κ contra una submuestra revisada (PLAN-ASISTENTE-IA §5), esas dos columnas orientan y no deciden. Las secciones fuera de plantilla y las frases sin línea se cuentan sin modelo.

