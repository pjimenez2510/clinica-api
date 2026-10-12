# SPEC — Módulo `assistant`

**Estado:** borrador · **Fecha:** 11 de octubre de 2026
**Fase:** Asistente de IA, fase A · **Formato:** EARS, según ADR-010

El asistente propone y el médico acepta, corrige o descarta
(`clinica-docs/PLAN-ASISTENTE-IA.md`). Este módulo es la única puerta por la
que el sistema habla con un proveedor de modelos de lenguaje. Esta primera
entrega (A4) construye esa puerta y no muestra nada al médico: el puerto
`LlmClient`, los adaptadores de Gemini, Anthropic y OpenAI, el enrutado con
respaldo que decidió el autor en **D-239 §5**, el registro de cada llamada en
`ai_run` y el techo de gasto. Se copia y adapta de SigmAI
(`TESIS/PROYECTO/sigmai-api/src/core/llm`, `infrastructure/llm`), que midió lo
que aquí se toma.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee**:

- el puerto `LlmClient` y el tipo `PseudonymizedText`, único tipo de texto
  clínico que el puerto admite (P4 del plan);
- los adaptadores de Gemini, Anthropic y OpenAI, y el **proveedor falso** con
  que se prueban;
- la cadena de respaldo y la tabla de modelos por nivel (`model-routing.ts`);
- la tabla de precios versionada (`llm-pricing.json`) y el techo de gasto;
- las tablas `ai_run` (una fila por intento, sin texto) y `ai_exchange` (el
  texto seudonimizado, sólo si se enciende), con la purga de la segunda.

**Fuera de alcance:**

- **El seudonimizador**: es A5 (`clinica-ai`). Hasta que exista, ningún
  código de producción puede fabricar un `PseudonymizedText`, y por tanto
  ninguno llama a un proveedor (AS-001).
- **`ai_suggestion`** y la procedencia de lo aceptado: es A1.
- **El interruptor por sede y el permiso `assistant:use`**: es A3. Este módulo
  no expone ninguna ruta HTTP; quien la exponga declara su permiso (REQ-118).
- La purga de transcripciones (E3) y cualquier pantalla.

**Depende de:** la configuración (`shared/config`) y la base. Ningún módulo
depende de éste todavía.

## Por qué se guarda lo que se guarda (LOPDP)

