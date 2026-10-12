# Informe del arnés de evaluación — d1-cie10-problema-gemini

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-11 22:56:48 → 2026-10-11 23:04:09 · commit `f9ea2611+cambios` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `gemini-3.8-flash` · sin clave, no medidos: openai
- Juez de la nota: ninguno
- Prompts: cie10-problema A=d1-codes-1, D=d1-codes-1
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: cie10-problema 45 de cie10-propios.json `e85307a4b2c6` · cie10-problema 60 de CodiEsp `a2164fc9d513`
- CodiEsp (Miranda-Escalada et al., 2020, CC BY 4.0, Zenodo 3837305): 11129 frases de diagnóstico, 1245 sin equivalente en la CIE-10 OMS, muestra de 60 · `a2164fc9d513`
- Techo: 0.5 USD al mes, contra el registro /Users/pjimenez/.clinica-eval/gasto · gastado en esta corrida: 0.0880 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 210 | 210 | 0 | 0 | 0 | 0.0 % [0.0 %; 1.8 %] | 0.0 % [0.0 %; 1.8 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| CIE-10 por problema (D1) frente a la línea base | gemini | 1.8 s | 3.1 s | 5.0 s ✓ | 0.0880 USD | 0.0004 USD |

## CIE-10 por problema (D1) frente a la línea base

| Proveedor | Brazo | Respondidos | R@5 | R@5 de la línea base | R@5 menos el de la línea base (por caso) | Acierto@1 | Categoría en las 5 (3 caracteres) | Códigos inexistentes escritos (por caso) | Códigos inexistentes mostrados (por caso) |
|---|---|---|---|---|---|---|---|---|---|
| gemini | A | 105/105 | 93.3 % [86.9 %; 96.7 %] n=105 | 5.7 % [2.6 %; 11.9 %] n=105 | 87.6 % [81.0 %; 93.3 %] n=105 | 84.8 % [76.7 %; 90.4 %] n=105 | 97.1 % [91.9 %; 99.0 %] n=105 | 1.2 % [0.2 %; 2.5 %] n=105 | 1.2 % [0.2 %; 2.5 %] n=105 |
| gemini | A · invented | 45/45 | 100.0 % [92.1 %; 100.0 %] n=45 | 0.0 % [0.0 %; 7.9 %] n=45 | 100.0 % [100.0 %; 100.0 %] n=45 | 93.3 % [82.1 %; 97.7 %] n=45 | 100.0 % [92.1 %; 100.0 %] n=45 | 2.0 % [0.0 %; 4.9 %] n=45 | 2.0 % [0.0 %; 4.9 %] n=45 |
| gemini | A · codiesp | 60/60 | 88.3 % [77.8 %; 94.2 %] n=60 | 10.0 % [4.7 %; 20.1 %] n=60 | 78.3 % [68.3 %; 88.3 %] n=60 | 78.3 % [66.4 %; 86.9 %] n=60 | 95.0 % [86.3 %; 98.3 %] n=60 | 0.6 % [0.0 %; 1.7 %] n=60 | 0.6 % [0.0 %; 1.7 %] n=60 |
| gemini | D | 105/105 | 92.4 % [85.7 %; 96.1 %] n=105 | 5.7 % [2.6 %; 11.9 %] n=105 | 86.7 % [79.0 %; 93.3 %] n=105 | 87.6 % [80.0 %; 92.6 %] n=105 | 95.2 % [89.3 %; 97.9 %] n=105 | 1.4 % [0.0 %; 3.8 %] n=104 | 0.0 % [0.0 %; 0.0 %] n=103 |
| gemini | D · invented | 45/45 | 97.8 % [88.4 %; 99.6 %] n=45 | 0.0 % [0.0 %; 7.9 %] n=45 | 97.8 % [93.3 %; 100.0 %] n=45 | 91.1 % [79.3 %; 96.5 %] n=45 | 97.8 % [88.4 %; 99.6 %] n=45 | 2.7 % [0.0 %; 7.6 %] n=45 | 0.0 % [0.0 %; 0.0 %] n=44 |
| gemini | D · codiesp | 60/60 | 88.3 % [77.8 %; 94.2 %] n=60 | 10.0 % [4.7 %; 20.1 %] n=60 | 78.3 % [66.7 %; 88.3 %] n=60 | 85.0 % [73.9 %; 91.9 %] n=60 | 93.3 % [84.1 %; 97.4 %] n=60 | 0.4 % [0.0 %; 1.3 %] n=59 | 0.0 % [0.0 %; 0.0 %] n=59 |

### D − A, caso por caso (mismo proveedor)

| Proveedor | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| gemini | R@5 | -1.0 % [-4.8 %; 2.9 %] | 105 | no concluyente (incluye 0) |
| gemini | R@5 menos el de la línea base (por caso) | -1.0 % [-4.8 %; 2.9 %] | 105 | no concluyente (incluye 0) |
| gemini | Códigos inexistentes mostrados (por caso) | -0.7 % [-1.7 %; 0.0 %] | 103 | no concluyente (incluye 0) |

> **Qué es A y qué es D aquí.** A no tiene catálogo (el modelo escribe de memoria); D recibe candidatos del catálogo y una barrera quita lo que no existe, sin corregir nada. El A del §5 ya buscaba en un catálogo plano: esta diferencia se parece más a «C − A más la barrera» que al D − A del §5. La invención cuenta lo que el modelo escribió, en los dos brazos; en D la barrera no lo muestra.

