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
  texto seudonimizado, sólo si se enciende), con la purga de la segunda;
- la tabla `ai_suggestion`: cada propuesta, de dónde sale y qué hizo con ella
  quien decide, con el enlace a lo que se guardó (A1);
- la **escucha** de la consulta (C1): el canal de audio del navegador, su reloj
  en `listening_session` y la transcripción en `transcript_segment`, con su
  purga.

**Fuera de alcance:**

- **El seudonimizador**: es A5 (`clinica-ai`). Hasta que exista, ningún
  código de producción puede fabricar un `PseudonymizedText`, y por tanto
  ninguno llama a un proveedor (AS-001).
- **El interruptor por sede y el permiso `assistant:use`**: es A3. Este módulo
  no expone ninguna ruta HTTP; quien la exponga declara su permiso (REQ-118).
- El borrador de la nota a partir de la transcripción (C2) y lo que pasa con
  la escucha al firmar (E1).
- Distinguir la voz del médico de la del paciente (dato biométrico, plan §3).

**Depende de:** la configuración (`shared/config`) y la base. Ningún módulo
depende de éste todavía.

## Por qué se guarda lo que se guarda (LOPDP)

| Tabla           | Qué guarda                                                                                                                                                                                 | Por qué                                                                                                                                     | Cuánto                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ai_run`        | proveedor, modelo, nivel, propósito, versión de prompt, resultado, tokens, costo, latencia, respaldo y su motivo                                                                           | Contar el gasto (techo), medir proveedores (fase F) y responder qué proveedor recibió qué llamada. **Ningún texto**: ni prompt ni respuesta | Como la bitácora técnica; no identifica a nadie fuera de la atención que enlaza       |
| `ai_suggestion` | lo propuesto, sus fuentes (minuto de la conversación o dato de la ficha), el intento que lo produjo, la decisión con quién y cuándo, la distancia a lo guardado y el enlace a ese registro | Que cada dato diga de dónde salió (P2) y que la decisión sea del médico (P1, LOPDP art. 20); medir cuánto se corrige                        | Sin purga mientras el autor no decida (D-243 §2)                                      |
| `ai_exchange`   | instrucciones, prompt **seudonimizado** y respuesta cruda de un intento                                                                                                                    | Depurar y medir lo que el modelo hizo con lo que vio. Apagado de fábrica (`ASSISTANT_EXCHANGE_LOG`)                                         | **45 días tras firmar** la nota de su atención (D-239 §3); sin atención, ver D-241 §2 |

Seudonimizar no es anonimizar (D-239 §1): por eso el texto sólo se guarda si
alguien lo enciende, y caduca.

## Vocabulario

| Término                     | Significado exacto en este módulo                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Petición**                | Lo que pide quien llama: nivel, propósito, versión de prompt, instrucciones, prompt seudonimizado y esquema de la respuesta                               |
| **Intento**                 | Una petición enviada a **un** proveedor. Una petición tiene uno o más intentos; cada uno es una fila de `ai_run`                                          |
| **Cadena**                  | El orden de proveedores de D-239 §5: Gemini, después Anthropic, después OpenAI, menos los que no están configurados                                       |
| **Respaldo**                | Pasar la misma petición al siguiente proveedor de la cadena                                                                                               |
| **Resultado**               | Cómo terminó un intento: `ok`, `invalid-answer`, `cut-off`, `refused`, `timeout`, `rate-limited`, `provider-error`, `cancelled`                           |
| **Fallo de disponibilidad** | `timeout`, `rate-limited` o `provider-error`: el proveedor no pudo atender, no que la petición estuviera mal                                              |
| **Peor caso**               | Lo más que puede costar un intento antes de hacerlo: entrada contada a un token por cada dos caracteres y toda la salida permitida                        |
| **Propuesta**               | Lo que el asistente ofrece para un campo —una sección de la nota, un diagnóstico, una línea de receta u orden— con sus fuentes, antes de que nadie decida |
| **Decisión**                | Lo que hace quien la recibe: aceptarla tal cual, aceptarla con cambios o descartarla. Una sola vez                                                        |
| **Distancia**               | Cuánto cambió lo guardado respecto de lo propuesto: la distancia de edición entre los dos textos dividida por la longitud del más largo, de 0 a 1         |
| **Mes de gasto**            | El mes calendario en `America/Guayaquil` en que empezó el intento                                                                                         |

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

### E2 — La procedencia de cada propuesta _(A1, 11-10-2026)_

`PLAN-ASISTENTE-IA.md` §4: hoy ninguna tabla clínica dice de dónde salió un
dato. En vez de una columna en cada tabla, la propuesta guarda su estado y el
id de lo que se guardó.
**Prueba independiente:** contra PostgreSQL, proponer una sección de nota con
su fuente; aceptarla con cambios enlaza a la nota de la misma atención con
distancia mayor que cero y deja la propuesta original en `record_version`;
decidir otra vez se rechaza.
**Cubre:** AS-020 a AS-024.
**Solo servidor:** AS-020 a AS-024. Sin pantalla ni ruta: el permiso
`assistant:use` es de A3, y la pantalla de la fase B/C.

### E3 — CIE-10 propuesto por problema _(D1, 11-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 D1 y §3 («Problemas y CIE-10»): al abrir
Diagnósticos el médico ve, sin modelo, lo que este paciente ya tuvo y lo que la
clínica codifica más; con «Proponer por problema», el modelo lee la nota, nombra
los problemas con la frase que los dice y escribe sus códigos, y el sistema
**sólo muestra los que existen en el catálogo OMS** (P5). Nada se registra sin
que el médico lo acepte: aceptar abre el mismo diálogo de «Registrar
diagnóstico» con el código puesto (P1).

**Por qué va así:** sin catálogo, un modelo acierta un tercio de los códigos
(Soroush, NEJM AI 2024); SigmAI midió que la línea base historial + frecuencia
llega a R@5 33,6 % sin leer nada (doc 17) y que el modelo escribiendo los
códigos sin lista, validados después, es lo que mejor funciona (D-083, T-162).
El reordenador local (−8,8 puntos) y el índice de la OPS (copyright) no se
traen.
**Prueba independiente:** con el seudonimizador y el proveedor falsos, una
nota que dice «odinofagia de tres días» da el problema con esa cita y el código
J02.9 con su nombre del catálogo; un código que el modelo inventa (`J02.7`) no
aparece; el médico acepta J02.9 y la propuesta queda «aceptada» enlazada al
diagnóstico registrado.
**Cubre:** AS-025 a AS-029, AS-035 a AS-044.
**Solo servidor:** AS-025 (el puerto; la pantalla lo ve como AS-040), AS-041
(lo que no llega al log) y AS-042 (el arnés de evaluación, fuera del verify).
**Solo interfaz:** AS-043, AS-044. Son la tarjeta de la propuesta y su fallo
en la pestaña Diagnósticos; la mitad del servidor es AS-027, AS-028, AS-035 y
AS-040, que ya se prueban con esos números.
### E4 — La escucha de la consulta _(C1, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 C1 y §3 («Escucha»): el médico inicia, pausa y
detiene la escucha desde la consulta y ve la transcripción mientras habla. El
audio va del navegador a `clinica-api` y de ahí a `clinica-ai` (whisper.cpp con
detector de voz, en esta máquina), y **no se escribe en ningún sitio**: queda el
texto, que se borra 45 días después de firmar (D-239 §3). Se trae de SigmAI la
lógica medida —reloj de la sesión, pausa y detención que esperan al reconocedor,
reconexión (E-031: 6/6 frases, 0 duplicadas)— y se corrigen sus dos fallos:
cualquier médico podía escuchar la atención de otro (M-02) y el token viajaba en
la URL.

**Por qué va así:** el borrador (C2) se escribe desde esta transcripción; sin
una escucha que no pierda ni repita frases, el borrador omite o inventa.
**Prueba independiente:** con un reconocedor falso que confirma cada ventana,
una escucha de seis frases con una pausa, un corte del canal a mitad de frase,
una reconexión y una detención deja seis segmentos, en orden y sin repetir; un
segundo médico de la misma sede recibe 403 al pedir el vale; ninguna tabla de
la escucha tiene una columna binaria.
**Cubre:** AS-045 a AS-062.
**Solo servidor:** AS-047, AS-049, AS-050, AS-052, AS-053, AS-055, AS-057,
AS-058 y AS-062 (el guion de medición, fuera del verify). La pantalla los ve
como AS-059 y AS-060.
**Solo interfaz:** AS-059, AS-060 y AS-061. Son el control y la transcripción
en la consulta, la reconexión del navegador y el audio de prueba; su mitad del
servidor es AS-045, AS-046, AS-051 y AS-056, que ya se prueban con esos
números.

### E5 — El seudonimizador local, `clinica-ai` _(A5, 11-10-2026)_

P4 del plan: al proveedor sólo va texto seudonimizado, y el seudonimizador corre
en la máquina de la clínica (`clinica-ai`, su `SPEC.md` con `CAI-###`). Aquí,
el adaptador HTTP que implementa el puerto `Pseudonymizer` (AS-025) con el
secreto compartido. Hasta esta entrega el puerto sólo tenía
`MissingPseudonymizer`, que falla cerrado.

