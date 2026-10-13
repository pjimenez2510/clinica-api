# Signos dictados — b2-signos-dictados-desarrollo

- **Fecha:** 2026-10-12 23:58:19 (America/Guayaquil) · **Commit:** `148b2237+cambios`
- **Set:** desarrollo
- **Casos:** 40 frases inventadas (`signos-dictados.json`, SHA-256 `f76dfcf723b96dc0…`)
- **Lo oído:** (SHA-256 `df245f914adde9b9…`), voces sintéticas de macOS (Paulina, Eddy (Español (México)), Flo (Español (México)), Mónica), a su velocidad y a 220 palabras por minuto, sin ruido, transcritas por `clinica-ai` (whisper + VAD) en esta máquina.
- **Lectura medida:** `readDictatedVitals`, de `src/modules/assistant/domain/dictated-vitals.ts`, la misma de la ruta. Ningún proveedor de modelo.

## Criterios (escritos antes de medir)

- **SC-095** — oído sin ruido: ≥ 93,0 % de los valores esperados correctos → ✅ cumple
- **SC-096** — 0 graves (valor distinto del dicho o inventado) en los dos brazos → ❌ no cumple

## Por brazo

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| Texto escrito | 117 | 117 | 100,0 % | 96,8 % – 100,0 % | 0 | 0 | 0 de 203 | **0** |
| Oído (sin ruido) | 936 | 883 | 94,3 % | 92,7 % – 95,6 % | 4 | 49 | 0 de 1624 | **4** |

## Oído, por voz

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| Paulina | 117 | 109 | 93,2 % | 87,1 % – 96,5 % | 0 | 8 | 0 de 203 | **0** |
| Paulina · 220 | 117 | 109 | 93,2 % | 87,1 % – 96,5 % | 0 | 8 | 0 de 203 | **0** |
| Eddy (Español (México)) | 117 | 109 | 93,2 % | 87,1 % – 96,5 % | 1 | 7 | 0 de 203 | **1** |
| Eddy (Español (México)) · 220 | 117 | 111 | 94,9 % | 89,3 % – 97,6 % | 0 | 6 | 0 de 203 | **0** |
| Flo (Español (México)) | 117 | 108 | 92,3 % | 86,0 % – 95,9 % | 1 | 8 | 0 de 203 | **1** |
| Flo (Español (México)) · 220 | 117 | 107 | 91,5 % | 85,0 % – 95,3 % | 2 | 8 | 0 de 203 | **2** |
| Mónica | 117 | 115 | 98,3 % | 94,0 % – 99,5 % | 0 | 2 | 0 de 203 | **0** |
| Mónica · 220 | 117 | 115 | 98,3 % | 94,0 % – 99,5 % | 0 | 2 | 0 de 203 | **0** |

## Oído, por signo

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| Sistólica | 128 | 122 | 95,3 % | 90,2 % – 97,8 % | 0 | 6 | 0 de 192 | **0** |
| Diastólica | 128 | 122 | 95,3 % | 90,2 % – 97,8 % | 0 | 6 | 0 de 192 | **0** |
| Frecuencia cardiaca | 144 | 139 | 96,5 % | 92,1 % – 98,5 % | 1 | 4 | 0 de 176 | **1** |
| Frecuencia respiratoria | 48 | 46 | 95,8 % | 86,0 % – 98,8 % | 2 | 0 | 0 de 272 | **2** |
| Temperatura | 96 | 92 | 95,8 % | 89,8 % – 98,4 % | 0 | 4 | 0 de 224 | **0** |
| Saturación | 120 | 115 | 95,8 % | 90,6 % – 98,2 % | 0 | 5 | 0 de 200 | **0** |
| Peso | 152 | 136 | 89,5 % | 83,6 % – 93,4 % | 0 | 16 | 0 de 168 | **0** |
| Talla | 120 | 111 | 92,5 % | 86,4 % – 96,0 % | 1 | 8 | 0 de 200 | **1** |