| Tabla         | Qué guarda                                                                                                       | Por qué                                                                                                                                     | Cuánto                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ai_run`      | proveedor, modelo, nivel, propósito, versión de prompt, resultado, tokens, costo, latencia, respaldo y su motivo | Contar el gasto (techo), medir proveedores (fase F) y responder qué proveedor recibió qué llamada. **Ningún texto**: ni prompt ni respuesta | Como la bitácora técnica; no identifica a nadie fuera de la atención que enlaza       |
| `ai_exchange` | instrucciones, prompt **seudonimizado** y respuesta cruda de un intento                                          | Depurar y medir lo que el modelo hizo con lo que vio. Apagado de fábrica (`ASSISTANT_EXCHANGE_LOG`)                                         | **45 días tras firmar** la nota de su atención (D-239 §3); sin atención, ver D-241 §2 |

Seudonimizar no es anonimizar (D-239 §1): por eso el texto sólo se guarda si
alguien lo enciende, y caduca.

## Vocabulario

| Término                     | Significado exacto en este módulo                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Petición**                | Lo que pide quien llama: nivel, propósito, versión de prompt, instrucciones, prompt seudonimizado y esquema de la respuesta        |
| **Intento**                 | Una petición enviada a **un** proveedor. Una petición tiene uno o más intentos; cada uno es una fila de `ai_run`                   |
| **Cadena**                  | El orden de proveedores de D-239 §5: Gemini, después Anthropic, después OpenAI, menos los que no están configurados                |
| **Respaldo**                | Pasar la misma petición al siguiente proveedor de la cadena                                                                        |
| **Resultado**               | Cómo terminó un intento: `ok`, `invalid-answer`, `cut-off`, `refused`, `timeout`, `rate-limited`, `provider-error`, `cancelled`    |
| **Fallo de disponibilidad** | `timeout`, `rate-limited` o `provider-error`: el proveedor no pudo atender, no que la petición estuviera mal                       |
| **Peor caso**               | Lo más que puede costar un intento antes de hacerlo: entrada contada a un token por cada dos caracteres y toda la salida permitida |
| **Mes de gasto**            | El mes calendario en `America/Guayaquil` en que empezó el intento                                                                  |

---

## Entregas priorizadas

### E1 — Puerto, respaldo y registro de llamadas _(A4, 11-10-2026)_

D-239 §5: el principal es Gemini; ante un fallo de disponibilidad la misma
petición pasa a Claude Sonnet y después a OpenAI, sin que el médico haga nada,
y `ai_run` registra quién respondió.

**Por qué va primero:** todo lo demás del asistente (borrador, CIE-10, receta)
llama por este puerto; sin él cada función inventaría su propio cliente y su
propio registro.
**Prueba independiente:** con proveedores falsos, el primero devolviendo 503,
una petición la responde el segundo y quedan dos filas en `ai_run` —la del
503 y la del respaldo con su motivo— sin una palabra del prompt.
**Cubre:** AS-001 a AS-019.
**Solo servidor:** AS-001 a AS-019. Esta entrega no tiene pantalla.

## Criterios de éxito

- **SC-089** — Con `ASSISTANT_ALLOW_REMOTE` distinto de `true`, el número de
  peticiones de red a un proveedor es **cero**, haya o no claves.
- **SC-090** — Ninguna fila de `ai_run`, línea de log ni mensaje de error del
  módulo contiene texto del prompt, de las instrucciones ni de la respuesta.

## Supuestos

- Los modelos y precios de `model-routing.ts` y `llm-pricing.json` son los de
  SigmAI para Gemini y Anthropic (E-044, E-050) y los publicados por OpenAI el
  11-10-2026 para OpenAI, que nadie ha medido todavía (D-241 §4). La fase F
  los confirma o los cambia, en ese único sitio.
- Una instalación es una clínica: el techo «por clínica» es por instalación.

---

## Requisitos

### 1. El puerto (P4 del plan)

- **AS-001** — El puerto `LlmClient` NO DEBERÁ admitir como prompt otro tipo
  que `PseudonymizedText`, ni como instrucciones otro que `SystemInstruction`,
  que sólo se obtiene de texto literal sin interpolar (`instruction\`…\``): una
llamada con un `string`en cualquiera de los dos NO DEBERÁ compilar. Y ningún
archivo de`src/`DEBERÁ fabricar uno de los dos por conversión de tipo, por
alias, ni pasar un valor del puerto por`as never`o`as any`, salvo
`withContext`e`instruction` en el propio puerto.
  > La garantía es de tipo, no de disciplina (SigmAI `core/llm/ports.ts`). La
  > única puerta de entrada será el seudonimizador de A5; `withContext` añade
  > texto que el sistema compone —un catálogo, una instrucción—, nunca texto
  > del paciente. Una prueba recorre `src/` y falla con cualquier otra
  > conversión. Las instrucciones también llegan al proveedor: por eso tienen
  > su propio tipo y no basta con la disciplina (revisión del 11-10-2026). El
  > recorrido es una red, no una prueba formal: las conversiones genéricas que
  > TypeScript admite sin `as` se vigilan en la revisión de cada llamador.
- **AS-002** — Toda petición DEBERÁ declarar su nivel (`fast` o `quality`), su
  propósito y la versión de su prompt; el modelo que la atiende lo decide
  `model-routing.ts` y NO DEBERÁ elegirlo quien llama.
- **AS-003** — CUANDO un proveedor responda, el sistema DEBERÁ validar la
  respuesta contra el esquema (zod) de la petición, además de pedírselo al
  proveedor; y SI no lo cumple, ENTONCES el intento DEBERÁ terminar en
  `invalid-answer` sin devolver nada de la respuesta a quien llama.
  > Dos veces, como en SigmAI: los proveedores ignoran parte del esquema
  > (Gemini `maxLength`, OpenAI exige todo `required`), así que el esquema del
  > proveedor es una ayuda y el de zod es la garantía.