**Prueba independiente:** con un `fetch` falso que responde como `clinica-ai`,
una nota sale como `PseudonymizedText` con su mapa; sin secreto, con una URL
que no es de esta máquina por `http`, o con el servicio caído, nada sale y el
error no lleva una palabra de la nota.
**Cubre:** AS-030 a AS-034.
**Solo servidor:** AS-030 a AS-034. Esta entrega no tiene pantalla.

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

### 7. La procedencia de cada propuesta (A1, REQ-176)

- **AS-020** — CUANDO el asistente proponga algo, el sistema DEBERÁ guardarlo
  en `ai_suggestion` con su atención, el intento de `ai_run` que lo produjo,
  su clase (`note-section`, `diagnosis`, `prescription-item`, `order-item`),
  lo propuesto, sus fuentes y el instante del reloj de la aplicación, en
  estado `PROPOSED`. SI las fuentes no son una lista de lugares conocidos —un
  tramo de la conversación (`fromMs ≤ toMs`) o un dato de la ficha en una
  tabla de la lista cerrada, con su uuid—, el sistema DEBERÁ rechazarlo con
  `SUGGESTION_INVALID` sin guardar ninguna; SI lo propuesto no es un objeto, o
  el intento no es uno que respondió (`ok`) en ESA atención, la base DEBERÁ
  rechazarlo. Una atención fuera del alcance de sedes de quien llama no
  existe para él (`SUGGESTION_NOT_FOUND`).
  > P2: cada frase dice de dónde sale. La fuente es una lista y no un texto
  > para que la pantalla la pueda señalar (minuto, dato de la ficha). Quien la
  > resuelva para señalarla (fase B/C) la lee con el alcance del paciente y
  > nunca interpola `table`. El intento de otra atención llevaría «de dónde
  > salió» a la conversación de otro paciente (revisión del 11-10-2026).
- **AS-021** — CUANDO quien decide acepte una propuesta —tal cual
  (`ACCEPTED`) o con cambios (`ACCEPTED_WITH_CHANGES`)—, el sistema DEBERÁ
  enlazarla a **un** registro guardado del tipo de su clase (nota,
  diagnóstico, receta u orden) **de la misma atención**, con quién y cuándo.
  Una propuesta `PROPOSED` o `DISCARDED` NO DEBERÁ enlazar a ninguno. La base
  DEBERÁ rechazar cualquier otra combinación, un registro de otra atención, y
  quién sin cuándo o cuándo sin quién.
  > Una columna por destino y no un par tipo+id: así la base garantiza que el
  > registro existe. «De la misma atención» cierra el enlace a la nota de
  > otro paciente. El diagnóstico va SIN clave foránea: quitarlo lo borra y
  > guarda el mismo id en su retiro (EN-180); el disparador comprueba que
  > existe al aceptar, y después el id lleva a su retiro (D-243 §3).
