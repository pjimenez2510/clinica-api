# Informe del arnés de evaluación — d1-cie10-problema-gemini

> Corrida real, sólo con casos inventados y de CodiEsp (D-239 §1).

- Fecha: 2026-10-11 23:23:17 → 2026-10-11 23:31:01 · commit `696981ed+cambios` · semilla 42
- Proveedores (nivel `quality`, cada uno sin respaldo): gemini `gemini-3.8-flash` · sin clave, no medidos: openai
- Juez de la nota: ninguno
- Prompts: cie10-problema A=d1-codes-2, D=d1-codes-2
- Catálogos: cie10-oms-deis-2026-08.xlsx `0d5e19d5d688`, cnmb-2026.xlsx `e968d14c9fa3`, llm-pricing.json `9af59d090989`
- Casos: cie10-problema 45 de cie10-propios.json `e85307a4b2c6` · cie10-problema 60 de CodiEsp `a2164fc9d513`
- CodiEsp (Miranda-Escalada et al., 2020, CC BY 4.0, Zenodo 3837305): 11129 frases de diagnóstico, 1245 sin equivalente en la CIE-10 OMS, muestra de 60 · `a2164fc9d513`
- Techo: 0.5 USD al mes, contra el registro /Users/pjimenez/.clinica-eval/gasto · gastado en esta corrida: 0.0979 USD

**Regla, escrita antes de medir (PLAN-ASISTENTE-IA §5):** una diferencia cuenta sólo si su intervalo de confianza del 95 % excluye el cero, sin empeorar la invención ni pasar el presupuesto de latencia. La calidad se mide sobre los casos respondidos; la disponibilidad, aparte.

## Disponibilidad (todas las peticiones, también los reintentos y el juez)

| Proveedor | Peticiones | Correctas | Sobrecarga (503/529) | 429 | Otros fallos de disponibilidad | Tasa de error [IC 95 %] | Llamadas que fallaron a la primera |
|---|---|---|---|---|---|---|---|
| gemini | 210 | 210 | 0 | 0 | 0 | 0.0 % [0.0 %; 1.8 %] | 0.0 % [0.0 %; 1.8 %] |

## Latencia y costo

| Tarea | Proveedor | Latencia p50 | p90 | Presupuesto p90 | Costo total | Costo por llamada respondida |
|---|---|---|---|---|---|---|
| CIE-10 por problema (D1) frente a la línea base | gemini | 1.8 s | 3.2 s | 5.0 s ✓ | 0.0979 USD | 0.0005 USD |

## CIE-10 por problema (D1) frente a la línea base

| Proveedor | Brazo | Respondidos | R@5 | R@5 de la línea base | R@5 menos el de la línea base (por caso) | Acierto@1 | Categoría en las 5 (3 caracteres) | Códigos inexistentes escritos (por caso) | Categoría en las 5 de la línea base (3 caracteres) |
|---|---|---|---|---|---|---|---|---|---|
| gemini | A | 105/105 | 96.2 % [90.6 %; 98.5 %] n=105 | 10.0 % [4.7 %; 20.1 %] n=60 | 83.3 % [73.3 %; 91.7 %] n=60 | 88.6 % [81.1 %; 93.3 %] n=105 | 98.1 % [93.3 %; 99.5 %] n=105 | 1.6 % [0.4 %; 3.0 %] n=105 | 11.7 % [5.8 %; 22.2 %] n=60 |
| gemini | A · invented | 45/45 | 100.0 % [92.1 %; 100.0 %] n=45 | — [—; —] n=0 | — [—; —] n=0 | 95.6 % [85.2 %; 98.8 %] n=45 | 100.0 % [92.1 %; 100.0 %] n=45 | 1.6 % [0.0 %; 4.2 %] n=45 | — [—; —] n=0 |
| gemini | A · codiesp | 60/60 | 93.3 % [84.1 %; 97.4 %] n=60 | 10.0 % [4.7 %; 20.1 %] n=60 | 83.3 % [73.3 %; 91.7 %] n=60 | 83.3 % [72.0 %; 90.7 %] n=60 | 96.7 % [88.6 %; 99.1 %] n=60 | 1.6 % [0.3 %; 3.2 %] n=60 | 11.7 % [5.8 %; 22.2 %] n=60 |
| gemini | D | 105/105 | 94.3 % [88.1 %; 97.4 %] n=105 | 10.0 % [4.7 %; 20.1 %] n=60 | 80.0 % [70.0 %; 90.0 %] n=60 | 87.6 % [80.0 %; 92.6 %] n=105 | 97.1 % [91.9 %; 99.0 %] n=105 | 2.0 % [0.5 %; 4.0 %] n=105 | 11.7 % [5.8 %; 22.2 %] n=60 |
| gemini | D · invented | 45/45 | 100.0 % [92.1 %; 100.0 %] n=45 | — [—; —] n=0 | — [—; —] n=0 | 95.6 % [85.2 %; 98.8 %] n=45 | 100.0 % [92.1 %; 100.0 %] n=45 | 1.6 % [0.0 %; 4.2 %] n=45 | — [—; —] n=0 |
| gemini | D · codiesp | 60/60 | 90.0 % [79.9 %; 95.3 %] n=60 | 10.0 % [4.7 %; 20.1 %] n=60 | 80.0 % [70.0 %; 90.0 %] n=60 | 81.7 % [70.1 %; 89.4 %] n=60 | 95.0 % [86.3 %; 98.3 %] n=60 | 2.4 % [0.3 %; 5.4 %] n=60 | 11.7 % [5.8 %; 22.2 %] n=60 |

### D − A, caso por caso (mismo proveedor)

| Proveedor | Métrica | Diferencia [IC 95 %] | Pares | Lectura |
|---|---|---|---|---|
| gemini | R@5 | -1.9 % [-4.8 %; 0.0 %] | 105 | no concluyente (incluye 0) |
| gemini | R@5 menos el de la línea base (por caso) | -3.3 % [-8.3 %; 0.0 %] | 60 | no concluyente (incluye 0) |

> **Qué es A y qué es D aquí.** A no tiene catálogo (el modelo escribe de memoria); D recibe candidatos del catálogo y una barrera quita lo que no existe, sin corregir nada. El A del §5 ya buscaba en un catálogo plano: esta diferencia se parece más a «C − A más la barrera» que al D − A del §5. La invención cuenta lo que el modelo escribió, en los dos brazos; en D la barrera no lo muestra.

