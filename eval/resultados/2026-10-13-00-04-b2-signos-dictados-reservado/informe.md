# Signos dictados — b2-signos-dictados-reservado

- **Fecha:** 2026-10-13 00:04:54 (America/Guayaquil) · **Commit:** `148b2237+cambios`
- **Set:** reservado
- **Casos:** 30 frases inventadas (`signos-dictados-reservado.json`, SHA-256 `7ebddcad4f8db5f8…`)
- **Lo oído:** (SHA-256 `5484a2db293cacf3…`), voces sintéticas de macOS (Paulina, Eddy (Español (México)), Flo (Español (México)), Mónica), a su velocidad y a 220 palabras por minuto, sin ruido, transcritas por `clinica-ai` (whisper + VAD) en esta máquina.
- **Lectura medida:** `readDictatedVitals`, de `src/modules/assistant/domain/dictated-vitals.ts`, la misma de la ruta. Ningún proveedor de modelo.

## Criterios (escritos antes de medir)

- **SC-095** — oído sin ruido: ≥ 93,0 % de los valores esperados correctos → ✅ cumple
- **SC-096** — 0 graves (valor distinto del dicho o inventado) en los dos brazos → ❌ no cumple

## Por brazo

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| Texto escrito | 92 | 92 | 100,0 % | 96,0 % – 100,0 % | 0 | 0 | 0 de 148 | **0** |
| Oído (sin ruido) | 736 | 707 | 96,1 % | 94,4 % – 97,2 % | 2 | 27 | 0 de 1184 | **2** |

## Oído, por voz

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| Paulina | 92 | 86 | 93,5 % | 86,5 % – 97,0 % | 0 | 6 | 0 de 148 | **0** |
| Paulina · 220 | 92 | 86 | 93,5 % | 86,5 % – 97,0 % | 0 | 6 | 0 de 148 | **0** |
| Eddy (Español (México)) | 92 | 90 | 97,8 % | 92,4 % – 99,4 % | 0 | 2 | 0 de 148 | **0** |
| Eddy (Español (México)) · 220 | 92 | 88 | 95,7 % | 89,3 % – 98,3 % | 0 | 4 | 0 de 148 | **0** |
| Flo (Español (México)) | 92 | 89 | 96,7 % | 90,8 % – 98,9 % | 1 | 2 | 0 de 148 | **1** |
| Flo (Español (México)) · 220 | 92 | 88 | 95,7 % | 89,3 % – 98,3 % | 1 | 3 | 0 de 148 | **1** |
| Mónica | 92 | 90 | 97,8 % | 92,4 % – 99,4 % | 0 | 2 | 0 de 148 | **0** |
| Mónica · 220 | 92 | 90 | 97,8 % | 92,4 % – 99,4 % | 0 | 2 | 0 de 148 | **0** |

## Oído, por signo

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| Sistólica | 104 | 96 | 92,3 % | 85,6 % – 96,1 % | 2 | 6 | 0 de 136 | **2** |
| Diastólica | 104 | 98 | 94,2 % | 88,0 % – 97,3 % | 0 | 6 | 0 de 136 | **0** |
| Frecuencia cardiaca | 112 | 112 | 100,0 % | 96,7 % – 100,0 % | 0 | 0 | 0 de 128 | **0** |
| Frecuencia respiratoria | 40 | 40 | 100,0 % | 91,2 % – 100,0 % | 0 | 0 | 0 de 200 | **0** |
| Temperatura | 80 | 78 | 97,5 % | 91,3 % – 99,3 % | 0 | 2 | 0 de 160 | **0** |
| Saturación | 104 | 99 | 95,2 % | 89,2 % – 97,9 % | 0 | 5 | 0 de 136 | **0** |
| Peso | 104 | 97 | 93,3 % | 86,8 % – 96,7 % | 0 | 7 | 0 de 136 | **0** |
| Talla | 88 | 87 | 98,9 % | 93,8 % – 99,8 % | 0 | 1 | 0 de 152 | **0** |