- **AS-022** — La distancia DEBERÁ ser 0 en una aceptada tal cual, mayor que
  0 y como mucho 1 en una aceptada con cambios, y nula en una propuesta o
  descartada; la DEBERÁ calcular el sistema, no quien llama, comparando lo
  propuesto con lo que el registro enlazado guarda —la sección de la nota, el
  código del diagnóstico—, leído en la misma transacción que decide. Sólo una
  línea de receta u orden, que aún no tiene identidad propia, toma lo
  guardado de quien llama (D-243 §5).
  > Es lo que la fase F mide: cuánto corrige el médico lo que el modelo
  > escribe. Si la distancia es 0, la aceptación es «tal cual» aunque quien
  > llame diga «con cambios».
- **AS-023** — Una decisión DEBERÁ ser definitiva: SI se decide una propuesta
  ya decidida, el sistema DEBERÁ rechazarlo con `SUGGESTION_ALREADY_DECIDED`
  (409). La base NO DEBERÁ admitir cambiar una propuesta decidida, cambiar lo
  propuesto, sus fuentes, su clase, su atención o su intento, ni borrar una
  propuesta.
  > Lo que el médico hizo con lo que se le propuso es la traza de P1. Cuánto
  > se guarda la descartada es D-243 §2.
- **AS-024** — CUANDO se decida una propuesta, la base DEBERÁ archivar la fila
  propuesta entera en `record_version`, con quién y cuándo decidió; la tabla
  DEBERÁ estar declarada en `VERSIONED_TABLES`, y sus versiones NO DEBERÁN
  salir en el archivo de un derecho de acceso mientras D-243 §1 no se decida.
  > La fila no guarda secretos —ni claves ni texto seudonimizado—: sólo lo
  > que el médico vio en pantalla y su fuente.

### 8. El seudonimizador y la puerta del asistente (P4, D-244 §3)

- **AS-025** — El sistema DEBERÁ obtener todo texto de un paciente que vaya a
  un proveedor a través del puerto `Pseudonymizer`, que devuelve el texto como
  `PseudonymizedText` junto con los reemplazos que hizo; y SI la instalación no
  tiene seudonimizador, ENTONCES toda función que lo necesite DEBERÁ fallar con
  `ASSISTANT_NOT_CONFIGURED` sin ninguna petición de red ni fila en `ai_run`.
  > El adaptador HTTP es de A5 (`clinica-ai`); hasta que exista, producción
  > no tiene seudonimizador y «Proponer por problema» falla cerrado (decidido
  > por la principal el 11-10-2026: nada de un «paso directo» de desarrollo).
  > El contrato es el de `sigmai-ai` (`/v1/privacy/pseudonymize`): texto,
  > sujeto, nombres del paciente y del personal → texto con marcadores,
  > reemplazos y días de desplazamiento de las fechas.
- **AS-026** — MIENTRAS `ASSISTANT_ENABLED` no sea `true`, toda ruta del
  asistente DEBERÁ responder 404 como si no existiera; y con él, DEBERÁ exigir
  el permiso `assistant:use`, que el rol `MEDICO` trae de fábrica.
  > D-244 §3: el interruptor por sede llega con A3; hasta entonces la
  > instalación y la cuenta. Un 404 y no un 403 sin interruptor: la pantalla no
  > debe enseñar nada de IA en una instalación que no lo encendió. El 404 lo
  > da un middleware, ANTES de la sesión, el permiso y las pipes (revisión del
  > 11-10-2026: un guarda llegaba tarde y el 401/403/400 delataba la ruta). Y
  > `assistant:use` se cruza con las sedes de `record:read`/`record:write`: una
  > sede donde se escribe sin el asistente no lo tiene. C1 iba a
  > traer el permiso; D1 llegó antes (D-244 §3 lo previó: «la primera entrega
  > que tenga rutas»).

- **AS-029** — DONDE `ASSISTANT_FAKE_PROVIDER` sea `true`, el sistema DEBERÁ
  usar como única cadena el proveedor falso con el guion del repositorio y un
  seudonimizador falso; DEBERÁ negarse a arrancar si además `NODE_ENV` es
  `production`, `ASSISTANT_ALLOW_REMOTE` es `true` o hay alguna clave de
  proveedor real; DEBERÁ registrar en `ai_run` el proveedor `fake`, y cada
  propuesta DEBERÁ decir que es de demostración.
  > Aprobado por la principal el 11-10-2026 para el recorrido y la
  > presentación sin A5: con el modo encendido no existe ningún camino a la
  > red, así que el seudonimizador falso no puede dejar salir nada. En
  > pantalla: «Propuesta de demostración (sin modelo)»; nadie debe tomar una
  > respuesta del guion por una del modelo. Apagado de fábrica.

### 9. La línea base, sin modelo (plan §3)

- **AS-027** — CUANDO alguien con `record:read` en la sede pida las propuestas
  de CIE-10 de una atención, el sistema DEBERÁ devolver hasta **5** códigos
  sin llamar a ningún modelo: primero los que ya se registraron a este paciente
  en otras atenciones —su historia y las que absorbió (`chartScope`, PA-055),
  en las sedes donde quien pide lee la historia, el alcance de EN-184—,
  de más usado a menos y, a igualdad, el más reciente; después los que la
  clínica más registra; sin los que esta atención ya tiene, y sólo los
  seleccionables (cuatro caracteres) vigentes en su fecha clínica. Cada uno
  DEBERÁ decir de dónde viene (`history` o `frequency`) y, si es de la historia,
  cuántas veces y la última fecha.
  > SigmAI, doc 17: historial + frecuencia es el brazo de R@5 33,6 %, y aquí
  > mejora solo con el uso porque toda atención firmada tiene código. Una
  > lectura de la historia: queda en la bitácora como las demás (EN-047).