### 2. Los adaptadores (D-239 §5)

- **AS-004** — Cada adaptador (Gemini, Anthropic, OpenAI) DEBERÁ traducir cada
  final de la llamada a un único resultado: `200` válido → `ok`; respuesta
  fuera del esquema o vacía → `invalid-answer`; límite de tokens →
  `cut-off`; rechazo por contenido o `400` → `refused`; plazo agotado, `408` o
  `504` → `timeout`; `429` → `rate-limited`; `5xx`, `401`, `403`, `404` o
  red caída → `provider-error`; señal de quien llama → `cancelled`. Y DEBERÁ
  enviar la credencial en una cabecera, nunca en la URL.
  > `401/403/404` son de la instalación con ese proveedor (clave, cuenta,
  > modelo), no de la petición: se tratan como no disponible para que el
  > respaldo los cubra. Un `400` es la petición misma y se repetiría igual.
- **AS-005** — El adaptador de Anthropic DEBERÁ enviar el nivel `quality` con
  el razonamiento apagado.
  > E-044: `claude-sonnet-5` con el razonamiento por defecto respondió 0 de 5
  > borradores, gastando todo el presupuesto en razonar; apagado, 5 de 5.
- **AS-006** — MIENTRAS `ASSISTANT_ALLOW_REMOTE` no sea `true`, el sistema NO
  DEBERÁ construir ningún adaptador remoto; y un proveedor sin su clave
  (`ASSISTANT_GEMINI_API_KEY`, `ASSISTANT_ANTHROPIC_API_KEY`,
  `ASSISTANT_OPENAI_API_KEY`) NO DEBERÁ formar parte de la cadena. SI la cadena
  queda vacía, ENTONCES toda petición DEBERÁ fallar con
  `ASSISTANT_NOT_CONFIGURED` sin hacer ninguna petición de red.
  > La misma guarda que `SRI_ALLOW_REMOTE` e `IDENTITY_PROVIDER_ALLOW_REMOTE`:
  > un `.env` copiado no manda nada fuera. D-239 §1: ningún dato de un paciente
  > real sale hasta tener cláusulas y retención cero con **cada** proveedor.

### 3. El respaldo (D-239 §5)

- **AS-007** — CUANDO un intento termine en un fallo de disponibilidad, el
  sistema DEBERÁ enviar la **misma** petición al siguiente proveedor de la
  cadena; y SI todos fallan, ENTONCES DEBERÁ fallar con
  `ASSISTANT_PROVIDER_FAILED`, reintentable.
  > «Espera larga» es `timeout`: cada intento tiene su plazo
  > (`ASSISTANT_PROVIDER_TIMEOUT_MS`), y agotarlo pasa al siguiente.
- **AS-008** — SI un intento termina en `invalid-answer`, `cut-off` o
  `refused`, ENTONCES el sistema NO DEBERÁ pasar al siguiente proveedor y
  DEBERÁ fallar con `ASSISTANT_PROVIDER_FAILED`, no reintentable.
  > D-239 §5 nombra el error del proveedor y la espera larga; un fallo del
  > modelo con esa petición no es lo mismo, y repetirlo en otro proveedor
  > ocultaría lo que la fase F tiene que medir. Si el autor lo quiere de otro
  > modo es una línea (D-241 §3).
- **AS-009** — CUANDO quien llama cancele la petición —también con su propio
  plazo—, el sistema DEBERÁ detener el intento en curso, registrarlo como
  `cancelled` y NO DEBERÁ intentar con ningún otro proveedor; y SI la petición
  llega ya cancelada, ENTONCES NO DEBERÁ llamar a ninguno ni registrar nada.
  > El adaptador no distingue el plazo de quien llama del del intento (los dos
  > se llaman `TimeoutError`); el enrutado sí, porque conoce la señal de quien
  > llama.
- **AS-010** — El orden de la cadena y el modelo de cada proveedor por nivel
  DEBERÁN declararse en un único sitio (`model-routing.ts`).
  > «Si Gemini no iguala la calidad, el principal se cambia en un solo sitio»
  > (D-239 §5).