## Oído, por tipo de frase

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| completa-palabras | 232 | 230 | 99,1 % | 96,9 % – 99,8 % | 2 | 0 | 0 de 24 | **2** |
| completa-cifras | 168 | 144 | 85,7 % | 79,6 % – 90,2 % | 0 | 24 | 0 de 24 | **0** |
| orden-parcial | 64 | 64 | 100,0 % | 94,3 % – 100,0 % | 0 | 0 | 0 de 128 | **0** |
| presion | 48 | 48 | 100,0 % | 92,6 % – 100,0 % | 0 | 0 | 0 de 144 | **0** |
| talla | 32 | 32 | 100,0 % | 89,3 % – 100,0 % | 0 | 0 | 0 de 96 | **0** |
| saturacion | 24 | 23 | 95,8 % | 79,8 % – 99,3 % | 0 | 1 | 0 de 104 | **0** |
| fr-fc | 32 | 32 | 100,0 % | 89,3 % – 100,0 % | 0 | 0 | 0 de 96 | **0** |
| temperatura | 16 | 16 | 100,0 % | 80,6 % – 100,0 % | 0 | 0 | 0 de 112 | **0** |
| peso | 16 | 16 | 100,0 % | 80,6 % – 100,0 % | 0 | 0 | 0 de 112 | **0** |
| correccion | 24 | 24 | 100,0 % | 86,2 % – 100,0 % | 0 | 0 | 0 de 104 | **0** |
| dudoso | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 120 | **0** |
| imposible | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 56 | **0** |
| largo | 64 | 62 | 96,9 % | 89,3 % – 99,1 % | 0 | 2 | 0 de 64 | **0** |

## Texto escrito, por tipo de frase

| | esperados | correctos | % | IC 95 % (Wilson) | mal | vacíos | inventados | graves |
|---|---|---|---|---|---|---|---|---|
| completa-palabras | 29 | 29 | 100,0 % | 88,3 % – 100,0 % | 0 | 0 | 0 de 3 | **0** |
| completa-cifras | 21 | 21 | 100,0 % | 84,5 % – 100,0 % | 0 | 0 | 0 de 3 | **0** |
| orden-parcial | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 16 | **0** |
| presion | 6 | 6 | 100,0 % | 61,0 % – 100,0 % | 0 | 0 | 0 de 18 | **0** |
| talla | 4 | 4 | 100,0 % | 51,0 % – 100,0 % | 0 | 0 | 0 de 12 | **0** |
| saturacion | 3 | 3 | 100,0 % | 43,9 % – 100,0 % | 0 | 0 | 0 de 13 | **0** |
| fr-fc | 4 | 4 | 100,0 % | 51,0 % – 100,0 % | 0 | 0 | 0 de 12 | **0** |
| temperatura | 2 | 2 | 100,0 % | 34,2 % – 100,0 % | 0 | 0 | 0 de 14 | **0** |
| peso | 2 | 2 | 100,0 % | 34,2 % – 100,0 % | 0 | 0 | 0 de 14 | **0** |
| correccion | 3 | 3 | 100,0 % | 43,9 % – 100,0 % | 0 | 0 | 0 de 13 | **0** |
| dudoso | 1 | 1 | 100,0 % | 20,7 % – 100,0 % | 0 | 0 | 0 de 15 | **0** |
| imposible | 1 | 1 | 100,0 % | 20,7 % – 100,0 % | 0 | 0 | 0 de 7 | **0** |
| largo | 8 | 8 | 100,0 % | 67,6 % – 100,0 % | 0 | 0 | 0 de 8 | **0** |

## Graves

- **V30** · oido · Flo (Español (México)) · Sistólica: esperado 141, leído 140
- **V30** · oido · Flo (Español (México)) · 220 · Sistólica: esperado 141, leído 140

Del set reservado no se copian frases: sólo cifras.

## Lo que no mide

Voz sintética, sin micrófono, sin la cancelación de eco del navegador y sin ruido de sala (E-055: con ruido rosa de 10 dB aparecieron graves). No mide cuánto tarda ni cuántas veces se corrige lo dictado (D-255 §5).