### 10. Problemas y códigos del modelo (D-083 de SigmAI, P2, P5)

- **AS-028** — CUANDO el profesional de la atención pida «Proponer por
  problema» en una atención viva, el sistema DEBERÁ seudonimizar el texto de su
  nota de consulta (las secciones con texto, con su nombre), pedir al modelo los
  problemas de la consulta, cada uno con la frase literal de la nota que lo
  dice, y DEBERÁ descartar todo problema cuya frase no esté en la nota; y SI la
  nota no tiene texto, ENTONCES DEBERÁ rechazarlo con `ASSISTANT_NOTE_EMPTY`
  sin llamar a nadie.
  > Mientras no haya transcripción (C1), la fuente es la nota escrita (plan de
  > la rama). La frase se compara con el texto seudonimizado y, devueltos los
  > marcadores, con la nota, sin distinguir mayúsculas, tildes ni espacios y
  > como palabras enteras: un problema sin frase es un problema que nadie
  > escribió (RC-21 de SigmAI). La frase tiene al menos dos palabras y ocho
  > caracteres; una que la nota niega justo antes («niega dolor torácico»,
  > «sin fiebre») no respalda nada (D-245 §5); se muestra la oración de la
  > nota que la contiene, no la copia del modelo; y al mostrar las propuestas
  > se vuelve a buscar en la nota de ahora: la que ya no está no se muestra.
  > Un problema cuyo nombre lleva una fecha se descarta: el seudonimizador la
  > desplazó. Al seudonimizador van los nombres del paciente, de sus contactos
  > (D-246 §2) y del profesional; si lo que devuelve trae aún una cédula, un
  > RUC, un móvil, un correo o un número de historia, la lectura falla
  > cerrada.
  > Una frase con una fecha que el seudonimizador desplazó no está en la nota
  > y se descarta: nunca se muestra con la fecha cambiada.
- **AS-035** — Para cada problema el modelo DEBERÁ escribir hasta 5 códigos
  CIE-10, y el sistema DEBERÁ mostrar sólo los que resuelva en el catálogo
  OMS vigente en la fecha clínica de la atención: el código exacto, con o sin
  punto, o —si el modelo escribió una categoría de tres caracteres— la
  subcategoría `.X` de esa categoría cuando el catálogo la tiene. Un código
  que no resuelve NO DEBERÁ mostrarse nunca, y el nombre que se muestra DEBERÁ
  ser el del catálogo, no el que escribió el modelo.
  > El catálogo OMS va a cuatro caracteres (`fix/catalogos-oficiales`):
  > J02.9, I10.X. Una categoría con varias subcategorías (J02 → J02.0, J02.8,
  > J02.9) no se completa por su cuenta: elegir el cuarto carácter es
  > codificar, y eso lo hace el médico (D-245 §2). Un problema que se queda sin
  > códigos se muestra igual, con su frase, para que el médico lo busque.
- **AS-036** — CUANDO el modelo responda, el sistema DEBERÁ guardar cada
  problema como una propuesta de `ai_suggestion` de clase `diagnosis`, en
  estado «propuesta», con el intento de `ai_run` que respondió, el problema,
  su frase, sus códigos resueltos y su fuente (la sección de la nota); y la
  lectura nueva DEBERÁ sustituir en pantalla a las propuestas sin decidir de la
  anterior, sin borrar ninguna.
  > AS-023 de A1: una propuesta no se borra. Se muestran las de la última
  > lectura que no se descartaron y cuya oración la nota aún dice; las de una
  > lectura vieja quedan en la tabla como estaban y no se muestran (lo que se
  > aceptó de ellas ya está en la lista de diagnósticos). Una lectura que no
  > propone nada lo dice (`found: 0`) y deja las anteriores como estaban.

### 11. Aceptar y descartar (P1)

- **AS-037** — CUANDO el profesional acepte una propuesta con el diagnóstico
  que registró desde ella, el sistema DEBERÁ comprobar que ese diagnóstico es
  de la misma atención y está vigente, y DEBERÁ dejar la propuesta «aceptada»
  si su código es uno de los propuestos o «aceptada con cambios» si eligió
  otro, enlazada al diagnóstico, con quién y cuándo; el asistente NO DEBERÁ
  registrar ningún diagnóstico por su cuenta.
  > El diagnóstico se registra por su ruta de siempre (EN-040…EN-049), con sus
  > marcas del RDACAA; aceptar sólo enlaza. Distancia (AS-022): 0 con un código
  > propuesto, 1 con otro. «Desde ella» quiere decir registrado después de la
  > propuesta y no enlazado ya a otra: un diagnóstico anterior no es obra de
  > la propuesta, y dos propuestas sobre uno solo lo contarían dos veces.
  > La base lo garantiza también: `ai_suggestion_one_per_diagnosis`, índice
  > único parcial sobre el diagnóstico enlazado (sólo para esa clase).
- **AS-038** — CUANDO el profesional descarte una propuesta, el sistema DEBERÁ
  dejarla «descartada» con quién y cuándo, y NO DEBERÁ volver a mostrarla.
- **AS-039** — Proponer, aceptar y descartar DEBERÁN exigir que quien lo pide
  sea el profesional de la atención, con `record:write` en su sede, y que la
  atención siga viva; SI no lo es, ENTONCES el sistema DEBERÁ rechazarlo sin
  llamar al modelo ni tocar nada, y una atención de otra sede DEBERÁ
  responderse como inexistente (EN-121).
  > SigmAI M-02: cualquier médico podía pedir el asistente en la atención de
  > otro. Leer la línea base sigue siendo de quien puede leer la atención.
  > D-245 §1.