### 4. El registro de llamadas (D-239 §3 y §5)

- **AS-011** — CUANDO termine un intento, sea cual sea su resultado, el
  sistema DEBERÁ dejar una fila en `ai_run` con: la petición a la que
  pertenece, el número de intento, el proveedor, el modelo, el nivel, el
  propósito, la versión de prompt, el resultado, el estado HTTP si lo hubo, los
  tokens que el proveedor informó (entrada, salida, caché leída y escrita,
  razonamiento), el costo, la fecha del precio usado, la latencia, el instante
  de inicio con el reloj de la aplicación y, si fue un respaldo, el resultado
  del intento anterior que lo causó. NO DEBERÁ guardar texto alguno: ni
  prompt, ni instrucciones, ni respuesta, ni el mensaje del proveedor.
  > Por intento y no por petición: un intento fallido también puede facturarse,
  > y el techo lo cuenta. Una petición respondida por el respaldo son dos filas
  > con el mismo `request_id`; el motivo es un código, no un texto, porque el
  > cuerpo de error de un proveedor puede citar la entrada. El propósito y la
  > versión de prompt (1–40 caracteres en minúscula) y el `encounterId` (UUID)
  > se comprueban **antes** de llamar: un valor que la tabla rechazara dejaría
  > un intento cobrado sin fila.
- **AS-012** — La base DEBERÁ rechazar una fila de `ai_run` con un resultado o
  un nivel fuera de su lista, un número de intento menor que 1, tokens o costo
  negativos, o un motivo de respaldo en el primer intento.
- **AS-013** — SI guardar la fila falla, ENTONCES el sistema DEBERÁ devolver
  igualmente la respuesta a quien llama, DEBERÁ seguir contando su costo para
  el techo del mes y DEBERÁ registrar el fallo en el log sin el texto de la
  llamada.
  > Guardarla nunca es motivo para que el médico se quede sin borrador
  > (SigmAI `recording-llm-client.ts`).
- **AS-014** — DONDE `ASSISTANT_EXCHANGE_LOG` sea `true`, el sistema DEBERÁ
  guardar en `ai_exchange`, enlazados a la fila de `ai_run` del intento, las
  instrucciones, el prompt seudonimizado y la respuesta cruda; MIENTRAS no lo
  sea, NO DEBERÁ guardar en ninguna tabla el texto de ninguna llamada.
- **AS-015** — El sistema DEBERÁ borrar de `ai_exchange` lo que tenga más de
  **45 días** desde la primera firma de una nota de su atención —o desde su
  propio intento, si fue posterior a esa firma—; lo que, sin atención enlazada,
  tenga más de 45 días desde su intento; y, sea cual sea su atención, lo que
  tenga más de **90 días** desde su intento. DEBERÁ hacerlo al arrancar, una vez
  al día y después de guardar un intercambio nuevo, con el reloj de la
  aplicación.
  > D-239 §3. Lo escrito para una enmienda vive 45 días desde que se escribió,
  > no desde la primera firma (si no, se borraría al instante). El plazo de lo
  > que no tiene atención es D-241 §2; el tope de 90 días, para una atención que
  > nunca se firma (abierta por error, interrumpida), es D-241 §6. La purga
  > diaria cubre el registro apagado y un proceso que no se reinicia.

### 5. Precios y techo de gasto (plan §7 A4)

- **AS-016** — El costo de un intento DEBERÁ calcularse con el precio de su
  modelo **vigente en el instante del intento** según `llm-pricing.json`, donde
  cada precio lleva desde cuándo rige, cuándo se leyó y de dónde; y SI el
  modelo no tiene precio vigente, ENTONCES el sistema NO DEBERÁ llamar a ese
  modelo.
  > Un gasto que no se puede contar no se hace: el techo dejaría de ser un
  > techo. Gemini dobla su precio el 01-01-2027: es una segunda entrada con su
  > fecha, no un cambio que borra la anterior.