## Oído, por tipo de frase

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| completa-palabras | 232 | 232 | 100,0 % | 98,4 % – 100,0 % | 0 | 0 | 0 de 24 | **0** |
| completa-cifras | 224 | 191 | 85,3 % | 80,0 % – 89,3 % | 2 | 31 | 0 de 32 | **2** |
| orden-parcial | 88 | 77 | 87,5 % | 79,0 % – 92,9 % | 0 | 11 | 0 de 168 | **0** |
| presion | 72 | 72 | 100,0 % | 94,9 % – 100,0 % | 0 | 0 | 0 de 184 | **0** |
| talla | 48 | 45 | 93,8 % | 83,2 % – 97,9 % | 1 | 2 | 0 de 144 | **1** |
| saturacion | 40 | 40 | 100,0 % | 91,2 % – 100,0 % | 0 | 0 | 0 de 152 | **0** |
| fr-fc | 56 | 55 | 98,2 % | 90,6 % – 99,7 % | 1 | 0 | 0 de 136 | **1** |
| temperatura | 32 | 32 | 100,0 % | 89,3 % – 100,0 % | 0 | 0 | 0 de 160 | **0** |
| peso | 24 | 23 | 95,8 % | 79,8 % – 99,3 % | 0 | 1 | 0 de 168 | **0** |
| correccion | 40 | 36 | 90,0 % | 76,9 % – 96,0 % | 0 | 4 | 0 de 152 | **0** |
| dudoso | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 120 | **0** |
| imposible | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 120 | **0** |
| largo | 64 | 64 | 100,0 % | 94,3 % – 100,0 % | 0 | 0 | 0 de 64 | **0** |

## Texto escrito, por tipo de frase

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| completa-palabras | 29 | 29 | 100,0 % | 88,3 % – 100,0 % | 0 | 0 | 0 de 3 | **0** |
| completa-cifras | 28 | 28 | 100,0 % | 87,9 % – 100,0 % | 0 | 0 | 0 de 4 | **0** |
| orden-parcial | 11 | 11 | 100,0 % | 74,1 % – 100,0 % | 0 | 0 | 0 de 21 | **0** |
| presion | 9 | 9 | 100,0 % | 70,1 % – 100,0 % | 0 | 0 | 0 de 23 | **0** |
| talla | 6 | 6 | 100,0 % | 61,0 % – 100,0 % | 0 | 0 | 0 de 18 | **0** |
| saturacion | 5 | 5 | 100,0 % | 56,6 % – 100,0 % | 0 | 0 | 0 de 19 | **0** |
| fr-fc | 7 | 7 | 100,0 % | 64,6 % – 100,0 % | 0 | 0 | 0 de 17 | **0** |
| temperatura | 4 | 4 | 100,0 % | 51,0 % – 100,0 % | 0 | 0 | 0 de 20 | **0** |
| peso | 3 | 3 | 100,0 % | 43,9 % – 100,0 % | 0 | 0 | 0 de 21 | **0** |
| correccion | 5 | 5 | 100,0 % | 56,6 % – 100,0 % | 0 | 0 | 0 de 19 | **0** |
| dudoso | 1 | 1 | 100,0 % | 20,7 % – 100,0 % | 0 | 0 | 0 de 15 | **0** |
| imposible | 1 | 1 | 100,0 % | 20,7 % – 100,0 % | 0 | 0 | 0 de 15 | **0** |
| largo | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 8 | **0** |

## Graves

- **C03** · oido · Flo (Español (México)) · Frecuencia respiratoria: esperado 22, leído 20 — «presión 142 sobre 94, frecuencia 102, frecuencia respiratoria 20, saturación 91, temperatura 38,4, peso 88, talla 1,77.»
- **C03** · oido · Flo (Español (México)) · 220 · Frecuencia respiratoria: esperado 22, leído 20 — «Presión 142 sobre 94, frecuencia 102, frecuencia respiratoria 20, saturación 91, temperatura 38,4, peso 88, talla 1,77.»
- **T03** · oido · Eddy (Español (México)) · Talla: esperado 180, leído 80 — «estatura en ochenta, peso ochenta y nueve.»
- **R01** · oido · Flo (Español (México)) · 220 · Frecuencia cardiaca: esperado 70, leído 60 — «Frecuencia respiratoria 16, frecuencia cardíaca 60.»

## Lo que no mide

Voz sintética, sin micrófono, sin la cancelación de eco del navegador y sin ruido de sala (E-055: con ruido rosa de 10 dB aparecieron graves). No mide cuánto tarda ni cuántas veces se corrige lo dictado (D-255 §5).