### 12. Fallos y privacidad

- **AS-040** — SI el seudonimizador o el proveedor fallan, se acaba el plazo o
  el techo de gasto no admite el intento, ENTONCES la lectura DEBERÁ fallar con
  el código del error, sin guardar nada y sin tocar las propuestas que ya
  había, y la línea base DEBERÁ seguir respondiendo.
  > En pantalla, el motivo y «Volver a pedir» (AS-044). El plazo de la lectura
  > es de 90 s, como en SigmAI (`NAMING_LIMIT_MS`); el primer fallo corta las
  > llamadas que siguen en vuelo. Una lectura a la vez por atención
  > (`ASSISTANT_READING_IN_PROGRESS`) y seis por minuto: cada una paga una
  > llamada por problema. Si la atención se cerró mientras el modelo
  > respondía, no se guarda nada. El almacén lo comprueba con la atención bloqueada
  > (`FOR UPDATE`) en la misma transacción que guarda.
- **AS-041** — Ninguna línea de log, fila de `ai_run` ni mensaje de error de
  esta función DEBERÁ contener la nota, los problemas ni sus frases; y el texto
  de la nota DEBERÁ ir al modelo delimitado como dato, con la instrucción de no
  seguir órdenes que contenga.
  > AS-018 sigue valiendo; aquí se prueba con una nota con un nombre y una
  > orden dentro («ignora lo anterior…»). La nota va entre `<nota>` y
  > `</nota>`, con esas marcas rotas si la nota las escribía; el problema, en
  > una línea entre «». Leer la nota para mandarla deja su fila en la
  > bitácora (`EXPORT`, EN-122), y las respuestas que llevan la historia, la
  > suya (`READ`).

### 13. Medir antes de encender (P7)

- **AS-042** — El arnés de evaluación DEBERÁ medir, sobre CodiEsp y sobre el
  set propio de consultas inventadas, el R@5 a cuatro y a tres caracteres de la
  línea base y de «Proponer por problema», y cuántos códigos inexistentes se
  habrían mostrado, que DEBERÁ ser **cero**; y DEBERÁ correr fuera del verify,
  escribiendo el resultado con el modelo, la versión del prompt y la del
  catálogo.
  > CodiEsp (CC-BY 4.0) viene en CIE-10-CM, que extiende la de la OMS: su
  > código se compara truncado a la subcategoría de cuatro caracteres. Sus
  > casos clínicos son públicos y no son pacientes de la clínica: el arnés vive
  > fuera de `src/` y no pasa por el seudonimizador. Lo que mide es el paso
  > de los códigos —la frase del experto como problema—, con el prompt y la
  > barrera del producto; nombrar los problemas desde una nota no tiene aún
  > un set con referencia y queda para la fase F. La línea base de CodiEsp es
  > la frecuencia de todo el corpus sin el artículo del caso; la del set
  > propio no aplica (sin historia, cada código aparece una vez). Que no se
  > muestre un código inexistente lo garantiza la barrera contra la base
  > (AS-035, integración); el arnés cuenta lo que el modelo escribió.

### 14. En la pestaña Diagnósticos

- **AS-043** — La pestaña Diagnósticos DEBERÁ mostrar la línea base como
  códigos que se registran con un clic en «Registrar diagnóstico» con el código
  puesto, y cada propuesta del modelo con borde punteado, «Propuesta», su
  problema, su frase y sus códigos, con «Aceptar» —que abre ese diálogo con el
  código puesto y, al guardar, la enlaza— y «Descartar»; y sin el permiso o
  con el asistente apagado NO DEBERÁ mostrar nada de esto.
  > Estándar de propuestas de SigmAI (`18-ESTANDAR-UI.md` §6 bis): borde
  > punteado, «Aceptar» escribe, «Descartar»; la procedencia una vez por grupo.
- **AS-044** — MIENTRAS la lectura está en curso la pestaña DEBERÁ decirlo y
  seguir usable; y SI falla, ENTONCES DEBERÁ decir el motivo con «Volver a
  pedir», sin quitar la línea base ni las propuestas que ya había.
### 15. El seudonimizador local (A5)

- **AS-030** — CUANDO se pida seudonimizar un texto, el adaptador DEBERÁ
  enviarlo a `POST /v1/privacy/pseudonymize` de `clinica-ai` con la cabecera
  `Authorization: Bearer <ASSISTANT_AI_SERVICE_SECRET>`, y DEBERÁ devolver el
  texto como `PseudonymizedText` sólo si la respuesta cumple el contrato
  (`text`, `replacements[]` con `placeholder`, `original` y `kind`,
  `date_shift_days` entero) y no contiene ninguna palabra de tres letras o más
  de los `names` enviados (sin mayúsculas ni acentos). Es el único sitio,
  además de `withContext`, que convierte un texto en `PseudonymizedText`
  (AS-001).
- **AS-031** — SI `ASSISTANT_AI_SERVICE_SECRET` no está declarado, ENTONCES la
  instalación DEBERÁ usar `MissingPseudonymizer` (AS-025), que rechaza sin
  ninguna petición de red; y SI está declarado con menos de 32 caracteres,
  ENTONCES la API NO DEBERÁ arrancar.
- **AS-032** — SI `ASSISTANT_AI_SERVICE_URL` apunta a una máquina que no es
  esta (`localhost`, `127.0.0.1`, `::1`) sin `ASSISTANT_AI_SERVICE_ALLOW_REMOTE=true`,
  o a otra máquina por algo que no sea `https`, o no es `http`/`https`,
  ENTONCES la API NO DEBERÁ arrancar: el texto viaja sin seudonimizar.