- **AS-017** — CUANDO lo gastado en el mes de gasto más el peor caso del
  intento supere `ASSISTANT_MONTHLY_SPEND_CEILING_USD`, el sistema NO DEBERÁ
  hacer el intento y DEBERÁ fallar con `ASSISTANT_SPENDING_CEILING_REACHED`; y
  MIENTRAS el techo no esté configurado, NO DEBERÁ hacer ningún intento
  remoto. Un intento que el proveedor rechazó con un estado HTTP de error
  (también `408`/`504`), o que no llegó a él —conexión rechazada, nombre que no
  resuelve, TLS—, DEBERÁ contar **0**; uno que terminó por el plazo de la
  ruta, por una cancelación o un corte de conexión después de enviarse, o una
  respuesta sin tokens informados, DEBERÁ contar por su peor caso; y los intentos en curso DEBERÁN
  contar por su peor caso mientras duran.
  > Cerrado por defecto: el monto lo fija la instalación; el autor decidió
  > **100 USD al mes** (D-241 §1). Una petición rechazada no se cobra, y
  > contarla por su peor caso vaciaba el techo con los 503 de Gemini (D-241 §9,
  > 11-10-2026); lo que el proveedor pudo empezar a escribir sí. El techo se mira
  > antes de **cada** intento, también de un respaldo, porque cada proveedor
  > cobra distinto. La reserva de lo que está en curso vive en el proceso: con
  > varias instancias de la API haría falta en la base (D-241 §8).

### 6. Lo que llega al log (REQ-116)

- **AS-018** — Ninguna línea de log del módulo DEBERÁ contener las
  instrucciones, el prompt, la respuesta ni el mensaje de error de un
  proveedor: sólo el proveedor, el resultado, el número de intento, la
  duración y el código de error, bajo claves de la lista blanca de
  `log-privacy.ts`.
  > SigmAI A-03: 26 sitios registraban `error.message` con la transcripción
  > dentro. Aquí el mensaje técnico de un fallo nunca lleva el prompt, y el log
  > tampoco lleva el mensaje. El SDK de Anthropic se construye con su URL y su
  > log fijos: `ANTHROPIC_BASE_URL` desviaría el texto y `ANTHROPIC_LOG=debug`
  > lo imprimiría fuera de pino.
- **AS-019** — Los mensajes de error que el módulo lanza NO DEBERÁN contener
  texto de la petición ni de la respuesta, y lo que el proveedor devolvió NO
  DEBERÁ salir al serializar el error.

---

## Códigos de error nuevos

| Código                               | Clase base             | HTTP      | Cuándo                                                                       |
| ------------------------------------ | ---------------------- | --------- | ---------------------------------------------------------------------------- |
| `ASSISTANT_NOT_CONFIGURED`           | `ExternalServiceError` | 502       | La cadena está vacía (AS-006)                                                |
| `ASSISTANT_PROVIDER_FAILED`          | `ExternalServiceError` | 503 / 502 | Ningún proveedor respondió (reintentable, AS-007) o el modelo falló (AS-008) |
| `ASSISTANT_SPENDING_CEILING_REACHED` | `QuotaExceededError`   | 429       | El techo del mes no admite el intento, o no hay techo (AS-017)               |

## Niveles de prueba

| Requisito                              | Nivel                                                                |
| -------------------------------------- | -------------------------------------------------------------------- |
| AS-001                                 | Tipos (`@ts-expect-error`, lo comprueba `tsc`) y recorrido de `src/` |
| AS-002 a AS-010                        | Unitario, con `fetch` y proveedores falsos                           |
| AS-015 (al arrancar y cada día)        | Unitario del módulo con reloj falso                                  |
| AS-011, AS-012, AS-014, AS-015, AS-017 | Integración contra PostgreSQL, con control positivo                  |
| AS-013, AS-016, AS-018, AS-019         | Unitario (AS-018 sobre `pruneToAllowlist`)                           |

## Preguntas abiertas

Todas en **D-241**: el monto del techo, el plazo del texto sin atención, qué
fallos activan el respaldo, los modelos de OpenAI, el tope para atenciones sin
firma, cuánto se guarda `ai_run`, si los intentos rechazados cuentan en el
techo, la reserva con varias instancias y la retención en cada proveedor.