- **AS-033** — SI el servicio no responde en `ASSISTANT_AI_SERVICE_TIMEOUT_MS`,
  responde con un estado de error, o su respuesta no cumple el contrato,
  ENTONCES el adaptador DEBERÁ lanzar `ASSISTANT_PSEUDONYMIZER_FAILED`
  —reintentable sólo si el servicio no estaba disponible (red, plazo, 5xx)— y
  NO DEBERÁ devolver el texto ni parte de él. El adaptador NO DEBERÁ seguir
  una redirección: un 3xx es un rechazo. CUANDO quien llama cancele, el
  adaptador DEBERÁ abandonar la petición.
- **AS-034** — El mensaje, la serialización y el log de un fallo del adaptador
  NO DEBERÁN contener el texto enviado, los nombres, ni el mapa de
  sustituciones ni el cuerpo que devolvió el servicio.
  > SigmAI A-03 (26 sitios registraban la transcripción en `error.message`).
  > El mapa es lo más sensible que existe aquí: dice qué nombre hay detrás de
  > cada marcador.

### 16. Quién escucha (M-02, REQ-178)

- **AS-045** — CUANDO alguien pida abrir la escucha de una atención, el sistema
  DEBERÁ darle un vale de un solo uso, que caduca a los **30 s**, atado a su
  cuenta y a esa atención, sólo si tiene `assistant:use` y `record:write` en la
  sede de la atención, es el usuario del profesional de la atención y la
  atención admite contenido nuevo (`OPEN` u `ON_HOLD`). SI es otro usuario,
  ENTONCES DEBERÁ rechazarlo con `ASSISTANT_NOT_ENCOUNTER_OWNER` (403); SI la
  atención no existe o es de una sede fuera de su alcance, con
  `ASSISTANT_ENCOUNTER_NOT_FOUND` (404); y SI ya no admite contenido, con
  `ASSISTANT_ENCOUNTER_CLOSED` (409).
  > SigmAI M-02: cualquier médico escuchaba la consulta de otro. El vale se
  > pide por HTTP para que decidan los guardas de siempre (sesión, permiso,
  > sede, interruptor) y no una copia de ellos en el canal de audio. La misma
  > regla que D-245 §1 para el CIE-10.
- **AS-046** — El canal de audio NO DEBERÁ llevar ninguna credencial en la URL:
  el vale DEBERÁ llegar en el primer mensaje. SI no llega en **5 s**, es
  desconocido, caducó o ya se usó, ENTONCES el sistema DEBERÁ cerrar el canal
  con el código **4401** sin haber atendido nada. SI el navegador declara un
  `Origin` que no está en `CORS_ORIGINS`, ENTONCES DEBERÁ rechazar la apertura
  con 403; y MIENTRAS `ASSISTANT_ENABLED` no sea `true`, DEBERÁ responder a la
  apertura con 404, como a una ruta que no existe.
  > SigmAI ponía el token en la URL (`?token=`), que acaba en los registros de
  > acceso de cualquier proxy. Un navegador no puede poner cabeceras en un
  > WebSocket; el vale de un solo uso, pedido con la cabecera
  > `Authorization` de siempre, lo resuelve sin un segundo camino de entrada.
- **AS-047** — CUANDO caduque el token de acceso con que se pidió el vale, el
  sistema DEBERÁ cerrar el canal con **4401**, igual que un corte (AS-051).
  > Una sesión revocada o un permiso retirado dejan de escuchar en lo que dura
  > un token, sin que el canal tenga que preguntar a `auth`. La pantalla pide
  > otro vale —con el token renovado— y sigue sin perder nada (AS-060).
- **AS-048** — CUANDO el médico inicie o reanude la escucha, el sistema DEBERÁ
  comprobar en `clinica-ai` que el reconocedor **y el detector de voz** están
  instalados; SI falta alguno, el servicio no responde o ya escucha todas las
  consultas que admite, ENTONCES DEBERÁ negarse con
  `ASSISTANT_LISTENING_UNAVAILABLE` y su motivo (`no-recognizer`,
  `no-voice-detection`, `unreachable`, `busy`), sin abrir nada.
  > P3 y E-028: sin detector de voz, whisper escribe sobre el silencio frases
  > que nadie dijo («Gracias por ver el video») y entrarían en la nota.
  > `clinica-ai` lo usa sólo si está instalado (CAI-010); la obligación la pone
  > este lado.

### 17. Sin pérdida ni duplicados (E-031)

- **AS-049** — La escucha de una atención DEBERÁ tener un reloj propio en
  milisegundos, guardado en `listening_session`; iniciar o reanudar DEBERÁ
  responder el reloj donde quedó y NO DEBERÁ volver a cero; cada trama DEBERÁ
  llevar su inicio en ese reloj. CUANDO llegue una trama, el sistema DEBERÁ
  descartar la parte que ya había recibido —la que acaba en el reloj o antes— y
  reenviar a `clinica-ai` sólo lo nuevo; y DEBERÁ guardar el reloj al menos cada
  **5 s** de audio.
  > El reloj es de la consulta, no de la conexión (SigmAI RC-09). Que la parte
  > repetida se descarte es lo que deja a la pantalla reenviar sin miedo lo que
  > no sabe si llegó (AS-060).
- **AS-050** — CUANDO el médico pause o detenga, el sistema DEBERÁ pedir a
  `clinica-ai` lo que aún tiene, esperar a que termine (como mucho **90 s**),
  guardar cada segmento y sólo después responder con el reloj. Detener DEBERÁ
  dejar la sesión `STOPPED`; iniciar después DEBERÁ seguir con el mismo reloj.
  > SigmAI RC-11: la última frase de la consulta era la que siempre se perdía.
- **AS-051** — CUANDO el canal del navegador se cierre sin pausar ni detener,
  el sistema DEBERÁ hacer lo mismo que al pausar y dejar la sesión `PAUSED` con
  el motivo `device-lost`; y CUANDO el navegador vuelva y reanude, DEBERÁ seguir
  desde ese reloj, de modo que lo dicho antes, durante y después del corte quede
  **una vez y en orden**.
  > E-031: la frase que estaba dentro del reconocedor cuando se cortó el canal
  > sobrevive porque se le pide antes de marcar la pausa.
- **AS-052** — La base DEBERÁ rechazar dos segmentos de la misma atención con
  el mismo inicio, un segmento cuyo fin no sea mayor que su inicio, uno con el
  texto vacío y cualquier cambio a un segmento guardado; y el sistema DEBERÁ
  guardar sólo los segmentos que el reconocedor confirmó, sin repetir uno que ya
  está.
  > Antes de E-031, reanudar en SigmAI reescribía la primera mitad de la
  > consulta. Aquí lo impide la base, no la disciplina.
- **AS-053** — El sistema NO DEBERÁ escribir el audio en disco, en la base, en
  un log ni en una cola: cada trama se reenvía y se suelta. Ninguna tabla de la
  escucha DEBERÁ tener una columna binaria, y ningún archivo de la escucha
  DEBERÁ importar el sistema de archivos. SI una trama trae más de **1 s** de
  audio, ENTONCES el sistema DEBERÁ cerrar el canal con **1009**.
  > P3 y SigmAI RF-E09. El tope es el de `clinica-ai` (CAI-015): una trama más
  > larga no la aceptaría el reconocedor, y aquí se corta antes de reservar
  > memoria para ella.
- **AS-054** — MIENTRAS una atención se escucha desde un canal, CUANDO otro
  canal del mismo profesional la inicie, el sistema DEBERÁ pasarle la captura,
  avisar al anterior (`taken-over`) e ignorar desde entonces sus tramas.
  > Dos micrófonos en la misma sala mandarían las mismas palabras dos veces
  > con dos relojes (SigmAI RC-10). Es lo que pasa al recargar la página o al
  > pasar del computador al teléfono.
- **AS-055** — SI `clinica-ai` falla, cierra el canal sin terminar o no termina
  en 90 s, ENTONCES el sistema DEBERÁ dejar la sesión `PAUSED` con el motivo
  `recognizer-failed` y decírselo al navegador; SI lo cierra por su tope de
  duración o de inactividad (1001) mientras se escucha, ENTONCES DEBERÁ
  reabrirlo con el mismo reloj sin pausar; y SI guardar segmentos falla **3**
  veces seguidas, ENTONCES DEBERÁ pausar con el motivo `store-failed` en vez de
  seguir acumulando.

### 18. La transcripción y su purga (D-239 §3)

- **AS-056** — CUANDO el profesional de la atención pida la escucha de su
  atención, el sistema DEBERÁ responder el estado de la sesión —estado, reloj,
  motivo de la pausa y si un canal está capturando— y los segmentos en orden de
  inicio; a cualquier otro, lo mismo que AS-045.
  > La transcripción es texto clínico y sólo la ve quien escucha (D-247 §3).
- **AS-057** — El sistema DEBERÁ borrar los segmentos de una atención **45
  días** después de la primera firma de su nota, y, firmada o no, los que
  tengan más de **90 días** desde que se guardaron; al arrancar y una vez al
  día, con el reloj de la aplicación.
  > D-239 §3; el tope de 90 días para una atención que nunca se firma es la
  > misma recomendación que D-241 §6, pendiente del autor (D-247 §2).
- **AS-058** — Ninguna línea de log, mensaje de error ni fila fuera de
  `transcript_segment` DEBERÁ contener texto de la transcripción ni audio: los
  motivos son códigos, y el canal sólo manda la transcripción al profesional
  que escucha.
  > SigmAI A-03 (26 sitios registraban la transcripción en `error.message`).

### 19. En la consulta

- **AS-059** — MIENTRAS la cuenta tenga `assistant:use`, sea la del profesional
  de la atención y la atención admita contenido nuevo, la consulta DEBERÁ
  ofrecer «Escuchar»; con la escucha abierta, DEBERÁ mostrar su estado
  —«Escuchando» con el tiempo, «En pausa» con su motivo—, «Pausar»,
  «Reanudar» y «Detener», y la transcripción en la pestaña Nota a medida que
  llega cada línea. SI la escucha responde 404, ENTONCES NO DEBERÁ mostrar nada
  de ella.
- **AS-060** — CUANDO el canal se corte sin que el médico lo pida, la pantalla
  DEBERÁ seguir capturando en memoria —como mucho **60 s**—, pedir un vale
  nuevo, reconectar y mandar lo capturado desde el reloj que responde el
  servidor; y SI no lo logra en ese tiempo, ENTONCES DEBERÁ soltar el
  micrófono y decir que la escucha quedó en pausa por la conexión, con
  «Reanudar».
  > Lo que el servidor ya tenía lo descarta él (AS-049), así que reenviar de
  > más no duplica; lo que se dijo durante el corte no se pierde.
- **AS-061** — DONDE la interfaz se arranque con
  `NUXT_PUBLIC_LISTENING_TEST_AUDIO`, la escucha DEBERÁ tomar ese audio
  inventado en vez del micrófono, al ritmo real, y DEBERÁ decir «Audio de
  prueba» junto al control; sin la variable, sólo el micrófono.
  > Para probar la escucha sin micrófono (recorridos y la prueba del autor).
  > El audio es una consulta inventada, generada con la voz sintética del
  > sistema: ningún dato de un paciente.
- **AS-062** — El guion `pnpm listening:measure` DEBERÁ reproducir E-031 contra
  la API en marcha: seis frases inventadas al ritmo real, una pausa, un corte
  del canal con la última frase dentro del reconocedor, la reconexión y la
  detención; y DEBERÁ informar cuántas frases se dijeron, cuántos segmentos
  quedaron, cuántos se repiten y si están en orden.

---

## Códigos de error nuevos

| Código                               | Clase base             | HTTP      | Cuándo                                                                       |
| ------------------------------------ | ---------------------- | --------- | ---------------------------------------------------------------------------- |
| `ASSISTANT_NOT_CONFIGURED`           | `ExternalServiceError` | 502       | La cadena está vacía (AS-006)                                                |
| `ASSISTANT_PROVIDER_FAILED`          | `ExternalServiceError` | 503 / 502 | Ningún proveedor respondió (reintentable, AS-007) o el modelo falló (AS-008) |
| `SUGGESTION_ALREADY_DECIDED`         | `ConflictError`        | 409       | La propuesta ya se aceptó o se descartó (AS-023)                             |
| `SUGGESTION_NOT_FOUND`               | `NotFoundError`        | 404       | La propuesta, o su atención, no existe o está fuera del alcance (AS-021)     |
| `SUGGESTION_INVALID`                 | `ValidationError`      | 422       | Fuentes que no son un lugar conocido, o aceptar sin nada guardado (AS-020)   |
| `ASSISTANT_SPENDING_CEILING_REACHED` | `QuotaExceededError`   | 429       | El techo del mes no admite el intento, o no hay techo (AS-017)               |
| `ASSISTANT_NOTE_EMPTY`               | `ValidationError`      | 422       | La nota de la atención no tiene texto del que leer problemas (AS-028)        |
| `ASSISTANT_NOT_ENCOUNTER_OWNER`      | `ForbiddenError`       | 403       | Quien pide no es el profesional de la atención (AS-039)                      |
| `SUGGESTION_DIAGNOSIS_MISMATCH`      | `ValidationError`      | 422       | El diagnóstico con que se acepta no es de esa atención o no está (AS-037)   |
| `ASSISTANT_ENCOUNTER_NOT_FOUND`      | `NotFoundError`        | 404       | La atención no existe o es de una sede fuera del alcance (AS-039, EN-121)    |
| `ASSISTANT_ENCOUNTER_CLOSED`         | `ConflictError`        | 409       | La atención ya no admite contenido clínico nuevo (AS-039)                    |
| `ASSISTANT_PROPOSAL_NOT_KEPT`        | `ExternalServiceError` | 503       | El modelo respondió pero su intento no quedó en `ai_run` (AS-036, AS-040)    |
| `ASSISTANT_READING_IN_PROGRESS`      | `ConflictError`        | 409       | Ya hay una lectura de esa atención en curso (AS-040)                         |
| `ASSISTANT_PSEUDONYMIZER_FAILED`     | `ExternalServiceError` | 503 / 502 | `clinica-ai` no respondió (reintentable) o respondió fuera de contrato (AS-033) |
| `ASSISTANT_LISTENING_UNAVAILABLE`    | `ExternalServiceError` | 503       | `clinica-ai` no puede escuchar: sin reconocedor, sin detector de voz, caído u ocupado (AS-048) |
| `ASSISTANT_LISTENING_NOT_OPEN`       | `ConflictError`        | 409       | Una orden de pausar o una trama sin escucha abierta en ese canal (AS-049) |

## Niveles de prueba

| Requisito                              | Nivel                                                                |
| -------------------------------------- | -------------------------------------------------------------------- |
| AS-001                                 | Tipos (`@ts-expect-error`, lo comprueba `tsc`) y recorrido de `src/` |
| AS-002 a AS-010                        | Unitario, con `fetch` y proveedores falsos                           |
| AS-015 (al arrancar y cada día)        | Unitario del módulo con reloj falso                                  |
| AS-011, AS-012, AS-014, AS-015, AS-017 | Integración contra PostgreSQL, con control positivo                  |
| AS-020 a AS-024 (la base)              | Integración contra PostgreSQL, con control positivo                  |
| AS-022 (el cálculo)                    | Unitario del dominio                                                 |
| AS-013, AS-016, AS-018, AS-019         | Unitario (AS-018 sobre `pruneToAllowlist`)                           |
| AS-025, AS-028, AS-035, AS-036, AS-039, AS-040, AS-041 | Unitario con seudonimizador y proveedor falsos |
| AS-026, AS-027, AS-036, AS-037, AS-038 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-042 | Arnés (`eval/`), fuera del verify |
| AS-043, AS-044 | Componente de la pestaña y recorrido F-04 |
| AS-045, AS-046, AS-047, AS-056 | Integración HTTP y del canal contra PostgreSQL, con control positivo |
| AS-048, AS-049, AS-050, AS-051, AS-054, AS-055, AS-058 | Unitario con reconocedor y reloj falsos; AS-051 también de punta a punta en la integración |
| AS-052, AS-053 (la base), AS-057 | Integración contra PostgreSQL, con control positivo |
| AS-053 (el código) | Recorrido de los archivos de la escucha |
| AS-059, AS-060, AS-061 | Componente y composable; recorrido F-04 con el audio de prueba |
| AS-062 | Guion contra la API y `clinica-ai` en marcha, fuera del verify |
| AS-030 a AS-034                        | Unitario con `fetch` falso; AS-031 y AS-032 sobre `env.schema`; prueba manual contra `clinica-ai` en marcha |

## Preguntas abiertas

Todas en **D-241**: el monto del techo, el plazo del texto sin atención, qué
fallos activan el respaldo, los modelos de OpenAI, el tope para atenciones sin
firma, cuánto se guarda `ai_run`, si los intentos rechazados cuentan en el
techo, la reserva con varias instancias y la retención en cada proveedor.
En **D-243**: si las propuestas salen en un derecho de acceso y cuánto se
guarda la descartada. En **D-247**: escuchar sin la autorización de grabar
hasta A3, el tope de 90 días de una transcripción sin firma, quién ve la
transcripción, el léxico de la clínica y el estado de la escucha en una sola
instancia de la API.
