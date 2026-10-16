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
  purga;
- el **borrador de la nota** (C2): cada borrador pedido en `note_draft`, su
  redacción desde la transcripción y sus secciones propuestas en
  `ai_suggestion`;
- las **preguntas para completar la nota** (C3): cada revisión en
  `note_question_check` y sus preguntas en `ai_suggestion`.
- la lectura de los **signos dictados** (B2): la transcripción de un dictado
  corto y su lectura en una propuesta para las casillas de la toma, sin
  guardar nada.
- lo que pasa **al firmar** (E1): firmar no se admite mientras se escucha o
  se redacta; al firmar se detiene la escucha, se cancelan los borradores en
  curso y cada sección propuesta queda revisada en `ai_suggestion_review`, con
  la distancia a lo que la nota firmada dice.

**Fuera de alcance:**

- **El seudonimizador**: es A5 (`clinica-ai`). Hasta que exista, ningún
  código de producción puede fabricar un `PseudonymizedText`, y por tanto
  ninguno llama a un proveedor (AS-001).
- **El interruptor por sede y el permiso `assistant:use`**: es A3. Este módulo
  no expone ninguna ruta HTTP; quien la exponga declara su permiso (REQ-118).
- Escribir en la nota: la sección aceptada la guarda la pantalla por la ruta
  de la nota, con su `If-Match` (EN-281); el asistente sólo enlaza (P1).
- Distinguir la voz del médico de la del paciente (dato biométrico, plan §3).

**Depende de:** la configuración (`shared/config`) y la base. `encounter`
depende de él por un solo puerto de `shared/clinical`
(`ASSISTANT_AT_SIGNING`, E10): antes de firmar pregunta qué está en marcha y,
después, avisa de la firma.

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

### E6 — La receta propuesta desde la consulta _(D2, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 D2 y §3 («Receta»): con «Proponer la receta», el
modelo lee la nota y dice qué se recetó tal como se escribió; el sistema lo
busca en el CNMB con su forma y su concentración, el modelo elige entre lo que
la búsqueda encontró y una barrera quita lo que el cuadro no tiene (P5). Las
alergias se comparan **después del modelo y sin él**, con la misma regla que
la emisión (PR-060, PR-065, PR-114), y si no se pueden comprobar la propuesta
**falla cerrada** (P5, bug F-01 de SigmAI). Nada se escribe sin el médico:
«Confirmar la receta» pone las líneas aceptadas en el borrador de siempre, que
se guarda por su ruta con su `If-Match` (PR-100, PR-121), y **nunca lo emite**
(P1).

**Por qué va así:** SigmAI midió en E-072 un acierto del mapeo de 73,2 % con
Sonnet, y 27 de sus 45 errores fueron abstenciones ante un nombre sin
concentración; el CNMB trae forma y concentración por presentación (PR-115),
que es lo que esta entrega añade. El bucle de herramientas y MCP no se traen
(E-072: +4,2 puntos sin significancia, 4,6× la latencia).
**Prueba independiente:** con el seudonimizador y el proveedor falsos, una
nota que dice «Amoxicilina 500 mg, una tableta cada 8 horas por 7 días»
propone `J01CA04` en su presentación de 500 mg con la cantidad 21 marcada
«Nadie lo dijo»; con una alergia a la amoxicilina en la ficha la línea sale
con el aviso y no se puede confirmar; con el lector de alergias caído no sale
ninguna línea; confirmar devuelve las líneas sin escribir nada, y guardar el
borrador las enlaza.
**Cubre:** AS-063 a AS-082.
**Solo servidor:** AS-078 (lo que no llega al log) y AS-079 (el arnés de
evaluación, fuera del verify).
**Solo interfaz:** AS-080 a AS-082. Son la tarjeta de la propuesta en la
pestaña Receta y su paso al editor; la mitad del servidor es AS-063, AS-069,
AS-070 y AS-073, que ya se prueban con esos números.

### E7 — El borrador de la nota con su fuente _(C2, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 C2 y §3 («Redactor con procedencia»): mientras la
consulta se escucha, el asistente redacta la nota en la plantilla con que se
abrió —la de la especialidad del profesional (D-124)—, cada frase con el minuto
de la conversación que la dice, y lo que nadie dijo marcado. Se rehace cada 3
minutos de conversación y al detener la escucha. El médico lo compara lado a
lado con lo que ya escribió y acepta o descarta cada sección; aceptar escribe en
el borrador de la nota por su ruta de siempre, con `If-Match`, y **no firma**.
Se trae de SigmAI el redactor medido (`note-writer.adapter.ts`, estilo
`written`, respuesta por objetos: E-049, 0 secciones inventadas y 105/108
hechos) y se corrige su R-02: un borrador a la vez **por atención**, no para
todas.

**Por qué va así:** P1 y P2. El error típico de un escriba es la omisión y la
invención (UC Davis 2026: 18 % y 11,5 %); la procedencia por frase y «Nadie lo
dijo» son lo que deja al médico revisar en segundos en vez de releer la
consulta.
**Prueba independiente:** con la transcripción de una consulta inventada, el
seudonimizador y el proveedor falsos, el borrador trae «Enfermedad o problema
actual» con cada frase en su minuto y una frase sin marcador marcada «Nadie lo
dijo»; ninguna sección de lista ni fuera de la plantilla; aceptar «Motivo de
consulta» con la nota guardada la deja «aceptada» enlazada a esa nota, que
sigue en borrador y sin firma.
**Cubre:** AS-086 a AS-102.
**Solo servidor:** AS-087 (lo pide la escucha), AS-091, AS-092, AS-093, AS-095
(lo que no llega al log) y AS-098 (el arnés, fuera del verify). La pantalla
los ve como AS-096 y AS-100.
**Solo interfaz:** AS-100, AS-101 y AS-102. Son el bloque «Borrador del
asistente» en la pestaña Nota, aceptar escribiendo en la nota y releer al oír
el evento; su mitad del servidor es AS-086, AS-094, AS-096 y AS-097, que ya se
prueban con esos números.

### E8 — Los exámenes pedidos en la consulta _(D3, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 D3: lo que el médico pide en la nota o en voz alta
(la transcripción de C1) llega a la pestaña Exámenes con la frase que lo pide y
hasta 5 candidatos del **catálogo de servicios de la clínica** (ADR-013: un
`Service` de tipo `LAB_EXAM` o `IMAGING` con su extensión de orden). El médico
elige uno y **él** lo añade a la orden en borrador por la ruta de siempre, con
su `If-Match` (ORD-181); el asistente nunca compone, guarda ni emite una orden
(P1), y un examen que la clínica no tiene no se muestra nunca (P5).

**Por qué va así:** la orden de la clínica se escribe con su propio catálogo
(BI-284), no con un vocabulario externo, y es corto: el modelo elige de la
lista entera numerada en un solo intento (P6, buscar y elegir; ninguna
herramienta). La barrera es el número: sólo cuenta uno que se le ofreció.
**Prueba independiente:** con el seudonimizador y el proveedor falsos, una
nota que dice «Se solicita biometría hemática y glucosa en ayunas» propone dos
líneas con su frase y `LAB-BH` y `LAB-GLUCOSA-AYUNAS` entre sus candidatos; un
número que no estaba en la lista no aparece; «Trae biometría hemática previa»
no propone nada; guardar el borrador con `LAB-BH` y enlazar deja la propuesta
«aceptada» con distancia 0, y enlazar con una orden de otra atención se
rechaza.
**Cubre:** AS-103 a AS-117.
**Solo servidor:** AS-113 (lo que no llega al log) y AS-114 (el arnés de
evaluación, fuera del verify).
**Solo interfaz:** AS-115 a AS-117. Son el bloque «Propuesta del asistente» de
la pestaña Exámenes y su paso al borrador; la mitad del servidor es AS-103,
AS-106, AS-108 y AS-109, que ya se prueban con esos números.

### E9 — «Para completar la nota» _(C3, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 C3: en la pestaña Nota, lo que todavía falta. Dos
capas, como en SigmAI (`modules/drafting/questions.ts`, RC-20): la primera
**sin modelo** —las secciones de la plantilla que siguen vacías, que se ven
también con el asistente apagado—; la segunda, hasta **5 preguntas** que el
médico todavía podría hacer, cada una con la línea de la conversación que la
motiva, pedidas **a demanda o al detener la escucha** y nunca como
interrupción. Una pregunta deja de verse cuando la nota ya la responde. Nada
de esto entra en la nota ni impide firmar (P1, P8).

**Por qué va así:** el error típico de un escriba es la omisión (UC Davis 2026:
18 % de las notas). Lo que la plantilla pide y está vacío no necesita modelo;
lo que la conversación dejó a medias, sí, y una pregunta cuya razón el médico
no puede comprobar es peor que ninguna: sin su línea no se muestra, como un
código que no está en el catálogo (P5).
**Prueba independiente:** con la nota abierta y «Motivo de consulta» escrito,
«Para completar la nota» nombra las demás secciones vacías, con el asistente
apagado; con la transcripción del audio de prueba, el seudonimizador y el
proveedor falsos, «Sugerir preguntas» trae preguntas, cada una con su línea y
su minuto, y ninguna cuya línea no se dio; escrita en la nota la respuesta de
una, la revisión siguiente ya no la trae.
**Cubre:** AS-118 a AS-133.
**Solo servidor:** AS-124 (lo que no llega al log), AS-126 (el arnés, fuera del
verify) y AS-127 (el guion). La pantalla los ve como AS-123 y AS-129.
**Solo interfaz:** AS-118, AS-129 a AS-133. Son el bloque en la pestaña Nota,
pedir al detener y revisar de nuevo al escribir; su mitad del servidor es
AS-119, AS-122 y AS-123, que ya se prueban con esos números.

### E10 — Revisión al firmar _(E1, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 E1 y D-247 §7: firmar es declarar que la nota está
terminada, y no lo está mientras el asistente sigue oyendo la consulta o
escribiendo su borrador. Firmar se niega entonces, y la pantalla dice por qué
junto al botón (SigmAI U-03: «Firmar» se bloqueaba sin decir por qué). Al
firmar, lo que el asistente tenía en marcha se detiene —la escucha, los
borradores en cola o redactándose— y cada sección que propuso queda revisada:
qué hizo el médico con ella y cuánto se parece lo que firmó a lo propuesto. Es
lo que la fase F y el tablero de E2 miden (SigmAI RF-I02, `note-distance.ts`).

**Por qué va así:** P1. La firma es el acto del médico; nada del asistente
puede seguir escribiendo en una atención firmada ni gastando en ella. La
distancia se calcula en el servidor y contra la nota firmada, no contra lo
que la pantalla dice: es un dato del sistema para el estudio.
**Prueba independiente:** contra PostgreSQL, una atención con borrador de dos
secciones —una aceptada y retocada después, otra sin decidir—: firmar con un
borrador en cola se rechaza; dejar de esperarlo lo deja cancelado; firmar
entonces detiene la escucha y deja dos revisiones con la nota firmada, su
estado y una distancia mayor que cero en la retocada; una revisión de una nota
sin firmar se rechaza.
**Cubre:** AS-140 a AS-152.
**Solo servidor:** AS-143 (lo que corre al firmar), AS-145 (la base) y AS-146
(lo que no llega al log). La pantalla los ve como AS-148 y AS-150.
**Solo interfaz:** AS-148, AS-149, AS-150 y AS-152. Son «Firmar…» deshabilitado con su
motivo, el rechazo dicho en el diálogo y lo que queda tras firmar; su mitad del
servidor es AS-140, AS-141 y AS-147, que ya se prueban con esos números.

### E11 — El interruptor por sede y la autorización de grabar _(A3, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 A3, P7 y D-221 §3. Cada sede enciende o apaga el
asistente en **Parámetros por sede** (D-254 §1: la pantalla «Funciones» de
D-207 §7 aún no existe); con la sede apagada ninguna ruta del asistente
responde sobre sus atenciones y el médico no ve nada de IA. Grabar la consulta
para el asistente es una **autorización opcional y revocable** más de D-221
§3: recepción la registra junto al teléfono en la ficha o al registrar la
llegada, y el médico de la atención cuando el paciente se la da en el
consultorio (D-254 §3). Sin ella no se escucha, y «Escuchar» dice por qué.
Las demás funciones, que leen lo que el médico escribió, obedecen sólo al
interruptor (D-254 §6).

**Por qué va así:** P7 —medir antes de encender, por sede— y LOPDP art. 7 y
8: grabar la voz del paciente para mandarla a un proveedor no es atenderlo
(art. 31.1 no lo cubre), así que pide su autorización, que puede revocar.
Un 404 y no un 403 en una sede apagada, como AS-026: la pantalla no debe
saber que existe.
**Prueba independiente:** contra PostgreSQL, una sede apagada: el CIE-10, la
escucha y el borrador de una atención suya responden 404, y los de otra sede
encendida responden (control); un vale de escucha sin autorización se rechaza
con `ASSISTANT_RECORDING_NOT_AUTHORIZED` y, registrada por el médico desde la
atención, se da; revocada con el canal abierto, la escucha se detiene.
**Cubre:** AS-160 a AS-175.
**Solo servidor:** AS-161 (la base), AS-163 y AS-166 (el canal). La pantalla
los ve como AS-171 y AS-174.
**Solo interfaz:** AS-170 a AS-175. Son el interruptor en Parámetros, la
atención sin IA, el interruptor de la ficha y de la llegada y «Escuchar» sin
autorización; su mitad del servidor es AS-160, AS-162, AS-164, AS-165, AS-167
y AS-168, que ya se prueban con esos números.

### E12 — La historia sin modelo _(B1, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 B1: de un vistazo y **sin modelo de lenguaje**, lo
que el médico necesita antes de hablar. En la pestaña Historia de la consulta,
los resultados de laboratorio **del paciente** —no sólo de esta atención— con
el rango y la bandera con que el laboratorio los informó, lo fuera de rango
marcado; los medicamentos recetados, activos o terminados y desde cuándo; y una
línea de tiempo que junta, por día, las visitas, los medicamentos que empiezan
o terminan y los resultados fuera de rango. En Evolución, las tendencias de los
exámenes junto a las de los signos, con la misma gráfica (D-214, D-226 §3).
Se adapta `modules/history/` de SigmAI (`timeline.ts`; E-066: P95 12 ms). Su
`reference-range.ts` **no** se trae: aquí el rango y la bandera se guardan
estructurados en cada resultado (ORD-035 a ORD-038, ORD-122) y se muestran
tal cual, sin volver a leer texto.

**Por qué va así:** la pestaña Historia decía «sólo las de esta atención: las
anteriores todavía no llegan al resumen del paciente». Un resultado de hace
tres meses que el médico no ve es un examen que se repite o una anemia que no
se sigue. Sin modelo no hay omisión que medir (E-067 apagó el resumen con
modelo por omitir fármacos activos): la lista es la de la base, entera hasta
su tope y con el total dicho.
**Prueba independiente:** contra PostgreSQL, una ficha con una ficha absorbida,
dos sedes, una atención anulada, un informe corregido y otro cancelado, una
receta anulada y otra con un medicamento de 7 días: la historia trae los
resultados vigentes de las dos fichas y de las sedes de quien mira, con las
mismas cifras, rango y bandera que el informe de su orden; nada de la atención
anulada, del informe sustituido o cancelado, ni de la receta anulada; el
medicamento sale activo hasta el séptimo día y terminado después; y la
lectura queda en la bitácora una vez.
**Cubre:** AS-200 a AS-216.
**Solo servidor:** AS-207 (el tope y la bitácora). La pantalla lo ve como
AS-212.
**Solo interfaz:** AS-210 a AS-216. Son las pestañas de Historia, la línea de
tiempo y las tendencias de Evolución; su mitad del servidor es AS-200 a
AS-206, que ya se prueban con esos números.
### E13 — Signos dictados _(B2, 12-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 B2: en la pestaña Signos, enfermería (en la
preparación, F-03) o el médico (en la consulta, F-04) pulsa **«Dictar»**, dice
«presión 120 sobre 80, pulso 72, temperatura 36 y medio…» y las casillas se
llenan como **propuesta**: nada se guarda sin «Guardar». La lectura es la de
SigmAI (`modules/vitals/dictation.ts` y `plausibility.ts`), copiada tal cual:
**determinista, sin modelo de lenguaje**; el audio lo transcribe `clinica-ai`
en esta máquina y no se guarda nunca. Lo que no se entiende con certeza —sin
número, dudado, imposible— no se propone: se marca para teclearlo.

**Por qué va así:** el vocabulario de los signos es cerrado y SigmAI midió que
un intérprete de reglas basta (E-055: 93,9 % de los valores sin ruido, 0
graves, sin llamar a ningún modelo), así que no hay texto que seudonimizar ni
proveedor que esperar. Un valor mal leído es peor que una casilla vacía: la
casilla vacía la ve quien guarda; el 170 leído por 117, no.
**Prueba independiente:** con `clinica-ai` en marcha y el audio de prueba,
«Dictar» y «Terminar» en la pestaña Signos llenan presión, pulso, temperatura,
saturación, peso y talla con su marca de propuesta, la frecuencia respiratoria
dicha «trescientos» queda marcada sin valor, y la toma no existe en la base
hasta «Guardar»; el arnés da ≥ 93 % y 0 graves sobre el set inventado.
**Cubre:** AS-180 a AS-196 y AS-198 (AS-197 quedó muerto).
**Solo servidor:** AS-184 (lo que no se guarda ni llega al log), AS-187 (el
catálogo y los roles) y AS-188 (el arnés, fuera del verify). La pantalla los ve
como AS-191.
**Solo interfaz:** AS-189 a AS-195 y AS-198. Son el botón, la grabación, las marcas de
propuesta y los fallos en la pestaña Signos; su mitad del servidor es AS-180,
AS-182, AS-185 y AS-186, que ya se prueban con esos números.

### E14 — La preparación escuchada _(B3, 13-10-2026)_

`PLAN-ASISTENTE-IA.md` §7 B3 y la decisión del autor del 13-10-2026: las
reglas de B2 no entienden cada forma de dictar («presión sistólica 120,
presión diastólica 100», «talla 160, perímetro cefálico 48…») y en la
preparación el motivo lo dice el paciente. En la pestaña Signos, quien
prepara pulsa **«Escuchar»**: la misma escucha de C1, en un ámbito propio y
con la autorización de grabar; al **«Detener»**, el asistente lee la
conversación seudonimizada y propone cada medida y el motivo, **cada uno con
su frase y con quién la dijo**, deducido por lo que se dice y nunca por la
voz. Las barreras son código (P5): un número que no está en su frase no se
propone, la plausibilidad de B2 sigue, y sin proveedor se lee con las reglas.

**Por qué va así:** la huella de voz quedó descartada (`PLAN-ASISTENTE-IA.md`
§3: 85,8 % y dato biométrico), y lo que hacía preferir las reglas era que un
modelo puede escribir un número que nadie dijo: aquí el número lo pone la
frase, no el modelo.
**Prueba independiente:** con `clinica-ai` en marcha, el modo de
demostración y el audio de prueba, «Escuchar» y «Detener» en la pestaña Signos
de un paciente con la autorización llenan las casillas como propuesta, cada
una con su frase y su hablante, y el motivo con la frase del paciente; sin
autorización, «Escuchar» dice por qué y «Dictar» sigue; el arnés da 0 números
fuera de su frase.
**Cubre:** AS-240 a AS-259.
**Solo servidor:** AS-242 (lo que no leen el borrador, las preguntas ni la
firma), AS-252 (lo que no se guarda ni llega al log) y AS-255 (el arnés, fuera
del verify). La pantalla los ve como AS-257.
**Solo interfaz:** AS-256 a AS-259. Son «Escuchar», la propuesta con su
procedencia, los hablantes y los fallos en la pestaña Signos; su mitad del
servidor es AS-240, AS-243, AS-245 y AS-251, que ya se prueban con esos
números.
### E15 — El asistente llena como lo haría el médico _(13-10-2026)_

El autor leyó el libreto de la amigdalitis con el modelo real y pidió cinco
cosas: las alergias y los antecedentes dichos llegan como **registros** de sus
tablas y no como prosa (corrige D-249 §1, D-261); cada código CIE-10 se
registra **de un toque** y sin códigos de síntoma sueltos; la receta llega
**completa** —concentración, presentación, forma, vía, dosis y unidad— con lo
deducido marcado «Nadie lo dijo»; cada medicamento pasa al borrador de la
receta **con un solo ✓**; y una pregunta no vuelve con otra redacción.

**Por qué va así:** un toque no quita el acto del médico (P1): registra por la
misma ruta y con las mismas validaciones que el botón de hoy, con el médico
como autor, y nada se registra sin él. Lo que la conversación no dijo y el
sistema deduce del CNMB se escribe, pero se marca: el médico ve qué revisar.
**Prueba independiente:** con el modo de demostración, el libreto produce en
Antecedentes «Sin alergias conocidas» e «Hipertensión arterial · Madre» con ✓;
en Diagnósticos J03.9 de un toque y ningún código R; en Receta la amoxicilina
500 mg cápsula oral, 1 cápsula cada 8 horas 7 días, y el paracetamol 500 mg
tableta oral, 1 tableta cada 8 horas, con la vía y la tableta marcadas «Nadie
lo dijo»; y cada ✓ los deja registrados o en el borrador de la receta.
**Cubre:** AS-260 a AS-279.
**Solo servidor:** AS-262 (las barreras de lo leído), AS-266 (la base enlaza
el registro de la ficha) y AS-277 (el arnés, fuera del verify). La pantalla los
ve como AS-263 y AS-265.
**Solo interfaz:** AS-261, AS-268, AS-271, AS-274 y AS-279. Son los ✓ de
Antecedentes, Diagnósticos y Receta, las marcas de lo deducido y el teléfono; su mitad del
servidor es AS-263, AS-265, AS-037, AS-267, AS-269, AS-270, AS-272, AS-073 y AS-275, que ya se prueban con esos números.

### E16 — La talla dicha con «y» y el motivo redactado _(13-10-2026)_

Lo que vio el autor al probar «Escuchar» con el modelo real (13-10-2026): el
reconocedor escribió «ciento cincuenta y ocho» como «150 y 8» y la barrera
dejó la talla en ámbar, porque «158» no está en la frase; y el motivo salió
literal, con su «Ay, señorita». La forma «decena y unidad» se lee como un
número antes de la barrera, con una regla del código, y el motivo se
propone redactado como lo escribe la enfermera, con la frase del paciente
como fuente y las mismas barreras de los signos (D-263).

**Por qué va así:** la regla es determinista, así que el número sigue sin
salir del modelo; la redacción sí sale del modelo, y por eso sólo se cree si
cada palabra, número y negación que lleva está en la frase; si no, se
propone la frase entera, como antes.
**Prueba independiente:** con el modo de demostración, el guion de Rosa
(«…la talla 150 y 8 centímetros…», «Ay, señorita, tengo un dolor de
cabeza…») propone la talla 158 con su frase y el motivo sin «Ay, señorita»,
con «Paciente · 00:07 «…»» debajo; «presión 120 y 80», «36 y medio» y «18 y
97» siguen siendo lo que eran; y el arnés da 0 números fuera de su frase.
**Cubre:** AS-280 a AS-286.
**Solo servidor:** AS-284 (el arnés, fuera del verify).
**Solo interfaz:** AS-285 y AS-286. Son la casilla «Motivo de consulta» y la
fuente del motivo en la pestaña Signos; su mitad del servidor es AS-282, que
ya se prueba con ese número.

### E17 — Lo que la prueba de Carmen enseñó _(16-10-2026)_

El autor corrió el libreto de Carmen Hidalgo (cistitis aguda) con el modelo
real y ocho cosas salieron mal, cada una con su causa en los registros: la
impresión diagnóstica dicha no llegaba a Diagnósticos, un antecedente de la
ficha escrito de otro modo se proponía otra vez, «siga con su losartán» salía
como receta, «3/10» se leía como una fecha no dicha, el motivo se cortaba en
la primera línea del paciente, una FR dicha «frecuencia cardíaca» se perdía
sin aviso, las preguntas respondidas seguían a la vista y el certificado dicho
no se proponía (D-265 §2 y §4).

**Por qué va así:** cada arreglo es una barrera o una regla en la máquina, sin
llamadas nuevas al modelo; lo dudoso se muestra con su aviso y nunca se guarda
solo (P1, P5).
**Prueba independiente:** con la transcripción de Carmen, la preparación
propone el motivo de tres líneas y la FR 16 en ámbar; Antecedentes dice «Ya
consta como HIPERTENSO»; Diagnósticos propone «Cistitis aguda» con sus
síntomas como «Incluye»; Receta no trae losartán ni anticonceptivos; y
Certificados propone «Reposo · 1 día» con su frase.
**Cubre:** AS-290 a AS-301.
**Solo servidor:** AS-301 (el arnés, fuera del verify).
**Solo interfaz:** AS-293, AS-296, AS-298 y AS-300. Su mitad del servidor es
AS-292, AS-295, AS-122 y AS-299.

## Criterios de éxito

- **SC-089** — Con `ASSISTANT_ALLOW_REMOTE` distinto de `true`, el número de
  peticiones de red a un proveedor es **cero**, haya o no claves.
- **SC-090** — Ninguna fila de `ai_run`, línea de log ni mensaje de error del
  módulo contiene texto del prompt, de las instrucciones ni de la respuesta.
- **SC-091** — En el set simulado (`eval/casos/nota.json`, 10 consultas
  inventadas, 105 hechos) y en el reservado (`eval/casos/nota-reservada.json`,
  8 consultas que no se usan para ajustar el prompt), el borrador del producto
  trae **0 secciones inventadas** —ninguna fuera de la plantilla ni ninguna
  cuyas frases sean todas «Nadie lo dijo»— y **≥ 95 %** de los hechos
  esperados de las secciones que escribe (E-049: 105/108), con el proveedor
  principal. Los hechos de diagnóstico se informan aparte: el borrador no
  escribe diagnósticos (D-249 §2 y §10).
- **SC-092** — En esa misma corrida, el **p90** de lo que tarda un borrador es
  **≤ 15 s** (plan §5).

- **SC-093** — En el set simulado (`eval/casos/nota.json`) y en el reservado,
  con el proveedor principal: **0** preguntas mostradas sin su línea, y, en la
  revisión a mano de cada pregunta mostrada, **≤ 10 %** que pregunten lo que la
  conversación ya respondió; y con la nota de referencia escrita (todos los
  hechos del caso en su sección), **≤ 10 %** que pregunten lo que la nota ya
  dice (D-253 §3).
- **SC-094** — En esa misma corrida, el **p90** de lo que tarda una revisión es
  **≤ 5 s** (plan §5, propuestas).

- **SC-095** — En los sets inventados de frases dictadas
  (`eval/casos/signos-dictados.json`, de desarrollo, y
  `eval/casos/signos-dictados-reservado.json`, escrito antes de medirlo y que
  no se usa para ajustar nada), dichos por voces sintéticas del sistema sin ruido y
  transcritos por `clinica-ai`, la lectura del producto llena **≥ 93 %** de
  los valores esperados con el valor correcto (E-055: 93,9 %).
- **SC-096** — En esas mismas corridas y sobre el texto escrito de las mismas
  frases: **0 graves** — ninguna casilla con un valor distinto del dicho y
  ninguna llenada sin que se dijera.
- **SC-097** — Sobre la base de demostración de la rama, con una ficha de
  60 atenciones, 300 resultados y 60 recetas, el **P95** de 50 lecturas de la
  historia (`GET /v1/patients/:id/clinical-history`, API en marcha y sin
  caché de la aplicación) es **< 100 ms** (plan §7 B1; SigmAI E-066: 12 ms).
- **SC-098** — En esa misma ficha y en la prueba contra PostgreSQL, el
  **100 %** de los resultados de la historia tiene el mismo valor, unidad,
  rango y bandera que el informe vigente de su orden
  (`GET /v1/orders/:id/reports`), y ninguno es de otra persona (PA-055).

- **SC-099** — En el set inventado de preparaciones
  (`eval/casos/preparaciones.json`) y en el reservado de B2, escrito y oído,
  con el proveedor principal: **0** valores propuestos cuyo número dicho no
  esté literalmente en su frase, ni frases que no estén en su línea.
- **SC-100** — En esas corridas, **≥ 95 %** de los valores esperados con el
  valor correcto y **0 graves** —ninguna casilla con un valor distinto del
  dicho y ninguna llenada sin que se dijera—, en el texto escrito y en lo
  oído sin ruido con voces sintéticas; y el **p90** de la lectura tras
  «Detener» **≤ 5 s**.
- **SC-101** — En esas corridas, el motivo propuesto es la frase del
  paciente esperada en **≥ 90 %** de las preparaciones que lo dicen (y ninguno
  en las que no), y el hablante de cada línea es el esperado en **≥ 90 %** de
  las líneas.
- **SC-102** — En el set inventado de recetas leídas de la nota
  (`eval/casos/receta-notas.json` y el libreto con sus tres variantes), con el
  proveedor principal, **≥ 95 %** de los campos dichos o deducibles de cada
  línea —concentración, presentación, vía, dosis y unidad— llenos y
  correctos, y **0** campos llenos que no se dijeron ni se deducen (los
  deducidos, todos marcados «Nadie lo dijo»).
- **SC-103** — En el set de problemas de la nota (el libreto, sus tres
  variantes y los casos de D1 con un diagnóstico definido), con el proveedor
  principal, **0** códigos del capítulo XVIII (R00–R99) propuestos cuando la
  nota trae un diagnóstico definido que los explica.
- **SC-104** — En el set inventado de conversaciones con antecedentes (el
  libreto, sus tres variantes y las consultas de `nota.json` que los dicen),
  con el proveedor principal, **≥ 90 %** de las alergias, «sin alergias
  conocidas» y antecedentes personales y familiares dichos, propuestos como
  registro con su línea, y **0** propuestos sin decirse.

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
  > Un examen, como un diagnóstico, es una elección entre candidatos: 0 si
  > lo guardado es uno de ellos (AS-109).
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

- **AS-043** — La pestaña Diagnósticos DEBERÁ mostrar cada propuesta del
  modelo en una fila con borde punteado y «Propuesta»: su problema, su frase,
  el código propuesto y una alternativa, con «Registrar <código>» —que abre
  «Registrar diagnóstico» con el código puesto y, al guardar, la enlaza— y
  «Descartar»; la línea base NO DEBERÁ verse como bloque fijo: DEBERÁ ser las
  primeras opciones del buscador de CIE-10 al enfocarlo vacío y, al escribir,
  las que coinciden, antes que las demás; y sin el permiso o con el asistente
  apagado NO DEBERÁ mostrar nada de esto.
  > Estándar de propuestas (ESTANDAR-UI §6 bis): borde punteado, «Propuesta»,
  > la procedencia una vez. Rediseño aprobado por el autor el 12-10-2026
  > (`fix/asistente-rediseno`): «los CIE-10 con frecuencia clínica me hacen
  > ruido visual».
- **AS-044** — MIENTRAS la lectura está en curso la pestaña DEBERÁ decirlo y
  seguir usable; y SI falla, ENTONCES DEBERÁ decir el motivo con «Volver a
  pedir», sin quitar las propuestas que ya había.

### 15. El seudonimizador local (A5)

- **AS-030** — CUANDO se pida seudonimizar un texto, el adaptador DEBERÁ
  enviarlo a `POST /v1/privacy/pseudonymize` de `clinica-ai` con la cabecera
  `Authorization: Bearer <ASSISTANT_AI_SERVICE_SECRET>`, y DEBERÁ devolver el
  texto como `PseudonymizedText` sólo si la respuesta cumple el contrato
  (`text`, `replacements[]` con `placeholder`, `original` y `kind`,
  `date_shift_days` entero) y no contiene ninguna palabra de tres letras o más
  de los `names` enviados (sin mayúsculas ni acentos, separadas también por
  guion, sin caracteres de formato), salvo los conectores que el servicio deja
  («dos», «van»…) y el nombre de un mes dentro de una fecha («17 de julio de
  2025»), que escribe el desplazamiento de fechas; y no contiene un correo ni
  una tira de 10 o 13 dígitos (cédula, móvil, RUC). Sólo `names`: los
  lugares y el personal no se comprueban aquí. Es el único sitio,
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
  `ASSISTANT_ENCOUNTER_CLOSED` (409). DEBERÁ preguntarlo otra vez al iniciar o
  reanudar y, mientras el canal está abierto, al menos cada **5 s**; y SI la
  atención deja de admitir contenido —firmada con su alta, anulada,
  interrumpida— con la escucha abierta, ENTONCES DEBERÁ detenerla, decírselo
  al canal (`stopped` con el código) y cerrarlo con **4409**, sin guardar nada
  más en ella.
  > Revisión del 12-10-2026 (grave): firmar el alta con la escucha abierta la
  > dejaba grabando, sin control en pantalla, en la atención cerrada — lo que
  > dijera el siguiente paciente habría quedado en la historia del anterior
  > (D-247 §7).
  > SigmAI M-02: cualquier médico escuchaba la consulta de otro. El vale se
  > pide por HTTP para que decidan los guardas de siempre (sesión, permiso,
  > sede, interruptor) y no una copia de ellos en el canal de audio. La misma
  > regla que D-245 §1 para el CIE-10.
- **AS-046** — El canal de audio NO DEBERÁ llevar ninguna credencial en la URL:
  el vale DEBERÁ llegar en el primer mensaje. SI no llega en **5 s**, es
  desconocido, caducó o ya se usó, ENTONCES el sistema DEBERÁ cerrar el canal
  con el código **4401** sin haber atendido nada. SI el navegador declara un
  `Origin` que no está en `CORS_ORIGINS`, ENTONCES DEBERÁ rechazar la apertura
  con 403; MIENTRAS `ASSISTANT_ENABLED` no sea `true`, DEBERÁ responder a la
  apertura con 404, como a una ruta que no existe; y DEBERÁ responder 404 y
  cerrar la apertura de cualquier otra ruta, y 429 a más de **20** canales sin
  vale de una misma dirección.
  > Con un oyente de `upgrade`, Node deja de cerrar las aperturas que nadie
  > atiende: quedaban abiertas para siempre (auditoría del 12-10-2026).
  > SigmAI ponía el token en la URL (`?token=`), que acaba en los registros de
  > acceso de cualquier proxy. Un navegador no puede poner cabeceras en un
  > WebSocket; el vale de un solo uso, pedido con la cabecera
  > `Authorization` de siempre, lo resuelve sin un segundo camino de entrada.
- **AS-047** — CUANDO caduque el token de acceso con que se pidió el vale, o
  pasen **15 min** desde que se abrió el canal, lo que llegue antes, el
  sistema DEBERÁ cerrarlo con **4401**, igual que un corte (AS-051).
  > Una sesión revocada o un permiso retirado dejan de escuchar en lo que dura
  > un token, sin que el canal tenga que preguntar a `auth`. La pantalla pide
  > otro vale —con el token renovado— y sigue sin perder nada (AS-060).
- **AS-048** — CUANDO el médico inicie o reanude la escucha, el sistema DEBERÁ
  comprobar en `clinica-ai` que el reconocedor **y el detector de voz** están
  instalados; SI falta alguno o el servicio no responde, ENTONCES DEBERÁ
  negarse con `ASSISTANT_LISTENING_UNAVAILABLE` y su motivo (`no-recognizer`,
  `no-voice-detection`, `unreachable`), sin abrir nada. SI
  `clinica-ai` dice que está ocupado o sin reconocedor después de abrir su
  canal, ENTONCES la escucha DEBERÁ quedar en pausa con `recognizer-failed`
  (AS-055).
  > P3 y E-028: sin detector de voz, whisper escribe sobre el silencio frases
  > que nadie dijo («Gracias por ver el video») y entrarían en la nota.
  > `clinica-ai` lo usa sólo si está instalado (CAI-010); la obligación la pone
  > este lado. Que está lleno sólo lo dice al aceptar el canal (`busy` y
  > cierre 1013), así que se sabe ya con la escucha empezada.

### 17. Sin pérdida ni duplicados (E-031)

- **AS-049** — La escucha de una atención DEBERÁ tener un reloj propio en
  milisegundos, guardado en `listening_session`; iniciar o reanudar DEBERÁ
  responder el reloj donde quedó y NO DEBERÁ volver a cero; cada trama DEBERÁ
  llevar su inicio en ese reloj. CUANDO llegue una trama, el sistema DEBERÁ
  descartar la parte que ya había recibido —la que acaba en el reloj o antes— y
  reenviar a `clinica-ai` sólo lo nuevo; DEBERÁ descartar una trama que empiece
  más de **2 s** por delante del reloj, y el audio que pase en más de **75 s**
  al tiempo transcurrido desde que la captura empezó o se reanudó; y DEBERÁ
  guardar el reloj al menos cada **5 s** de audio, sin pisar una pausa ya
  escrita.
  > Una trama muy adelantada movería el reloj por delante de todo lo real que
  > viene después; el audio más rápido que el habla sólo haría cola en whisper
  > para todas las consultas. Los 75 s cubren lo que la pantalla guarda
  > mientras reconecta (AS-060).
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
  `recognizer-failed` y decírselo al navegador, también cuando escribir la
  pausa falle; SI lo cierra por su tope de duración o de inactividad (1001)
  mientras se escucha, ENTONCES DEBERÁ abrir otro con la siguiente trama, con el
  mismo reloj y sin pausar; y SI guardar segmentos falla **3** veces seguidas,
  ENTONCES DEBERÁ pausar con el motivo `store-failed` en vez de seguir
  acumulando, y lo que no pudo guardar DEBERÁ intentarlo otra vez al pausar o
  detener.
  > Reabrir sólo con audio: un canal mudo no ocupa una de las 16 escuchas de
  > `clinica-ai` (auditoría del 12-10-2026).

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
  «Reanudar» y «Detener» en una sola píldora en la banda del paciente; y en la
  pestaña Nota, la transcripción en una sola línea —«Transcripción · N frases»
  con la última frase, que cambia a medida que llega cada línea— con «Ver
  todo», que abre la transcripción entera en una hoja lateral no modal que no
  se lleva el foco de la nota y sólo se cierra con su ✕. SI la escucha
  responde 404, ENTONCES NO DEBERÁ mostrar nada de ella.
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

### 20. Leer la receta de la nota (D2, P2, P5)

- **AS-063** — CUANDO el profesional de la atención pida «Proponer la receta»
  en una atención viva, el sistema DEBERÁ comprobar primero que las alergias
  del paciente se pueden leer (AS-070), seudonimizar la nota de consulta como
  en AS-028, y pedir al modelo las líneas que la nota **receta**, cada una tal
  como se escribió —nombre del medicamento, concentración, forma, dosis y su
  unidad, vía, frecuencia, duración e indicaciones— con la frase literal de la
  nota que la dice; lo que la nota no dice DEBERÁ quedar vacío. DEBERÁ
  descartar toda línea cuya frase no esté en la nota con las reglas de AS-028
  (palabras enteras, sin negación delante); y SI la nota no tiene texto,
  ENTONCES DEBERÁ rechazarlo con `ASSISTANT_NOTE_EMPTY` sin llamar a nadie.
  > Mientras no haya transcripción (C1), la fuente es la nota escrita. Un
  > medicamento que la nota sólo menciona —lo que ya toma, una alergia, algo
  > que se suspende— no es una línea. Las listas cerradas de la receta
  > (PR-101, PR-102: forma, unidad, vía y frecuencia) van al modelo como
  > catálogo del sistema (`withContext`): lo que no es de la lista queda vacío.
  > Al modelo NO se le pide calcular nada (SigmAI `READING`). Lo que el
  > modelo lee no se muestra como «dicho» sin que la frase lo respalde
  > (revisión clínica del 12-10-2026, G2): un campo inventado vacío pide al
  > médico que lo escriba; uno inventado lleno se firmaría. La forma vuelve
  > como texto y se comprueba contra la lista: Gemini rechaza esa enumeración
  > en el esquema.
- **AS-064** — Para cada línea el sistema DEBERÁ buscar en el CNMB vigente en
  la fecha clínica de la atención hasta **5** medicamentos por su principio
  activo o su nombre (sin tildes ni mayúsculas), con sus presentaciones
  declaradas (PR-115); DEBERÁ pedir al modelo que elija uno de esos
  medicamentos y una de sus presentaciones, o ninguno; y DEBERÁ quedarse sólo
  con una elección que esté entre los candidatos ofrecidos para esa línea. El
  nombre que se muestra DEBERÁ ser el del cuadro.
  > Buscar y elegir (P6, E-072). La búsqueda la hace el sistema; el modelo sólo
  > elige de una lista numerada, y un id que no se le ofreció es un invento
  > (SigmAI `mapToCatalogue`). Los candidatos son el catálogo público, no el
  > texto del paciente: van con `withContext`.
- **AS-065** — Una línea sin medicamento del CNMB elegido NO DEBERÁ mostrar
  ningún nombre de medicamento que haya escrito el modelo: DEBERÁ mostrarse
  sólo con la oración de la nota, como «no encontrada en el cuadro», y NO
  DEBERÁ poder añadirse a la receta desde la propuesta.
  > El médico la escribe en el editor como hoy (PR-009, PR-110). Así ningún
  > medicamento fuera del CNMB sale de la propuesta (plan de la rama).
- **AS-066** — La presentación DEBERÁ ser una de las declaradas por el
  medicamento elegido; SI la nota escribió una concentración o una forma y la
  presentación elegida no es compatible con ellas (PR-115, rangos incluidos),
  ENTONCES la línea DEBERÁ quedar sin presentación, para que la elija el
  médico.
  > Una presentación que contradice la nota es un error del modelo, no una
  > propuesta. Sin concentración escrita, la que elige el modelo se marca
  > «Nadie lo dijo» (AS-067).
- **AS-067** — Lo que la propuesta trae y la nota no dice DEBERÁ ir marcado,
  campo por campo, «Nadie lo dijo»: la presentación elegida sin concentración
  escrita; la vía tomada de la presentación del cuadro; la dosis de **una**
  unidad cuando la concentración escrita es exactamente la de una presentación
  de tableta, cápsula, supositorio, óvulo, parche o sobre; y la **cantidad
  total**, calculada como dosis × tomas al día × días, sólo con esas unidades,
  una frecuencia de la lista con intervalo fijo y una duración, redondeada hacia
  arriba. Ningún otro campo DEBERÁ completarse.
  > SigmAI E-053 (`course-of-treatment.ts`): la cantidad cuadra en el 91,9 % de
  > las tabletas diarias y en 0 % de los líquidos, que van por frasco. Y
  > `per-dose.ts`: «quinientos miligramos» de una tableta de 500 mg es una
  > tableta; de 1 000 mg, nada. D-248 §3 y §4.
- **AS-068** — El sistema NO DEBERÁ calcular ninguna dosis a partir del peso
  ni de la superficie corporal (D-084 §5), ni leer el peso del paciente para
  esta función: SI la nota escribe la dosis por peso («mg/kg», «por kilo»),
  ENTONCES la línea DEBERÁ quedar sin dosis ni cantidad, con el motivo
  `dose-by-weight` para que el médico la escriba; y SI la nota escribe una
  dosis por peso en cualquier otra oración, ENTONCES ninguna dosis en
  miligramos, microgramos, gramos, unidades o mililitros DEBERÁ tomarse de
  ella.
  > Las formas de escribirlo que se reconocen (revisión clínica G1): «mg/kg»,
  > «mg/kilo», «mg x kg», «mg/kgr», «mg/k», «por kilo», «mg/m²», «m2sc» y
  > «superficie corporal».
  > Si el cálculo de dosis convierte el sistema en dispositivo médico ante
  > ARCSA es D-084 §5, del asesor legal.

### 21. Alergias, sin modelo y cerradas (P5, F-01)

- **AS-069** — Cada línea con medicamento DEBERÁ compararse con las alergias
  no refutadas de la ficha superviviente de la atención y de las que absorbió
  —el mismo lector que la receta (PR-062, PR-118)— con la **misma** regla que
  la emisión: coincidencia exacta por código, códigos sustituidos y principio
  activo (PR-060, PR-114), y misma clase ATC (PR-065). Cada línea DEBERÁ decir
  `exact`, `class` o `none`, y la propuesta DEBERÁ decir además si la ficha
  tiene alergias registradas sólo como texto (`uncoded`) o si nadie afirmó
  nunca que no tenga alergias (`not-asked`, EN-087). La comparación DEBERÁ
  hacerse cada vez que se muestra la propuesta, no sólo al leerla.
  > Una regla, no dos: la función pura es la de la receta, movida a
  > `shared/clinical/` para que el asistente no la copie (ADR-011). Una alergia
  > registrada después de la lectura tiene que verse en la tarjeta.
- **AS-070** — SI las alergias del paciente no se pueden leer o comparar,
  ENTONCES el sistema NO DEBERÁ decir de ninguna línea que no tiene conflicto:
  «Proponer la receta» DEBERÁ fallar con `ASSISTANT_ALLERGY_CHECK_FAILED` antes
  de llamar al modelo; al mostrar una propuesta cada línea DEBERÁ decir
  `failed`; y «Confirmar la receta» DEBERÁ rechazarse con el mismo código.
  > Es el bug F-01 de SigmAI, el peor que tuvo: un fallo del chequeo mostrado
  > como «sin conflicto». Aquí el fallo nunca es una respuesta; es un estado
  > que bloquea.
- **AS-071** — Una línea con coincidencia **exacta** NO DEBERÁ poder añadirse
  a la receta desde la propuesta; una de la misma **clase** DEBERÁ poder
  añadirse con su aviso.
  > Proporcionalidad de PR-067: la clase informa. La exacta, que en la emisión
  > interrumpe (PR-060), aquí ni siquiera entra al borrador desde la propuesta;
  > si el médico la quiere, la escribe él en el editor y la emisión decide
  > (D-248 §1).

### 22. Guardar, confirmar y enlazar (P1, D-243 §5)

- **AS-072** — CUANDO el modelo responda, el sistema DEBERÁ guardar cada línea
  respaldada como una propuesta de `ai_suggestion` de clase
  `prescription-item`, en estado «propuesta», con el intento de `ai_run` que
  la leyó, la frase, los campos, sus marcas «Nadie lo dijo» y la línea entera
  en texto canónico (`text`), con la nota como fuente; y la lectura nueva
  DEBERÁ sustituir en pantalla a las propuestas sin decidir de la anterior,
  sin borrar ninguna (AS-036).
  > D-243 §5, construida con su recomendación: la línea de receta no tiene
  > identidad propia, así que la propuesta guarda la línea entera y se compara
  > con la que quedó (AS-074). Una línea cuyo medicamento ya está en una receta
  > no descartada de la atención se muestra como «Ya en la receta» y no se
  > añade otra vez.
- **AS-073** — CUANDO el profesional pida «Confirmar la receta» con las
  propuestas que aceptó, el sistema DEBERÁ comprobar otra vez, en ese momento,
  que cada una es de la última lectura y está sin decidir, tiene medicamento
  del CNMB, no está ya en una receta de la atención y no tiene coincidencia
  exacta de alergia ni chequeo fallido; y DEBERÁ devolver las líneas listas
  para el borrador **sin escribir nada**. SI alguna no pasa, ENTONCES DEBERÁ
  rechazarlo entero nombrando las líneas, con
  `ASSISTANT_ALLERGY_CONTRAINDICATION` (409), `ASSISTANT_ALLERGY_CHECK_FAILED`
  (503) o `ASSISTANT_PRESCRIPTION_LINE_NOT_READY` (422). El asistente NO
  DEBERÁ componer, reescribir, emitir ni anular ninguna receta.
  > El borrador lo escribe la pantalla por la ruta de siempre, con sus
  > comprobaciones (PR-001 a PR-009, PR-101 a PR-104) y su `If-Match` (PR-121),
  > y la emisión vuelve a comprobar las alergias dentro de su transacción
  > (PR-060). La barrera de aquí es del camino del asistente, no la única.
- **AS-074** — CUANDO el borrador se haya guardado con líneas que vienen de
  propuestas, el sistema DEBERÁ enlazar cada propuesta a esa receta, que
  DEBERÁ ser de la misma atención y no estar descartada, leyendo la línea
  guardada por su número: «aceptada» si su texto canónico es el propuesto,
  «aceptada con cambios» si no, con la distancia calculada por el sistema; y
  SI la receta no es de la atención o la línea no existe, ENTONCES DEBERÁ
  rechazarlo con `SUGGESTION_PRESCRIPTION_MISMATCH` (422).
  > Lo guardado lo lee el servidor, no lo dice quien llama (AS-022): así la
  > fase F mide lo que el médico corrigió. La línea DEBERÁ ser del
  > medicamento de la propuesta, y todo se comprueba antes de escribir nada:
  > una propuesta o una línea repetida (`SUGGESTION_INVALID`), una ya
  > decidida o de otra lectura no enlazan ninguna. Si el enlace falla, la receta queda
  > guardada (fue el acto del médico) y la tarjeta lo dice.
- **AS-075** — CUANDO el profesional descarte una propuesta, el sistema DEBERÁ
  dejarla «descartada» con quién y cuándo, y NO DEBERÁ volver a mostrarla.
- **AS-076** — Proponer, confirmar, enlazar y descartar DEBERÁN exigir lo de
  AS-039: el profesional de la atención, `assistant:use`, `record:write` y
  `prescription:write` en su sede, la atención viva; una atención de otra sede DEBERÁ responderse como
  inexistente. Ver la propuesta DEBERÁ exigir `record:read`.

### 23. Fallos, privacidad y medida

- **AS-077** — SI el seudonimizador o el proveedor fallan, se acaba el plazo
  (90 s) o el techo de gasto no admite el intento, ENTONCES la lectura DEBERÁ
  fallar con el código del error sin guardar nada ni tocar las propuestas que
  había; DEBERÁ haber una lectura a la vez por atención
  (`ASSISTANT_READING_IN_PROGRESS`) y seis por minuto; y SI la atención se
  cerró mientras el modelo respondía, ENTONCES no se DEBERÁ guardar nada.
- **AS-078** — Ninguna línea de log, fila de `ai_run` ni mensaje de error de
  esta función DEBERÁ contener la nota, las frases ni el nombre de ningún
  medicamento; la nota DEBERÁ ir al modelo delimitada como dato, con la
  instrucción de no seguir órdenes que contenga; y leer la nota para mandarla
  DEBERÁ dejar su fila `EXPORT` en la bitácora.
  > PR-094: el nombre de un medicamento es un diagnóstico dicho de otra forma.
  > El error de AS-073 nombra las líneas por su número, nunca por su nombre.
  > La excepción es `ai_exchange`, sólo si se enciende (AS-014): guarda el
  > prompt seudonimizado y la respuesta, medicamentos incluidos, y se purga
  > a los 45 días (D-239 §3).
- **AS-079** — El arnés de evaluación DEBERÁ medir, sobre un set propio de
  notas inventadas con su receta esperada contra el CNMB, el **acierto del
  mapeo** (medicamento y presentación del cuadro) del camino del producto
  —leer, buscar, elegir y la barrera—, con su intervalo, los medicamentos de
  más y cuántos medicamentos fuera del CNMB se habrían mostrado, que DEBERÁ ser
  **cero**; la latencia sumando las dos llamadas de cada caso; fuera del
  verify, con el modelo, las versiones de prompt y la del cuadro.
  > Umbral para encender (P7): más de 73,2 % (E-072). Sólo casos inventados
  > (EV-1). El F1 por campo (forma, vía, dosis, frecuencia, duración) lo mide
  > la tarea `receta` de A6 sobre dictados con la receta entera esperada; el
  > set de notas de esta tarea sólo trae el medicamento y la presentación
  > esperados.

### 24. En la pestaña Receta

- **AS-080** — La pestaña Receta DEBERÁ mostrar, a quien tiene el permiso y
  con el asistente encendido, «Proponer la receta» y, debajo de «Propuesta del
  asistente» y «Revise cada medicamento antes de aceptarlo», cada línea con
  borde punteado: la oración de la nota, el medicamento y la presentación del
  cuadro, la dosis, la frecuencia, la duración y la cantidad, cada campo que
  nadie dijo resaltado en ámbar como «Nadie lo dijo», su aviso de alergia, y «Aceptar» y
  «Descartar»; y «Confirmar la receta», que pasa las aceptadas al borrador
  abierto —o a uno nuevo— y lo guarda, sin emitirlo. Sin el permiso o con el
  asistente apagado NO DEBERÁ mostrar nada de esto; en modo demostración, cada
  línea DEBERÁ decirlo.
- **AS-081** — MIENTRAS la lectura está en curso la pestaña DEBERÁ decirlo y
  seguir usable; SI falla, ENTONCES DEBERÁ decir el motivo con «Volver a
  pedir» sin quitar lo que había; y una línea con coincidencia exacta, con el
  chequeo fallido, sin medicamento del cuadro o ya en la receta DEBERÁ decir
  por qué, sin «Aceptar».
- **AS-082** — SI una línea aceptada no trae algo que la receta exige para
  guardarse (forma, concentración, vía, dosis, frecuencia, duración o
  cantidad), ENTONCES «Confirmar la receta» DEBERÁ dejarla en el editor sin
  guardar, señalando lo que falta, y el enlace (AS-074) DEBERÁ hacerse cuando
  el médico la guarde.
  > Nada clínico viene relleno (PR-106): lo que falta lo escribe el médico.

### 25. Pedir y rehacer el borrador (C2)

- **AS-086** — CUANDO el profesional de la atención pida el borrador de una
  atención viva cuya nota 002 está en borrador, el sistema DEBERÁ responder
  enseguida (202) con el borrador del tramo transcrito hasta ese momento
  (`upToMs`, el fin del último segmento) y redactarlo aparte; SI ese tramo ya
  tiene un borrador listo o en curso, DEBERÁ responder ése sin pedir otro; SI
  lo tiene fallido, DEBERÁ volver a ponerlo en cola («Volver a pedir»); SI la
  transcripción está vacía, ENTONCES DEBERÁ rechazarlo con
  `ASSISTANT_TRANSCRIPT_EMPTY`; SI la nota no está abierta en borrador, con
  `ASSISTANT_NOTE_NOT_OPEN`; y quién, dónde y la atención viva, como AS-039.
  La base DEBERÁ rechazar un segundo borrador en curso de la misma atención y
  dos borradores del mismo tramo; la instalación DEBERÁ redactar como mucho
  **4** a la vez; y SI el tramo ya falló **3** veces, ENTONCES DEBERÁ
  rechazar volver a pedirlo con `ASSISTANT_DRAFT_RETRY_LIMIT` sin llamar a
  nadie.
  > SigmAI R-02: un solo trabajo a la vez para todas las consultas. Aquí, uno
  > a la vez por atención —un proveedor lento no recibe dos veces las mismas
  > palabras— y cuatro atenciones a la vez (D-249 §6). El tope de intentos
  > cierra el bucle de «Volver a pedir» sobre un tramo que falla siempre: cada
  > intento pagaba una llamada (auditoría del 12-10-2026).
- **AS-087** — MIENTRAS se escucha, CUANDO lo transcrito pase en **3 minutos**
  del reloj de la conversación el tramo del último borrador pedido, y CUANDO
  el médico detenga la escucha —también tras una pausa—, el sistema DEBERÁ
  pedir el borrador por su cuenta, a nombre del profesional y con las reglas
  de AS-086; pausar NO DEBERÁ pedirlo; y sin nota abierta, o si quien abrió la
  escucha no es el profesional de la atención, NO DEBERÁ pedir nada.
  > Minutos de conversación, no de reloj de pared (D-249 §3). Un fallo al
  > pedirlo no toca la escucha: se queda en el log, sin texto.

### 26. Cómo se redacta (P2)

- **AS-088** — El borrador DEBERÁ escribirse sólo en las secciones de texto
  (`TEXT`) de la plantilla con que se abrió la nota (EN-204; la de serie si no
  tiene), con su título y su ayuda como guía; SI la respuesta nombra otra
  sección, ENTONCES el intento DEBERÁ fallar entero (`invalid-answer`); y una
  sección de la que la conversación no habló NO DEBERÁ aparecer.
  > La plantilla la escribe la clínica, no el paciente: va al modelo como
  > contexto (`withContext`), con las instrucciones fijas. Lo que la ficha ya
  > sabe no se copia (D-249 §1), ni un diagnóstico: va en Diagnósticos, y la
  > transcripción no dice quién habla (D-249 §2).
- **AS-089** — Cada frase DEBERÁ llevar el inicio de la línea de la
  transcripción que la respalda, sólo de las que se dieron al modelo; SI una
  frase no lleva marcador, lleva uno que no se le dio, o lleva una fecha que,
  devuelta, no está en la transcripción, ENTONCES DEBERÁ guardarse marcada
  «Nadie lo dijo» (`unsaid`), nunca con una fuente inventada; las fuentes de
  la propuesta DEBERÁN ser los tramos (`fromMs`, `toMs`) de las líneas
  citadas; y el texto que «Aceptar» copia en la nota DEBERÁ ser sólo el de las
  frases que alguien dijo.
  > SigmAI `sourceRefOf`: un marcador que no se dio no es una cita. La pantalla
  > lo muestra marcado, no lo esconde; pero no se copia: una vez en la casilla
  > perdía la marca antes de la firma (revisión clínica del 12-10-2026,
  > D-249 §7). Una fecha cuenta como dicha sólo si es, entera, una de las
  > fechas de lo dicho («5 de marzo» no es «15 de marzo»).
- **AS-090** — CUANDO el modelo responda, el sistema DEBERÁ guardar cada
  sección como una propuesta `note-section` de `ai_suggestion` con su intento,
  su sección, su texto, sus frases con su fuente y el borrador al que
  pertenece, y dejar el borrador listo; en pantalla DEBERÁ estar, por
  sección, la propuesta más reciente de los borradores listos —un borrador
  nuevo que omite una sección no esconde la que espera—, ninguna si la más
  reciente se descartó, y ninguna si dice lo mismo que otra ya decidida; sin
  borrar ninguna (AS-023). Una propuesta nueva de una sección aceptada antes
  DEBERÁ decir qué texto se aceptó, para sustituirlo y no añadirlo dos veces.
- **AS-091** — Antes de guardar, el sistema DEBERÁ devolver al texto los nombres
  que el seudonimizador quitó y mover de vuelta las fechas que desplazó
  (`dateShiftDays`); y NO DEBERÁ mandar al proveedor la fecha de la atención.
  > Pendiente desde D1 (AS-025): una fecha desplazada no puede ser lo que el
  > médico firma. La fecha de hoy delataría el desplazamiento (D-246 §4).
- **AS-092** — Antes de seudonimizar, el sistema DEBERÁ corregir en el texto que
  va al modelo una palabra que el reconocedor partió en dos cuando, unida, es
  letra por letra un principio activo del CNMB («para acetamol» →
  «paracetamol»), y sólo si la segunda mitad no es del vocabulario protegido
  (las palabras de la CIE-10 y las que la clínica escribe en sus notas); NO
  DEBERÁ cambiar ninguna otra palabra; y la transcripción guardada NO DEBERÁ
  cambiar.
  > SigmAI `lexicon.ts`; D-247 §4 y D-249 §5. SigmAI corregía además una
  > palabra a una o dos ediciones de un principio: con el CNMB real eso volvía
  > «metamizol» en «metimazol» y «un litro» en «un litio», y el borrador lo
  > escribía como dicho (revisión clínica del 12-10-2026). Una palabra mal oída
  > la lee y la corrige el médico; una bien oída cambiada, no.

### 27. Fallos, aceptar y privacidad

- **AS-093** — SI el seudonimizador o el proveedor fallan, se acaba el plazo
  (**60 s**), el techo no admite el intento o la atención se cerró mientras se
  redactaba, ENTONCES el borrador DEBERÁ quedar fallido con el código del
  error, sin guardar ninguna propuesta ni tocar las anteriores; y CUANDO la API
  arranque, un borrador que quedó en curso DEBERÁ quedar fallido con
  `ASSISTANT_DRAFT_INTERRUPTED`.
  > En pantalla, el motivo y «Volver a pedir» (AS-100). El respaldo de A4
  > actúa antes (AS-007). Un fallo de la base al empezar a redactar deja el
  > borrador fallido, nunca un rechazo sin capturar en el proceso.
- **AS-094** — CUANDO el profesional acepte una sección con la nota en que la
  guardó, el sistema DEBERÁ comprobar que es la nota 002 en borrador de esa
  atención y enlazar la propuesta con la distancia leída de esa sección
  (AS-022); el asistente NO DEBERÁ escribir en la nota, firmarla ni cambiar su
  estado. Descartar DEBERÁ hacer lo de AS-038; y aceptar y descartar, exigir lo
  de AS-039.
  > La pantalla escribe la sección por la ruta de la nota, con `If-Match`
  > (EN-281), y sólo después enlaza. Firmar sigue siendo el acto del médico
  > con `record:sign` (EN-027).
- **AS-095** — Ninguna línea de log, fila de `ai_run` o de `note_draft` ni
  mensaje de error DEBERÁ contener la transcripción ni el borrador; la
  transcripción DEBERÁ ir al modelo delimitada como dato, con la instrucción
  de no seguir órdenes que contenga; mandarla DEBERÁ dejar su fila `EXPORT` en
  la bitácora, y leer el borrador, su `READ`.
  > Entre `<conversacion>` y `</conversacion>`, con esas marcas rotas si la
  > transcripción las decía (AS-041).
- **AS-096** — CUANDO el profesional pida ver el borrador, el sistema DEBERÁ
  responder el estado del último —en cola, redactando, listo o fallido con su
  código—, su tramo, cuánto de la transcripción queda sin redactar y las
  secciones vigentes (AS-090) con sus frases, fuentes, marcas y si son de
  demostración; a cualquier otro, lo de AS-039. Esa respuesta, y la de pedir
  (AS-086), dejar de esperar (AS-147), aceptar y descartar una sección
  (AS-094), NO DEBERÁ guardarse en ningún caché (`no-store`), como las
  preguntas (AS-124).
  > Sus secciones son la consulta (revisión de C3, 12-10-2026). Desde
  > `fix/consulta-no-store` la cabecera la pone la política común de AU-061
  > para toda la API, no cada ruta: las propuestas de diagnóstico, órdenes y
  > receta, y la nota, también la llevan.
- **AS-097** — CUANDO un borrador se ponga en cola o termine, listo o fallido,
  y CUANDO se acepte o descarte una sección, el sistema DEBERÁ publicar
  `assistant-draft` dirigido a quien lo pidió o decidió, sin contenido
  (AU-055, AU-060).

### 28. Medir y demostrar

- **AS-098** — `pnpm eval -- --tareas borrador` DEBERÁ medir con el redactor
  del producto, sobre `casos/nota.json` con sus líneas puestas en un reloj, las
  secciones inventadas, los hechos esperados (juez sin validar), las frases
  «Nadie lo dijo» y el p50 y el p90 de lo que tarda; DEBERÁ correr fuera del
  verify y DEBERÁ detenerse antes de un intento que haga pasar a su proveedor
  del tope de `--tope-proveedor` en el registro, que en una corrida real vale
  2 USD si no se dice otro.
  > D-241: 2 USD por proveedor en total en las pruebas, en el registro
  > compartido del arnés. SC-091 y SC-092.
- **AS-099** — DONDE `ASSISTANT_FAKE_PROVIDER` sea `true`, el proveedor de
  demostración DEBERÁ redactar desde el guion —cada línea que contiene una
  frase del guion va a su sección con su marcador, más una frase sin marcador
  para que se vea «Nadie lo dijo»— y cada sección DEBERÁ decir que es de
  demostración (AS-029).

### 29. En la pestaña Nota

- **AS-100** — MIENTRAS la cuenta pueda pedir el borrador (AS-086), la pestaña
  Nota DEBERÁ mostrar sobre la nota un único aviso del borrador con su estado
  —redactando, hasta qué minuto cubre, el motivo del fallo con «Volver a
  pedir»— y «Pedir borrador»; con secciones propuestas, «El asistente propone
  N secciones con lo que se dijo», «Revise lo marcado en ámbar: nadie lo
  dijo», «Aceptar las N» y «Descartar». En cada sección: vacía, el texto
  propuesto dentro de la casilla con borde punteado, «Propuesta» y «Aceptar» y
  «Descartar» junto a su título; con texto del médico, una fila debajo
  «Añadir: «…»» con «Añadir», «Reemplazar lo mío» y «Descartar»; igual a lo
  escrito, nada; aceptada, «Aceptado del asistente» con «Deshacer». Cada
  frase dicha DEBERÁ ir subrayada y, al tocarla, abrir la hoja de la
  transcripción (AS-059) con su línea iluminada; lo que nadie dijo, resaltado
  en ámbar. SI el borrador responde 404, ENTONCES NO DEBERÁ mostrar nada de
  esto.
  > Rediseño aprobado por el autor el 12-10-2026 (`fix/asistente-rediseno`):
  > «el diseño de la aceptación se ve cero entendible y quita demasiado
  > espacio».
- **AS-101** — CUANDO el médico acepte una sección, la pantalla DEBERÁ escribir
  su texto en esa sección de la nota —en una vacía, tal cual; en una que ya
  tiene lo aceptado antes, en su lugar («Actualizar»); en una con texto del
  médico, «Añadir» al final o «Reemplazar lo mío» tras confirmarlo—, guardarla con
  `If-Match` y sólo después enlazar la propuesta; SI el guardado responde que
  otra persona cambió la nota, ENTONCES NO DEBERÁ enlazarla y DEBERÁ decirlo
  (EN-284); SI el guardado falla por otra causa, ENTONCES DEBERÁ devolver la
  sección a lo que tenía; y SI lo que falla es el enlace, el siguiente
  «Aceptar» DEBERÁ sólo enlazar, sin escribir el texto otra vez. «Aceptar las
  N» DEBERÁ hacer, sección por sección, lo mismo que su «Aceptar» —en una con
  texto del médico, «Añadir»—, sin reemplazar nada ni firmar; y «Deshacer»
  DEBERÁ devolver la sección a lo que tenía antes de aceptar, sólo mientras
  la pantalla lo conserve y la sección siga siendo lo que dejó la aceptación,
  y decir «Se quitó lo aceptado del asistente»; el enlace queda en el
  servidor y la distancia al firmar (E1) lo registra como cambiado. MIENTRAS
  quede alguna propuesta sin decidir, junto a «Firmar…» DEBERÁ decir cuántas
  y que no están en la nota.
- **AS-102** — CUANDO llegue `assistant-draft`, la pantalla DEBERÁ releer el
  borrador sin recargar la página ni tocar lo que el médico está escribiendo.

### 30. Leer lo que la consulta pide (D3, P2, P5)

- **AS-103** — CUANDO el profesional de la atención pida «Proponer exámenes»
  en una atención viva, el sistema DEBERÁ seudonimizar la nota de consulta como
  en AS-028 y, si la atención tiene transcripción (AS-056), también la
  transcripción; y DEBERÁ pedir al modelo los exámenes que la consulta **pide**,
  cada uno con la frase literal de la nota o de la conversación que lo pide y
  hasta 5 candidatos del catálogo ordenable (AS-104). DEBERÁ descartar toda
  línea cuya frase no esté en la nota ni en la transcripción con las reglas de
  AS-028 (palabras enteras, sin negación delante) y toda línea cuya oración
  diga que el examen no se pide hoy: en cualquier parte de la oración, una
  condición o una visita posterior («si no mejora», «si persiste», «próximo
  control», «no requiere», «no es necesaria», «de ser necesario»); y en la
  cláusula de la frase (entre comas, dos puntos o punto y coma), un resultado
  o un examen hecho («trae», «reporta», «reportada», «resultado de», «previo»,
  «anterior», «realizado», «ya tiene»), también después de las palabras
  citadas; y SI ni la nota ni la transcripción
  tienen texto, ENTONCES DEBERÁ rechazarlo con `ASSISTANT_NOTE_EMPTY` sin
  llamar a nadie.
  > Un examen que sólo se menciona —un resultado que el paciente trae, uno que
  > se hizo antes, uno que no hace falta— no es una línea, aunque el modelo
  > cite sólo su nombre (revisión clínica del 12-10-2026, G1). La cláusula y
  > no la oración para el resultado: «Trae EMO normal, se solicita
  > urocultivo» pide el urocultivo; «ya que tiene fiebre» no es «ya tiene».
  > El precio: «Por resultado de la tira, se pide urocultivo» se pierde si el
  > médico no lo separa con una coma; lo escribe él. La frase de la
  > conversación lleva su tramo (`transcript`, `fromMs`–`toMs`, AS-020); la de
  > la nota, su sección. La transcripción no distingue quién habla (D-249 §2):
  > lo que pide el paciente también se propone, y no entra en la orden sin el
  > médico (D-250 §2).
- **AS-104** — El catálogo que se ofrece DEBERÁ ser el de la clínica: cada
  servicio activo de tipo `LAB_EXAM` o `IMAGING` con su extensión de orden
  (`service_exam`, BI-284), numerado, con su nombre y su tipo, como catálogo
  del sistema (`withContext`). El sistema DEBERÁ quedarse sólo con los números
  que se ofrecieron, sin repetir y como mucho 5 por línea, en el orden del
  modelo; y el nombre, el código y el tipo que se muestran DEBERÁN ser los del
  catálogo. Lo que el modelo escribió como nombre del examen NO DEBERÁ
  mostrarse.
  > Buscar y elegir (P6, E-072) con la búsqueda más simple que existe: la
  > lista entera, que en una clínica son decenas de exámenes. Un número que no
  > se ofreció es un invento (SigmAI `mapToCatalogue`). Los procedimientos
  > ordenables (un electrocardiograma) quedan fuera: D-250 §1.
- **AS-105** — Una línea sin ningún candidato DEBERÁ mostrarse sólo con su
  frase, como «no está en el catálogo de la clínica», y NO DEBERÁ poder
  añadirse a una orden desde la propuesta.
  > El médico lo pide a mano en el editor, si la clínica lo tiene con otro
  > nombre. Así ningún examen fuera del catálogo sale de la propuesta.
- **AS-106** — CUANDO se muestre la propuesta, el sistema DEBERÁ resolver otra
  vez cada candidato contra el catálogo ordenable de ese momento —el que ya no
  está activo o ya no se ordena NO DEBERÁ mostrarse—, DEBERÁ marcar «Ya en la
  orden» el que ya está en una orden no descartada de la atención con su línea
  sin anular, y NO DEBERÁ mostrar una línea cuya frase ya no está en la nota ni
  en la transcripción. Una línea cuya frase sale de la conversación DEBERÁ
  mostrarse sólo al profesional de la atención.
  > AS-056: la transcripción la ve sólo el profesional de la atención; su
  > frase en otra pantalla sería verla por otra puerta (D-247 §3). Su frase
  > se lee de los segmentos de su tramo al mostrarla (AS-107); cuando la
  > purga los borra (AS-057), la línea deja de mostrarse.

### 31. Guardar, añadir y enlazar (P1, D-243 §5)

- **AS-107** — CUANDO el modelo responda, el sistema DEBERÁ guardar cada línea
  respaldada como una propuesta de `ai_suggestion` de clase `order-item`, en
  estado «propuesta», con el intento de `ai_run` que la leyó, su fuente (la
  nota, o el tramo de la conversación), sus candidatos con los códigos del
  catálogo y los que ya estaban en una orden viva al leer; la frase DEBERÁ
  guardarse sólo si es de la nota, y NO DEBERÁ guardarse ni la frase de la
  conversación (AS-058) ni el examen como lo nombró el modelo; y la lectura
  nueva DEBERÁ sustituir en pantalla a las
  propuestas sin decidir de la anterior, sin borrar ninguna (AS-036). Una
  lectura que no propone nada DEBERÁ decirlo (`found: 0`) y dejar las
  anteriores como estaban.
- **AS-108** — El asistente NO DEBERÁ componer, reescribir, emitir, descartar
  ni anular ninguna orden: el examen elegido entra en la orden en borrador por
  la ruta de las órdenes, con sus comprobaciones (ORD-095 a ORD-101) y su
  `If-Match` (ORD-181), y nada entra sin que el médico pulse «Aceptar» en un
  candidato.
  > El borrador lo escribe la pantalla, como la receta de D2: la barrera de
  > aquí es la del camino del asistente, no la única.
- **AS-109** — CUANDO la orden se haya guardado con un examen elegido de una
  propuesta, el sistema DEBERÁ enlazar la propuesta a esa orden, leyendo la
  orden guardada: DEBERÁ ser de la misma atención y no estar descartada, tener
  una línea sin anular de ese servicio, y el servicio DEBERÁ ser uno de los
  candidatos de la propuesta, no estar ya en una orden viva cuando se leyó
  y no ser la respuesta de otra propuesta en esa orden;
  la propuesta queda «aceptada» con distancia 0 (AS-022: elegir entre
  candidatos, como un diagnóstico). SI algo de eso no se cumple, ENTONCES
  DEBERÁ rechazarlo con `SUGGESTION_ORDER_MISMATCH` (422) sin enlazar ninguna;
  una propuesta o una línea repetida en la misma petición, con
  `SUGGESTION_INVALID`; una ya decidida, con `SUGGESTION_ALREADY_DECIDED`.
  La base DEBERÁ guardar el código del examen aceptado (`accepted_code`)
  exactamente en una propuesta de examen aceptada
  (`ai_suggestion_accepted_code_of_an_accepted_exam`) y NO DEBERÁ admitir dos
  propuestas aceptadas con el mismo examen en la misma orden
  (`ai_suggestion_one_per_ordered_exam`, que responde también con
  `SUGGESTION_ORDER_MISMATCH`), ni un código que no sea candidato de la
  propuesta y línea viva de esa orden
  (`ai_suggestion_accepted_code_of_its_order`).
  > Un examen ya pedido antes de la lectura es obra del médico: la fase F no
  > debe contarlo como del asistente (revisión clínica M2). La orden puede
  > estar ya emitida: el médico pudo emitirla en otra pestaña entre guardar
  > y enlazar. Todo se comprueba antes de escribir nada. Si el enlace falla, la orden
  > queda guardada (fue el acto del médico) y la tarjeta lo dice. Cualquier
  > candidato es «tal cual»: sin `accepted_code` nada diría qué línea es obra
  > de la propuesta, y dos líneas de una misma frase («biometría y glucosa»)
  > con candidatos en común contarían la misma línea dos veces (migración
  > `20261025001400`).
- **AS-110** — CUANDO el profesional descarte una propuesta, el sistema DEBERÁ
  dejarla «descartada» con quién y cuándo, y NO DEBERÁ volver a mostrarla.
- **AS-111** — Proponer, enlazar y descartar DEBERÁN exigir lo de AS-039: el
  profesional de la atención, `assistant:use` y `record:write` en su sede, la
  atención viva; una atención de otra sede DEBERÁ responderse como
  inexistente. Ver la propuesta DEBERÁ exigir `record:read`.
  > `record:write` es el permiso con que se pide una orden (ORD-001).

### 32. Fallos, privacidad y medida

- **AS-112** — SI el seudonimizador o el proveedor fallan, se acaba el plazo
  (90 s) o el techo de gasto no admite el intento, ENTONCES la lectura DEBERÁ
  fallar con el código del error sin guardar nada ni tocar las propuestas que
  había; DEBERÁ haber una lectura a la vez por atención
  (`ASSISTANT_READING_IN_PROGRESS`) y seis por minuto; y SI la atención se
  cerró mientras el modelo respondía, ENTONCES no se DEBERÁ guardar nada.
- **AS-113** — Ninguna línea de log, fila de `ai_run` ni mensaje de error de
  esta función DEBERÁ contener la nota, la transcripción, las frases ni el
  nombre de ningún examen; la nota y la conversación DEBERÁN ir al modelo
  delimitadas como dato, con la instrucción de no seguir órdenes que
  contengan, y con sus marcas —`<nota>`, `<conversacion>`, `<catalogo>`,
  con o sin tilde, y una cabecera `#` a inicio de línea— rotas si las
  escriben; el catálogo DEBERÁ ir entre `<catalogo>` y `</catalogo>`; y
  leerlas para mandarlas DEBERÁ dejar su fila `EXPORT` en la bitácora.
  > Un examen pedido dice un diagnóstico de otra forma (PR-094). La excepción
  > es `ai_exchange`, sólo si se enciende (AS-014).
- **AS-114** — El arnés de evaluación DEBERÁ medir, sobre un set propio de
  notas inventadas con los exámenes que piden y un catálogo inventado de
  clínica, el camino del producto —leer, elegir y la barrera—: qué parte de
  los exámenes pedidos tiene el correcto entre sus candidatos (umbral para
  encender: **≥ 90 %**, D-250 §3), las líneas con candidatos para algo que
  nadie pidió o que la clínica no tiene (umbral: **≤ 0,05 por caso**),
  cuántos tienen el correcto en primer lugar, la latencia p90 (presupuesto
  5 s) y cuántos
  exámenes fuera del catálogo se habrían mostrado, que DEBERÁ ser **cero**;
  fuera del verify, con el modelo, la versión del prompt y la del catálogo.

### 33. En la pestaña Exámenes

- **AS-115** — La pestaña Exámenes DEBERÁ mostrar, a quien tiene el permiso y
  con el asistente encendido, «Proponer exámenes» y, debajo de «Propuesta del
  asistente» y «Revise cada examen antes de añadirlo», dentro del borde
  punteado, cada oración una vez, con de dónde sale (la nota o el minuto de
  la conversación) y las palabras que nombran cada examen subrayadas; debajo,
  cada examen que pide, titulado con esas palabras de la propia oración
  (`named`, el lugar donde el servidor las encontró; nunca el texto del
  modelo), y sus candidatos con su nombre y su tipo, cada uno con
  «Aceptar» —que lo añade a la orden en borrador de su tipo, la abierta o una
  nueva, y la guarda sin emitirla— y la línea con «Descartar». Sin el permiso
  o con el asistente apagado NO DEBERÁ mostrar nada de esto; en modo
  demostración, cada línea DEBERÁ decirlo.
- **AS-116** — MIENTRAS la lectura está en curso la pestaña DEBERÁ decirlo y
  seguir usable; SI falla, ENTONCES DEBERÁ decir el motivo con «Volver a
  pedir» sin quitar lo que había; un candidato «Ya en la orden» y una línea
  sin candidatos DEBERÁN decirlo, sin «Aceptar»; y SI otra pestaña cambió el
  borrador, ENTONCES «Aceptar» NO DEBERÁ pisarlo: DEBERÁ decirlo y dejar la
  propuesta como estaba.
- **AS-117** — CUANDO la orden se guarde con el examen aceptado, la pantalla
  DEBERÁ enlazar la propuesta (AS-109) y mostrarla «Aceptada» con el examen;
  SI el enlace falla, ENTONCES DEBERÁ decir que la orden quedó guardada.

### 34. Lo que falta escribir, sin modelo (C3)

- **AS-118** — MIENTRAS la nota 002 de la atención esté en borrador y la cuenta
  pueda escribirla, la pestaña Nota DEBERÁ mostrar, en una franja al final de
  la nota, «Sin escribir» con las secciones de su plantilla que siguen vacías, en su orden y con su
  título —las opcionales, señaladas como tales, como en el formulario—, sin
  llamar al servidor y con el asistente apagado o sin `assistant:use`; una
  sección DEBERÁ salir de la lista en cuanto tenga texto, sin esperar a que
  se guarde; «Antecedentes» DEBERÁ contar como escrita cuando la ficha la
  cubre (D-125, como al firmar); pulsar una DEBERÁ llevar a su casilla; y SI
  no queda ninguna ni hay preguntas, ENTONCES el bloque NO DEBERÁ mostrarse.
  > SigmAI `templateQuestions`: la plantilla de SigmAI traía una pregunta por
  > sección; la de esta clínica trae su ayuda (D-124), que es lo que se lee.
  > Es la misma regla de `missingSections` (EN-205), para todas las
  > secciones y no sólo las obligatorias (D-253 §1, §2).

### 35. Las preguntas del asistente (C3, P2, P5)

- **AS-119** — CUANDO el profesional de la atención pida las preguntas de una
  atención viva cuya nota 002 está en borrador, el sistema DEBERÁ mandar al
  modelo, seudonimizadas juntas (AS-025), la transcripción —corregida con el
  léxico de AS-092, cada línea con su marcador— y lo que la nota tiene escrito
  en cada sección de texto, delimitados como datos, con la plantilla como
  contexto; y DEBERÁ pedir hasta **5** preguntas cortas que el médico todavía
  podría hacerle al paciente para completar la nota, cada una con el marcador
  de la línea que la motiva y la sección a la que pertenece. SI la
  transcripción está vacía, ENTONCES DEBERÁ rechazarlo con
  `ASSISTANT_TRANSCRIPT_EMPTY`; SI la nota no está abierta en borrador, con
  `ASSISTANT_NOTE_NOT_OPEN`; SI ya hay una revisión de esa atención en curso,
  con `ASSISTANT_READING_IN_PROGRESS`; y quién, dónde y la atención viva, como
  AS-039.
  > La ficha no va (D-249 §1). No se pregunta lo que la conversación o la nota
  > ya responden, ni un diagnóstico (D-249 §2).
- **AS-120** — Una pregunta DEBERÁ mostrarse sólo si su marcador es de una
  línea que se le dio al modelo y esa línea sigue en la transcripción; una sin
  marcador, con uno que no se dio o vacía DEBERÁ descartarse y contarse, nunca
  mostrarse sin su línea; DEBERÁN quedar como mucho **5**, sin dos con el mismo
  texto (sin mayúsculas, tildes ni signos) ni una igual a otra que el
  profesional descartó en esa atención; una sección que no es de texto de la
  plantilla DEBERÁ quedar sin sección; y antes de guardarla DEBERÁ devolver al
  texto los nombres y las fechas, como AS-091.
  > SigmAI `backedQuestions` con el marcador de C2 en vez de una cita
  > literal: el marcador lleva a la línea sin buscar la frase (AS-089).
- **AS-121** — CUANDO el modelo responda, el sistema DEBERÁ guardar la revisión
  —su atención, el intento que respondió, hasta qué milisegundo de la
  transcripción leyó, la huella de lo que la nota tenía escrito, quién la pidió
  y cuándo, cuántas preguntas guardó y cuántas descartó; ningún texto— y cada
  pregunta como una propuesta `note-question` de `ai_suggestion` con su texto,
  su sección y el tramo (`fromMs`, `toMs`) de su línea; la línea NO DEBERÁ
  guardarse fuera de `transcript_segment` (AS-058). La base DEBERÁ rechazar
  aceptar una `note-question`: una pregunta no es un dato de la historia (P1).
- **AS-122** — CUANDO el profesional pida ver las preguntas, el sistema DEBERÁ
  responder las de la última revisión guardada, sin las descartadas, cada una
  con su texto, su sección, su minuto y su línea leída otra vez de la
  transcripción, y si son de demostración; una revisión que no dejó ninguna
  DEBERÁ dejar la lista vacía; una pregunta cuya línea la purga ya borró NO
  DEBERÁ mostrarse; y a cualquier otro que el profesional, lo de AS-039.
  Leer DEBERÁ dejar su `READ` en la bitácora.
- **AS-123** — Una revisión nueva DEBERÁ sustituir a la anterior en pantalla, y
  el modelo DEBERÁ recibir lo que la nota tiene escrito en ese momento, de modo
  que una pregunta que la nota ya responde no vuelva; SI la transcripción leída
  y la huella de la nota son las de la última revisión, ENTONCES el sistema
  DEBERÁ responder ésa sin llamar a nadie.
  > «Desaparece cuando la nota ya la responde» (plan §7 C3): lo decide el
  > modelo al releer, y lo mide SC-093; la pantalla pide la revisión al
  > escribir (AS-131), y repetirla sin cambios no cuesta una llamada.
- **AS-124** — SI el seudonimizador o el proveedor fallan, se acaba el plazo
  (**45 s**) o el techo no admite el intento, ENTONCES el sistema DEBERÁ
  responder el error con su código sin guardar ninguna revisión ni tocar la
  anterior; SI la atención se cerró, o su 002 se firmó, mientras se revisaba,
  ENTONCES NO DEBERÁ guardar nada, ni la revisión ni sus preguntas —una
  atención dada de alta al firmar responde `ASSISTANT_ENCOUNTER_CLOSED`; una
  002 firmada con la atención aún viva (en espera), `ASSISTANT_NOTE_NOT_OPEN`—,
  y la base DEBERÁ rechazar una pregunta o una revisión de una atención sin su
  002 en borrador, también cuando la firma se cruza con el guardado; la respuesta NO DEBERÁ guardarse en ningún caché
  (`no-store`); ninguna línea de log, mensaje de error ni fila de la revisión
  DEBERÁ contener la transcripción, la nota ni una pregunta (sólo cuántas);
  mandarlas DEBERÁ dejar su `EXPORT` en la bitácora; y las marcas que separan
  la conversación de la nota, y el título de la plantilla, DEBERÁN romperse
  si el texto los contiene, también escondidos tras un carácter invisible
  (AS-095).
- **AS-125** — CUANDO el profesional descarte una pregunta («No hace falta»), el
  sistema DEBERÁ hacer lo de AS-038 y exigir lo de AS-039; una pregunta igual
  NO DEBERÁ volver en las revisiones siguientes de esa atención (AS-120), ni
  en la que ya estaba en curso al descartarla.

### 36. Medir y demostrar las preguntas

- **AS-126** — `pnpm eval -- --tareas preguntas` DEBERÁ medir con la función
  del producto, sobre `casos/nota.json` y `casos/nota-reservada.json`, cada
  caso dos veces —con la nota vacía y con la nota de referencia escrita (sus
  hechos en su sección)—, las preguntas mostradas y descartadas por falta de
  línea y el p50 y el p90 de lo que tarda, y DEBERÁ dejar cada pregunta con su
  línea para la revisión a mano de SC-093; fuera del verify y con el tope de
  `--tope-proveedor` de AS-098.
- **AS-127** — DONDE `ASSISTANT_FAKE_PROVIDER` sea `true`, el proveedor de
  demostración DEBERÁ preguntar desde el guion —cada pregunta cuya frase dice
  una línea, con el marcador de esa línea, salvo que la nota ya contenga sus
  palabras de respuesta—, más una con un marcador que no se le dio, para que se
  vea que la barrera no la muestra; y cada pregunta DEBERÁ decir que es de
  demostración (AS-029).

### 37. En la pestaña Nota, las preguntas

- **AS-128** — MIENTRAS la cuenta pueda pedir las preguntas (AS-119) y haya
  transcripción, la franja del final de la nota DEBERÁ ofrecer «Sugerir
  preguntas» —«Revisar de nuevo» si ya hay una revisión— y mostrar en
  «Podría preguntar» cada pregunta con su minuto, su línea al pasar por
  encima y un ✕ que dice «No hace falta»; MIENTRAS revisa,
  DEBERÁ decirlo y dejar la nota usable; SI falla, ENTONCES DEBERÁ decir el
  motivo con «Volver a intentar» sin quitar las que había; y SI las preguntas
  responden 404, ENTONCES NO DEBERÁ mostrar nada del asistente, sólo lo de
  AS-118.
- **AS-129** — CUANDO la escucha se detenga con la nota en borrador, la pantalla
  DEBERÁ pedir una revisión por su cuenta, una vez; NO DEBERÁ pedirla mientras
  se escucha ni al pausar.
- **AS-130** — Lo que llega de una revisión NO DEBERÁ interrumpir: ni aviso
  flotante, ni diálogo, ni mover el foco o la página; sólo cambia el bloque.
- **AS-131** — MIENTRAS haya preguntas del asistente a la vista, CUANDO el médico
  cambie lo escrito en la nota y la nota se guarde, la pantalla DEBERÁ pedir
  una revisión tras **20 s** sin más cambios, y una pregunta que la revisión ya
  no trae DEBERÁ dejar de verse.
- **AS-132** — Una pregunta descartada DEBERÁ dejar de verse en el acto y SI el
  descarte falla, ENTONCES DEBERÁ volver a verse con el motivo.
- **AS-133** — En el teléfono, el bloque DEBERÁ caber sin desbordar a lo ancho
  y cada acción DEBERÁ medir al menos 44 px de alto (ESTANDAR-UI).

### 38. Firmar con el asistente en marcha (E1, U-03, D-247 §7)

- **AS-140** — MIENTRAS el asistente esté capturando la escucha de una
  atención, SI alguien pide firmar una nota en borrador de esa atención a
  su alcance, ENTONCES el sistema DEBERÁ rechazarlo con
  `NOTE_SIGN_WHILE_LISTENING` (409) sin firmar nada. Una escucha en pausa o
  detenida NO DEBERÁ impedir la firma; y una nota fuera del alcance de quien
  firma, o ya firmada, DEBERÁ recibir su respuesta de siempre (404,
  `NOTE_ALREADY_SIGNED`), nunca la que dice qué hace el asistente.
  > Lo que el paciente dice mientras se firma no llegaría a la nota firmada:
  > o se detiene la escucha, o la nota no está terminada. En pausa no entra
  > nada nuevo; se detiene al firmar (AS-143). D-252 §2.
- **AS-141** — MIENTRAS un borrador de la nota de la atención esté en cola o
  redactándose (AS-086), SI alguien pide firmar una nota de esa atención,
  ENTONCES el sistema DEBERÁ rechazarlo con `NOTE_SIGN_WHILE_DRAFTING` (409)
  sin firmar nada.
  > El médico decide si espera lo que el borrador trae o deja de esperarlo
  > (AS-147); firmar no lo decide por él.
- **AS-142** — Interrumpir la atención (EN-167) NO DEBERÁ rechazarse por la
  escucha ni por el borrador, y DEBERÁ hacer lo que hace firmar (AS-143,
  AS-144).
  > Es la salida de una consulta que no puede seguir —el paciente se fue, se
  > descompensó—; bloquearla obligaría a buscar el botón de detener en el peor
  > momento (D-252 §1).
- **AS-143** — CUANDO se firme la nota que da el alta (la 002), se
  interrumpa la atención o se anule, el sistema DEBERÁ, después de guardarlo
  y sin hacer esperar la respuesta, detener la escucha de la atención —lo dicho antes queda, nada después,
  como AS-045— y cancelar los borradores en cola o redactándose: quedan
  fallidos con `ASSISTANT_DRAFT_CANCELLED`, la llamada en curso se corta y
  nada de lo que devuelva se guarda. Un fallo de estos pasos NO DEBERÁ
  convertir la firma en un error: la firma ya está guardada, y el fallo
  queda en el log sin texto.

  > Lo que se cuela entre la comprobación y la firma —una escucha que
  > empieza, un borrador que pide la escucha al detenerse— se detiene aquí.
  > Fuera de la respuesta: detener espera a que el reconocedor entregue lo
  > que tiene (hasta 90 s), y ni el médico ni caja deben esperarlo (revisión
  > del 12-10-2026). Anular también: la atención abierta por error no debe
  > seguir mandando la conversación al proveedor.
  > Lo que se lee de la nota (CIE-10, receta, exámenes) responde a un clic y
  > no corre aparte: una atención cerrada mientras lee no guarda nada (AS-039).

- **AS-151** — CUANDO el profesional detenga la escucha desde un canal que
  no tiene la captura —otra pestaña, un equipo que perdió la red con el canal
  medio abierto—, el sistema DEBERÁ detenerla igual, avisar al canal que la
  tenía (`taken-over`, como AS-054) e ignorar desde entonces sus tramas.
  > Antes se rechazaba: la firma quedaba bloqueada (AS-140) sin nada que
  > detener a la vista, y la única salida era interrumpir una consulta
  > terminada (revisión clínica del 12-10-2026, M1).

### 39. La revisión de lo propuesto (E1, P1, SigmAI RF-I02)

- **AS-144** — CUANDO se firme la 002 de una atención con borrador, el
  sistema DEBERÁ guardar en `ai_suggestion_review`, por cada sección propuesta
  que el médico tuvo delante —las que decidió y las vigentes sin decidir
  (AS-090); no las que un borrador posterior sustituyó sin que nadie las
  decidiera—, la nota firmada, el estado de la propuesta al firmar y la
  **distancia** (AS-022) entre lo propuesto y lo que la nota firmada dice en
  esa sección (vacía si no dice nada). SI no pudo hacerlo al firmar,
  ENTONCES DEBERÁ hacerlo al arrancar la API y después cada día, para toda
  nota firmada a la que le falte.
  > Contra lo FIRMADO: la primera versión firmada de la 002, aunque el
  > barrido llegue después de una enmienda (EN-025). El barrido aísla cada
  > atención: una que falla no deja sin revisar a las demás.
  > «Para cada nota con borrador»: una sección descartada y escrita igual a
  > mano también se mide —es lo que dice si «Descartar» se usa para copiar a
  > mano—. La de una sección aceptada con «Añadir» cuenta lo que el médico ya
  > tenía, como AS-022 (D-252 §4).
- **AS-145** — La base DEBERÁ rechazar una revisión de una propuesta que no
  sea `note-section`, de una nota que no sea la 002 firmada (o sustituida
  por su enmienda) de su atención, con un estado
  distinto del que la propuesta tiene, o con una distancia fuera de [0, 1]; una
  segunda revisión de la misma propuesta; y cualquier cambio o borrado de una
  revisión.
- **AS-146** — Ninguna revisión, línea de log ni mensaje de error DEBERÁ
  contener el texto de la nota ni el de la propuesta: sólo ids, estados,
  distancias y cuántas.

### 40. Dejar de esperar el borrador (E1)

- **AS-147** — CUANDO el profesional de la atención pida dejar de esperar el
  borrador, el sistema DEBERÁ cancelar el que esté en cola o redactándose como
  AS-143, publicar `assistant-draft` (AS-097) y responder lo que la Nota
  muestra (AS-096); sin ninguno en curso, DEBERÁ responder igual sin cambiar
  nada. Quién, dónde y la atención viva, como AS-039. Un borrador cancelado se
  puede volver a pedir (AS-086).

### 41. En la pestaña Nota (solo interfaz)

- **AS-148** — MIENTRAS la escucha esté capturando, o el borrador en cola o
  redactándose, «Firmar…» —y «Terminar y firmar», la salida de la atención—
  DEBERÁ verse deshabilitado y, junto a él, el motivo:
  «Detenga la escucha para firmar.» o «El asistente está redactando el
  borrador.» con «Dejar de esperar» (AS-147); CUANDO la escucha se detenga o
  el borrador termine, DEBERÁ habilitarse sin recargar la página.
- **AS-152** — MIENTRAS la escucha de la atención se capture en otra
  pestaña o equipo, «Firmar…» y «Terminar y firmar» DEBERÁN esperar con «La
  consulta se está escuchando en otra pestaña o equipo: deténgala para
  firmar.», y «Detener» de esta pantalla DEBERÁ detenerla (AS-151).
- **AS-149** — SI el servidor rechaza la firma por AS-140 o AS-141 (la escucha
  o el borrador de otra pestaña), ENTONCES el diálogo de firma DEBERÁ decir el
  motivo con las mismas palabras y la nota DEBERÁ seguir en borrador en
  pantalla.
- **AS-150** — CUANDO la nota quede firmada, la pantalla NO DEBERÁ seguir
  mostrando el control de la escucha ni el bloque «Borrador del asistente».

### 42. El interruptor por sede (A3, P7, D-254)

- **AS-160** — Cada sede DEBERÁ tener el parámetro `assistantEnabled`, que se
  lee y se cambia con los demás parámetros de la sede (`settings:read`,
  `settings:manage`, CF-062 a CF-066) y deja su cambio en la bitácora; una
  sede creada DEBERÁ nacer con él apagado.
  > D-254 §2: las sedes que existían al migrar quedan encendidas, como
  > estaban, para no apagar la presentación; una instalación real migra con
  > ellas apagadas. La respuesta dice además si la instalación tiene el
  > asistente (`assistantAvailable`, `ASSISTANT_ENABLED`): sin él la pantalla
  > no ofrece el interruptor (AS-026).
- **AS-161** — MIENTRAS una sede tenga `assistantEnabled` apagado, toda ruta
  del asistente sobre una atención de esa sede DEBERÁ responder lo mismo que
  a una atención fuera del alcance de quien pide
  (`ASSISTANT_ENCOUNTER_NOT_FOUND`, 404), sin leer la nota, sin llamar al
  seudonimizador ni al proveedor y sin escribir en `ai_run` ni en
  `ai_suggestion`.
  > La sede apagada se resta de las sedes donde se usa el asistente
  > (`withAssistant`, AS-026), como una sede sin `assistant:use`.
  > También el dictado de los signos (AS-180, `withDictation`; D-255 §2),
  > que no pide la autorización de grabar: no guarda ni manda la voz. Se lee en
  > cada petición: encenderla o apagarla no espera a reiniciar la API.
- **AS-162** — CUANDO alguien con `site:read` pida en qué sedes de su alcance
  está encendido el asistente, el sistema DEBERÁ responder sus ids; ninguno
  MIENTRAS `ASSISTANT_ENABLED` no sea `true`.
  > Para que recepción sepa si ofrecer la autorización de grabar (AS-172,
  > AS-173) sin `settings:read` ni `assistant:use`.
- **AS-163** — SI la sede de una atención se apaga con su escucha abierta,
  ENTONCES en la siguiente comprobación (AS-045, cada 5 s como mucho) el
  sistema DEBERÁ detenerla, decírselo al canal (`stopped` con
  `ASSISTANT_ENCOUNTER_NOT_FOUND`) y cerrarlo con **4409**.

### 43. La autorización de grabar (D-221 §3, D-254 §3 a §5)

- **AS-164** — La finalidad `ASSISTANT_RECORDING` —grabar la consulta para el
  asistente— DEBERÁ registrarse, revocarse y listarse como las demás
  autorizaciones opcionales (PD-068 a PD-075), sin canal, una vigente por
  persona; y DEBERÁ valer para todas las atenciones del paciente hasta que se
  revoque.
- **AS-165** — SI la ficha de la atención —o la vigente, si se unificó en
  otra— no tiene una autorización `ASSISTANT_RECORDING` vigente, ENTONCES el
  sistema DEBERÁ rechazar el vale de la escucha (AS-045) con
  `ASSISTANT_RECORDING_NOT_AUTHORIZED` (409) sin darlo, y lo mismo al iniciar
  o reanudar por el canal. Las comprobaciones de AS-045 (atención, sede,
  profesional) DEBERÁN responder antes que ésta.
- **AS-166** — SI la autorización se revoca con la escucha abierta, ENTONCES
  en la siguiente comprobación (AS-045) el sistema DEBERÁ detenerla, decírselo
  al canal (`stopped` con `ASSISTANT_RECORDING_NOT_AUTHORIZED`) y cerrarlo con
  **4409**; lo ya transcrito queda hasta su purga (AS-057), y lo que el
  reconocedor retenía —oído después— DEBERÁ descartarse sin guardarse. Lo
  mismo al apagarse la sede (AS-163).
  > D-254 §4: se grabó con autorización; borrarlo es otra decisión. Lo
  > retenido se descarta (auditoría de seguridad del 12-10-2026, M-2).
- **AS-167** — La lectura de la escucha (AS-056) DEBERÁ decir si la ficha
  tiene la autorización vigente (`recordingAuthorized`).
- **AS-168** — CUANDO el profesional de la atención —con lo que pide AS-045
  salvo la autorización— registre desde la atención la autorización de grabar
  que el paciente le da, el sistema DEBERÁ guardarla como PD-068 con su
  instante y su usuario (PD-069) y una fila `CREATE` en la bitácora (PD-074),
  y responder la lectura de AS-167; SI ya había una vigente, DEBERÁ responder
  igual sin escribir nada.
  > D-254 §3: el paciente la da en el consultorio, delante del médico, que no
  > tiene `patient:write`. Revocarla sigue siendo de la ficha (PD-072).
- **AS-169** — El CIE-10, la receta y los exámenes NO DEBERÁN depender de
  la autorización de grabar: sólo del interruptor de la instalación, el de la
  sede y el permiso. El borrador y las preguntas, que leen la conversación,
  SÍ: sin la autorización vigente, pedirlos DEBERÁ rechazarse con
  `ASSISTANT_RECORDING_NOT_AUTHORIZED` (409) sin llamar a nadie; y SI la
  autorización se revoca o la sede se apaga, ENTONCES ningún borrador
  pedido solo, en cola o pendiente DEBERÁ llegar al proveedor, y el que se
  esté redactando DEBERÁ cancelarse (`ASSISTANT_DRAFT_CANCELLED`).
  > D-254 §6: el CIE-10, la receta y los exámenes leen lo que el médico
  > escribió, no la voz del paciente. Revisión clínica del 12-10-2026 (G1):
  > la transcripción guardada salía al proveedor después de revocar, por el
  > borrador automático y a mano, y por las preguntas.

### 44. En pantalla (solo interfaz)

- **AS-170** — En **Feriados y parámetros → Parámetros por sede**, MIENTRAS la
  instalación tenga el asistente, la pantalla DEBERÁ ofrecer a administración
  el interruptor «Asistente de IA» de la sede, que se guarda con los demás
  parámetros; sin la instalación, NO DEBERÁ mostrarlo.
- **AS-171** — MIENTRAS la sede de la atención tenga el asistente apagado, la
  atención NO DEBERÁ mostrar nada del asistente: ni «Escuchar», ni el
  borrador, ni las propuestas de CIE-10, receta o exámenes, ni las preguntas.
- **AS-172** — En la ficha, junto al teléfono, MIENTRAS alguna sede del
  alcance de quien la mira tenga el asistente encendido (AS-162), la pantalla
  DEBERÁ mostrar el interruptor «Grabar la consulta para el asistente»:
  encenderlo la registra; apagarlo la revoca y pregunta antes (PD-072).
- **AS-173** — Al registrar la llegada, MIENTRAS la sede tenga el asistente
  encendido, quien registra con `patient:write` DEBERÁ ver el mismo
  interruptor, con su estado, para preguntárselo al paciente; NO DEBERÁ
  condicionar la llegada.
- **AS-174** — MIENTRAS la ficha no tenga la autorización vigente, la atención
  DEBERÁ mostrar, en lugar de «Escuchar», «El paciente no ha autorizado grabar
  la consulta.» y «Registrar la autorización…», que pide confirmar que el
  paciente la dio y después ofrece «Escuchar»; SI la escucha se detiene por
  AS-163 o AS-166, ENTONCES DEBERÁ decir por qué.
- **AS-175** — CUANDO recepción registre o revoque la autorización con la
  atención abierta en otra pantalla, la atención DEBERÁ reflejarlo al volver a
  leer la escucha (al enfocar la ventana o tras detener), sin recargar.

### 42. La historia del paciente, sin modelo (B1, P7)

- **AS-200** — CUANDO alguien con `record:read` pida la historia de una ficha
  (`GET /v1/patients/:patientId/clinical-history`), el sistema DEBERÁ
  responder con sus resultados de laboratorio, sus medicamentos y su línea de
  tiempo leídos de la ficha **y de las que absorbió** (`chartScope`, PA-055),
  sólo de las atenciones de las sedes de su alcance (EN-121) y nunca de una
  atención anulada; SI la ficha no existe o fue absorbida, ENTONCES DEBERÁ
  rechazarlo con `CLINICAL_HISTORY_CHART_NOT_OPEN` (409) sin dejar rastro en
  la bitácora, porque no se reveló nada (PA-024). La ruta NO DEBERÁ depender
  de `ASSISTANT_ENABLED` ni de `assistant:use`: no llama a ningún modelo ni
  saca nada de la base (D-256 §1, como AS-118).
  > La respuesta dice si la ficha tiene atenciones en sedes que quien mira no
  > atiende (`hasEntriesOutsideScope`), sin contarlas (D-214 §5, EN-276): de
  > ellas cuelgan los resultados y las recetas que no ve.
- **AS-201** — Un resultado DEBERÁ venir de una orden de laboratorio emitida
  y de un informe **vigente** —ni sustituido por una corrección ni
  cancelado (ORD-151, ORD-152)— y DEBERÁ llevar su determinación, su valor
  (número, código o texto), su unidad, el rango de referencia y la bandera
  **congelados en el informe** (ORD-037, ORD-122), cuándo se observó, la
  orden y la atención de las que sale, si su informe es una **corrección**
  de otro (ORD-151: la pantalla dice «Corregido») y si viene de una ficha
  absorbida (EN-275); los más recientes primero.
- **AS-202** — La bandera de un resultado DEBERÁ ser la que el informe
  guardó, **nunca recalculada** con la edad, el sexo o los rangos de hoy: un
  informe de hace tres años se lee con los rangos de hace tres años. Un
  resultado sin bandera DEBERÁ decirse «sin rango de referencia» y NO DEBERÁ
  contarse como normal ni como fuera de rango (ORD-038).
- **AS-203** — Cada medicamento recetado en una receta **emitida** —ni
  borrador, ni descartada, ni anulada— DEBERÁ salir una vez **por
  presentación**: su concepto del CNMB (o, sin él, su nombre genérico) con su
  concentración, su forma y su vía —el CNMB tiene un concepto por código ATC,
  y prednisona de 20 mg y de 5 mg, o enalapril oral e intravenoso, NO DEBERÁN
  juntarse—, con cuándo se recetó la primera y la última vez, cuántas veces,
  **todas** las dosis y frecuencias que su última receta escribe para esa
  presentación (una pauta en dos líneas son dos dosis) y, si la última
  receta dice cuántos días, hasta qué
  día del calendario de Guayaquil dura: el más lejano que alcanza alguna de
  sus recetas (el día de la emisión es el primero), para que una de cinco
  días escrita mientras corre una de treinta no la acorte.
- **AS-204** — El estado de un medicamento DEBERÁ ser «activo» MIENTRAS el día
  de hoy —por el reloj de la aplicación, en `America/Guayaquil`— no pase del
  último día de su última receta; «terminado» cuando ya pasó; y «sin duración
  escrita» SI su última receta no dice cuántos días, que NO DEBERÁ leerse ni
  como activo ni como terminado. Una receta que **no** lo incluye NO DEBERÁ
  terminarlo (D-256 §2): la receta de un catarro no suspende el enalapril.
- **AS-205** — La línea de tiempo DEBERÁ agrupar por día del calendario de
  Guayaquil, del más reciente al más antiguo: cada visita (el motivo que se
  tomó en la preparación, o «Consulta», con sus diagnósticos vigentes por
  rango, y su sede); cada medicamento el día que empieza —la primera vez, o
  de nuevo tras haber terminado— y el día que termina, si ya pasó y nadie lo
  volvió a recetar antes; y cada resultado **fuera de rango** —bajo, alto o
  crítico— con su valor y su bandera. Lo que se repite NO DEBERÁ escribirse
  otra vez: un medicamento renovado antes de terminar, o hasta **7 días**
  después de su último día, sigue, sin línea nueva (D-256 §2): la receta
  mensual recogida un día tarde no es un tratamiento que se suspende.
  «Termina» DEBERÁ nombrar el curso que terminó, y cada línea de un
  medicamento DEBERÁ decir si su receta es de una ficha absorbida. SI las
  recetas leídas se cortaron por el tope (AS-207), ENTONCES la más antigua
  leída de cada medicamento NO DEBERÁ escribir «Empieza»: pudo empezar
  antes.
- **AS-206** — Las tendencias DEBERÁN poder dibujarse sin juntar lo que no se
  compara: cada resultado numérico DEBERÁ llevar la clave de su serie
  (`seriesKey`: la determinación del catálogo, o su nombre, **con su unidad**),
  de modo que la misma determinación en dos unidades sean dos series.
- **AS-207** — La lectura DEBERÁ dejar **una** entrada en la bitácora de
  accesos, de tipo `patient_clinical_history`, antes de devolver nada, y
  nunca una por resultado (EN-123); y DEBERÁ acotarse sin parámetro de la
  petición: los 300 resultados, las 100 visitas y las 200 recetas más
  recientes; cada lista DEBERÁ llevar su total, su tope y, si se cortó, el
  día del más antiguo leído, para que la pantalla diga «300 de 412, desde el
  …» sin conocer el tope.

### 43. En la pestaña Historia (solo interfaz)

- **AS-210** — La pestaña Historia de la consulta DEBERÁ abrir por «Línea de
  tiempo», que pinta los días de AS-205 con la fecha y, en cada línea, qué es
  (visita, empieza, termina, resultado); un resultado fuera de rango DEBERÁ
  llevar su bandera en palabras («Alto», «Crítico bajo») y su color, nunca el
  color solo.
- **AS-211** — «Laboratorio» DEBERÁ mostrar los resultados **del paciente**
  (AS-201), por día y orden, con su valor, su rango y su bandera en las mismas
  palabras y tonos que el informe de la orden (`flagLabel`, `resultTone`);
  arriba, cuántos fuera de rango tiene el último día con resultados; y NO
  DEBERÁ decir ya «sólo las de esta atención».
- **AS-212** — «Medicamentos» DEBERÁ sustituir a «Recetas»: los medicamentos
  de AS-203 en tres grupos —«Activos» con «hasta el …», «Sin duración
  escrita» y «Terminados» con «terminó el …»—, cada uno con la última dosis y
  frecuencia y «recetado N veces desde …». Las recetas de esta atención
  siguen en la pestaña Receta, y no se repiten aquí.
- **AS-213** — Cada pestaña DEBERÁ decir, cuando aplique, «Hay … en otras
  sedes que usted no atiende» (AS-200), lo que el tope cortó y desde qué día
  (AS-207) —la línea de tiempo, de cada lista que se cortó—, marcar lo que
  viene de una ficha unificada y lo corregido; mientras la historia no ha
  llegado DEBERÁ verse que carga, y NO DEBERÁ decir «no hay» (la regla de
  `PatientRecordTabs`); sin `record:read` DEBERÁ decir que no tiene acceso,
  nunca cargar sin fin.
- **AS-214** — Con más de cuatro pestañas, Historia DEBERÁ usar la pieza de
  pestañas compartida (PA-083, ESTANDAR-UI §12.6 bis), y a 375 px nada DEBERÁ
  desbordar en horizontal.

### 44. En Evolución, las tendencias de los exámenes (solo interfaz)

- **AS-215** — La pestaña Evolución —de la ficha y de la consulta— DEBERÁ
  dibujar, **debajo** de los signos y con la misma gráfica (`VitalsChart`),
  una tendencia por cada serie de AS-206 con **dos o más** valores, en el
  mismo periodo elegido (EN-277); el tooltip de cada punto DEBERÁ decir el
  valor con su unidad, la fecha y la bandera en palabras; y un punto fuera de
  rango DEBERÁ distinguirse sin depender del color; la misma determinación
  en dos unidades DEBERÁ titularse con su unidad; y SI los resultados se
  cortaron, ENTONCES DEBERÁ decir desde qué día se dibujan. NO DEBERÁ repetir una
  cifra que ya es un signo (la hemoglobina tomada en preparación sigue en
  signos; la del laboratorio, aquí).
- **AS-216** — Las tendencias de los exámenes DEBERÁN pedirse sólo al abrir
  Evolución, y sin resultados numéricos repetidos la sección NO DEBERÁ
  mostrarse.
### 48. Dictar los signos (B2)

- **AS-180** — CUANDO alguien con `assistant:dictate-vitals` y `vitals:write`
  en la sede de una atención viva mande la grabación de un dictado a
  `POST /v1/encounters/:id/assistant/vitals-dictation`, el sistema DEBERÁ
  transcribirla con `clinica-ai` en esta máquina y responder lo que se oyó
  (`heard`), los signos leídos como **propuesta** (`signs`, con los nombres de
  la toma: `systolicBp`, `diastolicBp`, `heartRate`, `respiratoryRate`,
  `temperatureC`, `oxygenSaturation`, `weightKg`, `heightCm`) y los que se
  nombraron sin poder leerse (`unclear`); sin llamar a ningún proveedor de
  modelo y sin escribir nada en la atención.
  > Es una propuesta para el formulario, nunca una toma: la toma la escribe
  > «Guardar» por `PUT /v1/encounters/:id/vitals` con su autor (EN-143), como
  > siempre (P1).
- **AS-181** — La lectura DEBERÁ ser la de SigmAI (`dictation.ts`), sin
  modelo: cada signo nombrado se queda con lo dicho hasta que se nombra el
  siguiente; números en cifras o en palabras («ciento cuarenta y cinco»),
  «y medio», «punto» y «coma», la presión «120 con 80», «120 sobre 80»,
  «120/80» y el «110,70» con que whisper escribe «con»; el peso en libras
  pasado a kilos con un decimal; la talla en metros pasada a centímetros; y
  ante «perdón», «no», «digo», «corrijo» o «mejor dicho» seguidos de un
  número, lo que viene después.
- **AS-182** — SI un signo nombrado no se puede leer con certeza —no se dijo
  un número, se dudó («no sé», «espera», «creo», puntos suspensivos), se
  dijeron dos valores distintos para él, está fuera de lo que una persona
  puede medir (`plausibility.ts`) o la diastólica no queda por debajo de la
  sistólica—, ENTONCES el sistema NO DEBERÁ proponer ningún valor para él y
  DEBERÁ nombrarlo en `unclear`. Lo que no se nombró NO DEBERÁ aparecer en
  `signs` ni en `unclear`.
  > Nunca adivina: una casilla vacía la ve quien guarda; un valor mal leído
  > no. Los límites de SigmAI son algo más estrechos que los de la base
  > (EN-062): lo que queda entre los dos se teclea (D-255 §4).
- **AS-183** — La temperatura dicha «axilar» o «bucal» DEBERÁ proponerse en
  `temperatureC`, la única casilla de temperatura de la toma; SI se dicen las
  dos con valores distintos, ENTONCES `temperatureC` DEBERÁ ir en `unclear`.
  > El formulario 020 no distingue el sitio (D-255 §3).
- **AS-184** — Ni la grabación, ni lo que se oyó, ni la propuesta DEBERÁN
  guardarse en la base, en disco del servidor ni en el log; la grabación
  DEBERÁ pasar a `clinica-ai` en memoria y olvidarse al terminar la petición;
  la respuesta DEBERÁ llevar `Cache-Control: no-store`; y un fallo DEBERÁ
  registrarse sólo con su motivo, sus cifras (bytes, segundos) y la atención
  (`encounter_id`), sin texto.
  > SigmAI RF-E09, P3. No se audita como lectura: no lee nada de la historia.
  > En el navegador, los valores propuestos siguen el borrador local de la
  > toma como lo tecleado —con su marca, y se borran al guardar o descartar—;
  > lo oído no se guarda allí (D-255 §8).
- **AS-185** — Quién: sin `assistant:dictate-vitals` en ninguna sede la ruta
  DEBERÁ responder 403; SI la atención no existe o es de una sede donde quien
  pide no tiene a la vez `vitals:write` y `assistant:dictate-vitals`,
  ENTONCES DEBERÁ responder `ASSISTANT_ENCOUNTER_NOT_FOUND` (404); SI la
  atención ya no admite contenido nuevo, ENTONCES
  `ASSISTANT_ENCOUNTER_CLOSED` (409); y con `ASSISTANT_ENABLED` apagado,
  404 antes de todo (AS-026). NO DEBERÁ exigir `assistant:use` ni ser el
  profesional de la atención: la toma la hace enfermería (D-255 §1). Admite
  hasta **30 dictados por minuto** por dirección, como las demás rutas con
  límite (D-251).
- **AS-186** — Fallos, sin llenar nada: una grabación vacía, o que
  `clinica-ai` no pudo leer o en la que no oyó ninguna voz →
  `ASSISTANT_DICTATION_NOT_HEARD` (422), con un título que dice qué hacer y,
  cuando se sabe, cuántos segundos llegaron; más de **8 MB** →
  413 `PAYLOAD_TOO_LARGE` del propio lector del cuerpo, antes de que llegue a
  este módulo ni a `clinica-ai` (como DOC-052); y
  `clinica-ai` sin reconocedor, sin secreto, caído o sin responder en
  **60 s** → `ASSISTANT_DICTATION_UNAVAILABLE` (503), también con más de
  **2 dictados en curso** en la API (el reconocedor es el mismo de la
  escucha). La ruta espera 65 s, no los 15 s de las demás; y SI la pantalla
  abandona la petición, ENTONCES la transcripción DEBERÁ cancelarse.
- **AS-187** — El catálogo DEBERÁ tener el permiso `assistant:dictate-vitals`,
  y los roles de fábrica `ENFERMERIA` y `MEDICO` DEBERÁN traerlo (D-255 §1).
- **AS-196** — CUANDO la pantalla pregunte por el dictado de una atención
  (`GET /v1/encounters/:id/assistant/vitals-dictation`), el sistema DEBERÁ
  responder, con los mismos permisos y rechazos de AS-185, lo que dura como
  mucho un dictado (`maxSeconds`, 120).
  > Es lo que deja a la pantalla ocultar «Dictar» con el 404 del asistente
  > apagado, como las demás funciones (AS-026), sin grabar nada para saberlo.

### 49. Medir el dictado (B2)

- **AS-188** — El arnés de evaluación DEBERÁ medir, con
  `pnpm eval:dictado` y fuera del verify, la lectura del producto —la misma
  función de AS-181 a AS-183— sobre los sets de desarrollo y reservado
  (frases inventadas, `"origin": "invented"`) en dos brazos: el **texto
  escrito** de cada frase y lo que `clinica-ai` **oyó** de ella dicha por
  voces sintéticas del sistema, sin ruido; y DEBERÁ informar, por brazo, por
  voz y por signo, los valores correctos, mal leídos, vacíos e inventados con
  su intervalo de Wilson al 95 %, y cada grave con su texto. No DEBERÁ llamar
  a ningún proveedor de modelo ni leer ninguna base.
  > SigmAI E-055 (`frases.tsv`, `oir.py`, `interpretar.mts`). La voz es la
  > síntesis de macOS, no la de ninguna persona; lo oído se guarda como caso
  > inventado y el audio se borra. Se probó además no leer los números a los
  > que whisper dio poca confianza (CAI-016): ningún umbral dejó a la vez
  > ≥ 93 % y 0 graves en los dos sets —whisper duda también de muchos números
  > correctos y escribió uno mal con seguridad—, así que no entró y su
  > requisito, AS-197, queda muerto (D-255 §7).

### 50. En la pestaña Signos (solo interfaz)

- **AS-189** — MIENTRAS la toma de la atención se pueda escribir y la cuenta
  tenga `assistant:dictate-vitals`, el formulario de la pestaña Signos DEBERÁ
  ofrecer **«Dictar»**; con el asistente apagado o la atención fuera del
  alcance (AS-196 responde 404) NO DEBERÁ mostrarlo.
- **AS-190** — CUANDO se pulse «Dictar», la pantalla DEBERÁ abrir el
  micrófono —o, en desarrollo, el audio de prueba, y decirlo—, con sólo
  «Cancelar» mientras se abre, y mostrar «Dictando…» con el tiempo,
  «Terminar» y «Cancelar»; al llegar a `maxSeconds` DEBERÁ terminar sola, sin
  mandar más de `maxSeconds` de audio. «Cancelar» —también mientras el
  navegador abre el micrófono—, cerrar la tarjeta o que el formulario deje de
  poder escribirse DEBERÁN soltar el micrófono sin mandar nada, y una
  respuesta que llegue después NO DEBERÁ llenar nada. El audio vive sólo en
  la memoria de la pestaña hasta mandarlo.
- **AS-191** — CUANDO llegue la propuesta, cada signo leído DEBERÁ escribirse
  en su casilla con el borde punteado y «Propuesta» (ESTANDAR-UI §6 bis);
  cada signo de `unclear` DEBERÁ vaciar su casilla y marcarla en ámbar con
  «No se entendió: escríbalo»; las casillas no dichas DEBERÁN quedar como
  estaban, con sus marcas de un dictado anterior; y DEBERÁ verse «Se oyó:
  «…»» con todo lo oído en esa toma. Nada DEBERÁ enviarse a la toma hasta
  «Guardar», ni abrir la preparación (AG-122) lo que sólo propuso el
  dictado. La marca de una casilla DEBERÁ irse al cambiarla o al confirmar
  (AS-198), y todas al guardar o al cancelar la corrección; y DEBERÁ
  conservarse con el borrador del navegador, de modo que cambiar de pestaña
  o recargar no convierta un valor dictado en uno tecleado.
- **AS-192** — SI el dictado cambia una casilla que ya tenía un valor
  tecleado, ENTONCES la marca DEBERÁ decir ese valor («Propuesta · antes
  118», «No se entendió: escríbalo · antes 18»), también tras varios
  dictados.
- **AS-193** — SI el dictado falla —micrófono denegado, ausente o perdido a
  mitad, sin voz, demasiado largo, reconocedor no disponible u ocupado—, ENTONCES la pestaña DEBERÁ
  decir en el formulario qué pasó y qué hacer, sin llenar nada ni perder lo
  tecleado.
- **AS-194** — SI la propuesta no trae ningún signo ni ninguno sin entender,
  ENTONCES DEBERÁ decir «No se reconoció ningún signo» con lo que se oyó.
- **AS-198** — MIENTRAS quede alguna casilla con «Propuesta», «Guardar
  signos» NO DEBERÁ poder pulsarse, y junto a él DEBERÁ decirse «Compare lo
  dictado con lo que midió antes de guardar.» con **«Confirmar lo
  dictado»**, que quita las marcas de propuesta (no las de duda); cambiar una
  casilla a mano también la confirma. Tampoco mientras se lee un dictado.
  > Un número mal oído es plausible (SC-096 en rojo, D-255 §7): sólo quien
  > lo compara con lo que midió lo ve. Es la opción (b) de §7, con un solo
  > clic para todas; el autor decide si queda así.
- **AS-195** — A 375 px de ancho, «Dictar», «Terminar» y «Cancelar» DEBERÁN
  medir al menos 44 px de alto y la pestaña no DEBERÁ desbordar.

### 51. Escuchar la preparación (B3)

- **AS-240** — CUANDO alguien con `assistant:dictate-vitals` y `vitals:write`
  en la sede de una atención viva, con el asistente encendido en esa sede,
  pida escuchar la preparación
  (`POST /v1/encounters/:id/assistant/preparation-listening/ticket`), el
  sistema DEBERÁ darle un vale de la escucha **de la preparación** con las
  reglas de AS-045 (un uso, 30 s, en memoria) sin exigir que sea el
  profesional de la atención ni `assistant:use`; SI el paciente no tiene
  vigente la autorización de grabar (AS-164), ENTONCES DEBERÁ responder
  `ASSISTANT_RECORDING_NOT_AUTHORIZED` (409); SI la atención ya tiene escucha
  de la consulta, ENTONCES `ASSISTANT_PREPARATION_OVER` (409): la preparación
  termina donde empieza la consulta; y como AS-185: sin el permiso en
  ninguna sede 403, fuera del alcance 404, atención cerrada 409, asistente
  apagado 404 antes de todo. Cada vale deja su `CREATE` en la bitácora
  (`assistant_preparation_listening`).
  > Se graba la conversación con el paciente, no sólo la voz de quien dicta:
  > por eso pide la autorización que «Dictar» no pide (D-255 §2, D-260).
- **AS-241** — Con el vale de la preparación, el canal de la escucha
  (`/api/v1/assistant/listening`) DEBERÁ comportarse como en AS-046 a AS-055
  —reloj, pausa, reconexión sin pérdida ni duplicados, el audio fuera del
  disco— con **su propio estado y sus propias líneas**, aparte de los de la
  consulta de la misma atención. La base DEBERÁ admitir una escucha por
  atención y ámbito (`CONSULTATION`, `PREPARATION`) y un segmento por
  atención, ámbito e inicio, y rechazar cualquier otro ámbito.
- **AS-242** — Lo transcrito en la preparación NO DEBERÁ leerlo el borrador
  (AS-086), las preguntas (AS-119) ni la revisión al firmar (AS-140), ni
  pedir el borrador por su cuenta (AS-087), ni continuarlo la escucha de la
  consulta; y DEBERÁ purgarse con las reglas de AS-057.
  > La consulta se midió con su propia conversación (SC-091 a SC-094); juntar
  > la de la sala es decisión del autor (D-260 §1).
- **AS-243** — CUANDO la pantalla lea la escucha de la preparación
  (`GET /v1/encounters/:id/assistant/preparation-listening`), el sistema
  DEBERÁ responder su estado, sus líneas en orden y si el paciente tiene la
  autorización de grabar (`recordingAuthorized`), con los permisos y rechazos
  de AS-240 salvo la autorización y la consulta empezada, y dejar su `READ`
  en la bitácora; con la atención ya cerrada, sólo a su profesional
  (`ASSISTANT_ENCOUNTER_CLOSED` a los demás).
  > La leen quienes pueden tomar los signos en la sede, no sólo el
  > profesional (D-260 §2; contrasta con D-247 §3).
- **AS-244** — MIENTRAS la escucha de la preparación esté abierta, al iniciar
  o reanudar y cada ≤ 5 s, el sistema DEBERÁ volver a comprobar la sede
  encendida, la autorización de grabar, que la consulta no haya empezado a
  escucharse y que la atención admita contenido; SI algo falta, ENTONCES
  DEBERÁ detenerla, sin guardar lo que el reconocedor retenía cuando la
  causa es la autorización, la sede o la consulta, y decir por qué, como
  AS-045, AS-163 y AS-166. Firmar la nota también la detiene (AS-143).
  > Los permisos de quien escucha se leen al dar el vale y el canal vive como
  > mucho lo que su sesión (15 min); no se releen cada 5 s, como en la
  > escucha de la consulta (D-260 §12).

### 52. Leer la preparación (B3, P2, P5)

- **AS-245** — CUANDO quien puede escuchar la preparación (AS-240, también
  con la autorización) pida leerla
  (`POST /v1/encounters/:id/assistant/preparation-reading`), el sistema
  DEBERÁ leer la transcripción **guardada** de la preparación, seudonimizarla
  (AS-025), mandarla al nivel `fast` con cada línea marcada (`[L1]`…) y
  delimitada como dato, y responder la propuesta, sus líneas y hasta qué
  minuto cubre (`upToMs`); NO DEBERÁ escribir nada en la toma. SI la
  transcripción no tiene ninguna línea con texto, ENTONCES
  `ASSISTANT_TRANSCRIPT_EMPTY` (422). Mandarla deja su `EXPORT` en la
  bitácora (`assistant_preparation_reading`, EN-122). Admite 30 lecturas por
  minuto por dirección.
- **AS-246** — La propuesta DEBERÁ poder traer cada medida de la toma
  —`weightKg`, `heightCm` y su posición (`heightPosition`: de pie o
  acostado), `headCircumferenceCm`, `abdominalCircumferenceCm`,
  `systolicBp` y `diastolicBp` (dichas juntas o por separado), `heartRate`,
  `respiratoryRate`, `temperatureC`, `oxygenSaturation`, `hemoglobinGDl` y
  `hemoglobinCorrectedGDl`— y el motivo (`presentingComplaint`), **cada uno
  con el inicio de su línea y la frase exacta** de donde sale; lo que no se
  habló NO DEBERÁ aparecer.
- **AS-247** — El sistema DEBERÁ proponer un valor sólo si su frase está en
  su línea de la transcripción guardada —comparadas sin mayúsculas, tildes ni
  signos, tras devolver los nombres que quitó el seudonimizador— y el número
  **dicho** está en la frase, escrito en cifras o en palabras («ciento
  veinte», «treinta y seis y medio», «uno sesenta», «22.5»); el modelo DEBERÁ
  dar el número tal como se dijo y su unidad, y el paso de libras a
  kilogramos y de metros a centímetros DEBERÁ hacerlo el código. Además: dos
  números sólo se leen como uno («uno sesenta», «treinta y seis ocho») si se
  dijeron seguidos y para el campo que les corresponde (metros para la
  talla, décimas para temperatura y hemoglobina); el número DEBERÁ ser del
  campo que lo nombra —el último nombrado antes de él en su frase, o en la
  frase anterior si es la respuesta a una pregunta («¿Cuánto pesa?»
  «Setenta kilos»), o el que le sigue con «de» («treinta y seis y medio de
  temperatura»)— y no estar retirado por una corrección posterior
  («perdón», «mejor dicho»); y la unidad DEBERÁ ser la dicha (libras sólo
  donde se dijo libras, nunca kilos donde se dijo libras; metros sólo bajo
  tres; ninguna para lo que no la lleva). SI no se cumple, ENTONCES el campo
  NO DEBERÁ proponerse y DEBERÁ nombrarse en `unclear`. **Ningún número de
  la propuesta sale del modelo.** Lo que dice el **paciente** (lo que se
  midió en casa, lo que cree que pesa) NO DEBERÁ proponerse: no es la toma.
  > Es lo que hacía preferir las reglas: el modelo puede elegir de qué frase
  > sale un número y a qué casilla va, nunca escribirlo.
- **AS-248** — SI un valor que pasa AS-247 está fuera de lo que una persona
  puede medir —los límites de B2 (`vitals-plausibility.ts`) y, para los
  campos que B2 no tenía, los de la base: perímetro cefálico 20–80 cm,
  abdominal 20–250 cm, hemoglobina 1–25 g/dl—, la diastólica no queda bajo
  la sistólica, la corregida supera a la medida, o se proponen dos valores
  distintos para el mismo campo, ENTONCES NO DEBERÁ proponerse y DEBERÁ ir
  en `unclear`. La posición de la talla DEBERÁ proponerse sólo si su frase
  dice «de pie», «parado», «acostado», «echado» o «decúbito», y nunca sin la
  talla en la misma lectura.
- **AS-249** — El motivo DEBERÁ ser la **frase entera** (≤ 500 caracteres)
  de la transcripción que la lectura atribuye al **paciente** y que contiene
  lo que el lector señaló, así una negación («no me duele el pecho») nunca
  queda fuera; SI no la hay, ENTONCES NO DEBERÁ proponerse ningún motivo.
  > En palabras del paciente, como pide el formulario 020: no se resume ni se
  > reescribe, así no puede inventarse (D-260 §5).
  > Desde AS-282 (D-263), esta frase es la **fuente** del motivo, y lo que
  > se propone en la casilla es su redacción, si pasa sus barreras.
- **AS-250** — La lectura DEBERÁ hacerse **por frase**: cada línea de la
  transcripción partida tras un punto, una interrogación o una exclamación
  (no el punto entre cifras), cada frase con un inicio estimado dentro de su
  línea; y cada frase de la respuesta DEBERÁ llevar quién la dijo
  —`nursing`, `patient` u `other`— deducido por el lector **por lo que
  dice** (quién pregunta, quién responde, quién cuenta su molestia); una
  frase sin etiqueta del modelo DEBERÁ ir como `other`. Ninguna
  característica de la voz DEBERÁ llegar al lector ni guardarse.
  > El reconocedor corta por silencios, no por turnos: una línea de la
  > escucha junta la pregunta de enfermería y la respuesta del paciente
  > (visto en el recorrido de F-03, 13-10-2026).
  > La huella de voz es un dato biométrico (LOPDP art. 26) y midió 85,8 %
  > (`PLAN-ASISTENTE-IA.md` §3).
- **AS-251** — La lectura con proveedor DEBERÁ pedir, además de
  `ASSISTANT_ALLOW_REMOTE`, su propio interruptor
  `ASSISTANT_PREPARATION_REMOTE`, apagado de fábrica hasta medirla (P7).
  SI el asistente no puede leer —cualquiera de los dos apagado, el techo no
  admite el intento, el seudonimizador o el proveedor fallan, o pasan
  **20 s**—, ENTONCES el sistema DEBERÁ leer la transcripción con las
  reglas (AS-253) y responder `reader: rules`, sin hablantes ni motivo, cada
  valor con la única frase que lo dice y, si no hay una sola, en `unclear`;
  sin mandar nada al proveedor si está apagado. La misma preparación leída
  otra vez sin nada nuevo dicho DEBERÁ responderse de memoria (10 min), sin
  volver a pagarla.
- **AS-252** — Ni la propuesta, ni la transcripción, ni las frases DEBERÁN
  guardarse fuera de `transcript_segment` ni llegar al log, a `ai_run` o a un
  mensaje de error; la respuesta DEBERÁ llevar `Cache-Control: no-store`; un
  fallo se registra con su código, la atención y cifras.
  > Con `ASSISTANT_EXCHANGE_LOG` encendido, el texto seudonimizado queda en
  > `ai_exchange` con su purga (AS-014), como el de las demás funciones.
- **AS-253** — La lectura con reglas (AS-181), la misma de «Dictar», DEBERÁ
  además entender la sistólica y la diastólica dichas por separado
  («presión sistólica 120», «diastólica 80»), los perímetros cefálico y
  abdominal, la hemoglobina y la corregida, la posición de la talla («de
  pie», «parado», «acostado»), y responderlos en `signs`, `unclear` y
  `heightPosition`. Al leer una **conversación** (AS-251, AS-254), además,
  una palabra que no es de un signo, un número, una unidad, un enlace ni una
  corrección, dicha **después** del número, DEBERÁ cerrar ese signo; y SI a
  tres palabras o menos de ese cierre se dice otro número, ENTONCES el signo
  DEBERÁ quedar en `unclear`.
  > Lo que falló cuando el autor dictó a su manera (13-10-2026): las reglas
  > no conocían esas palabras y pegaban el número al signo anterior. El
  > cierre no se aplica a «Dictar»: medido con el arnés de B2, convertía un
  > nombre mal oído («hueso» por «peso») en un valor equivocado; sin él,
  > «Dictar» da lo mismo que antes (D-260 §8).
- **AS-254** — DONDE `ASSISTANT_FAKE_PROVIDER` sea `true`, el proveedor de
  demostración DEBERÁ leer la preparación sin red: cada línea con las reglas,
  el hablante por su contenido (la pregunta, enfermería; «me duele»,
  «tengo», el paciente) y el motivo de la primera línea del paciente que lo
  cuenta; y la respuesta DEBERÁ decir que es de demostración (AS-029).

### 53. Medir la preparación (B3, P7)

- **AS-255** — El arnés DEBERÁ medir con `pnpm eval:preparacion`, fuera del
  verify, la lectura del producto —la misma función que usa la ruta— sobre
  el set inventado de preparaciones (≥ 40, de estilos distintos, escrito
  antes de medir, `"origin": "invented"`) y el reservado de B2, en dos
  brazos: el texto escrito por líneas y lo que `clinica-ai` **oyó** de cada
  línea dicha por una voz sintética distinta por persona, sin ruido; y DEBERÁ
  informar SC-099, SC-100 y SC-101 con su intervalo de Wilson, cada grave
  con su texto y la latencia p50/p90, mirando antes de cada intento el tope
  por proveedor del registro compartido (D-241).

### 54. En la pestaña Signos, la escucha (solo interfaz)

- **AS-256** — MIENTRAS la toma se pueda escribir y la lectura de la escucha
  de la preparación responda (AS-243), la pestaña Signos DEBERÁ ofrecer
  **«Escuchar»** junto a «Dictar»; SI el paciente no autorizó grabar,
  ENTONCES en su lugar DEBERÁ decir por qué, sin quitar «Dictar». Escuchando,
  DEBERÁ mostrar el estado con el tiempo, las líneas con su minuto a medida
  que llegan y **«Detener»**; con el asistente apagado (404), nada.
- **AS-257** — CUANDO se detenga la escucha (o se pulse **«Leer de
  nuevo»**), la pantalla DEBERÁ decir «Leyendo…» y llenar cada valor propuesto
  como el dictado de B2 —borde punteado y «Propuesta», «No se entendió:
  escríbalo», «antes …», nada guardado sin «Confirmar lo dictado» y
  «Guardar» (AS-191, AS-192, AS-198)—, con debajo de cada casilla su
  procedencia («Paciente · 00:12 «…»»); el motivo propuesto, igual, en su
  casilla; y con `reader: rules`, **«Leído sin asistente»**.
- **AS-258** — Cada línea DEBERÁ mostrar quién la dijo (Enfermería, Paciente u
  Otro); un toque la cambia **sólo en la pantalla** («Pulse si esto lo dijo
  …»), y la procedencia de las casillas DEBERÁ seguir la etiqueta corregida.
- **AS-259** — SI la escucha o la lectura fallan, ENTONCES la pestaña DEBERÁ
  decir qué pasó sin llenar nada ni perder lo tecleado, y «Dictar» DEBERÁ
  seguir disponible; a 375 px «Escuchar» y «Detener» DEBERÁN medir al menos
  44 px y la pestaña no DEBERÁ desbordar; y el médico DEBERÁ verlo igual en
  la pestaña Signos de la consulta.

### 55. Las alergias y los antecedentes dichos, como registros (D-261, P1, P2)

- **AS-260** — CUANDO se escriba el borrador de la nota de una atención
  (AS-086), el sistema DEBERÁ leer además, de la misma conversación
  seudonimizada y en una llamada aparte (`chart-background`, nivel
  `quality`), lo que se dijo de la ficha del paciente: **«sin alergias
  conocidas»**, cada **alergia** con su sustancia y su reacción si se dijo, y
  cada **antecedente** personal o familiar con su descripción y, si es
  familiar, el parentesco; y DEBERÁ guardarlo como propuestas de la clase
  `chart-allergy`, `chart-no-allergy` y `chart-history`, cada una con el minuto
  de su línea (P2). Lo que esa llamada no pueda leer no DEBERÁ hacer fallar el
  borrador: el borrador se guarda y la lectura de la ficha queda en el log con
  su código.
  > Cambia D-249 §1 (D-261): lo que la conversación dice de la ficha va a la
  > ficha y no a la prosa; la ficha registrada sigue sin ir al modelo.
- **AS-261** _(solo interfaz)_ — En la sección de antecedentes de la nota,
  bajo **Alergias** y bajo **Antecedentes**, cada propuesta de la ficha DEBERÁ
  verse en su fila con «Propuesta», lo que se registraría («Sin alergias
  conocidas», «Amoxicilina · ronchas», «Hipertensión arterial · Madre») y su
  frase subrayada con su minuto, un ✓ y un ✕. El ✓ DEBERÁ registrarla por la
  ruta de siempre, con el médico como autor, y enlazarla (AS-265); la fila
  desaparece y el registro aparece en su tabla. El «sin alergias» en conflicto
  (AS-264) DEBERÁ decir «La ficha tiene alergias registradas» y no tener ✓.
- **AS-262** — El sistema DEBERÁ descartar, sin mostrarlas y contándolas, las
  propuestas de la ficha cuya línea no existe; la alergia cuya sustancia no se
  dice en su línea; el antecedente familiar sin parentesco de la lista cerrada
  (`Madre`, `Padre`, `Hermano`, `Hermana`, `Hijo`, `Hija`, `Abuelo`, `Abuela`,
  `Tío`, `Tía`) o cuyo parentesco no se dice en su línea («mamá» dice
  `Madre`); y el «sin alergias» de una lectura que también propone una
  alergia. La descripción va en el español de la clínica («Hipertensión
  arterial»), no como la dijo el paciente («es hipertensa»).
- **AS-263** — `GET /v1/encounters/:id/assistant/chart` DEBERÁ responder, al
  profesional de la atención con `assistant:use`, las propuestas de la ficha
  de la última lectura, sin las descartadas ni las que la ficha ya tiene: una
  alergia activa de la misma sustancia, un antecedente vigente con la misma
  clase, descripción y parentesco, o un «sin alergias» vigente. Cada una con su
  frase, su minuto y su estado.
- **AS-264** — SI la ficha tiene una alergia activa, el sistema DEBERÁ mostrar
  el «sin alergias» propuesto con `conflict: 'active-allergy'` y nunca
  aceptarlo: lo dicho hoy contradice lo registrado, y lo decide el médico en la
  ficha.
- **AS-265** — CUANDO el médico registre una propuesta por la ruta de siempre
  (`POST /v1/patients/:id/allergies`, `…/allergies/none-known` o `…/history`,
  con sus validaciones y él como autor) y pida
  `POST /v1/encounters/:id/assistant/chart/:suggestionId/accept` con el id de
  lo registrado, el sistema DEBERÁ enlazar la propuesta a ese registro si es
  de la ficha del paciente de la atención, de la clase de la propuesta, lo
  registró quien acepta y después de proponerse; si no, `SUGGESTION_CHART_MISMATCH`
  (422) y nada cambia. `…/discard` la descarta (AS-038).
- **AS-266** — La base DEBERÁ garantizar que una propuesta de la ficha
  aceptada enlaza exactamente un registro de su clase (`patient_allergy`,
  `patient_allergy_absence` o `patient_history`) y que ese registro es del
  paciente de su atención.

### 56. Diagnósticos de un toque y sin síntomas sueltos (D1, P5)

- **AS-267** — SI entre los problemas leídos de la nota hay uno cuyo código
  propuesto no es del capítulo XVIII de la CIE-10 (R00–R99), el sistema NO
  DEBERÁ proponer ningún código de ese capítulo: el problema que sólo tiene
  códigos R se muestra como frase del primer problema con diagnóstico
  (`symptoms`) y no como problema aparte, y los códigos R de las alternativas
  se quitan. Sin diagnóstico definido, los síntomas se proponen como hoy.
  > La convención de la CIE-10 (cap. XVIII): un síntoma que explica un
  > diagnóstico definido no se codifica aparte.
- **AS-268** _(solo interfaz)_ — Cada código ofrecido de un problema, el
  propuesto y la alternativa, DEBERÁ ser su propio botón ✓ «J03.9 Amigdalitis
  aguda, no especificada»; un toque DEBERÁ registrar el diagnóstico por la ruta
  de siempre con **Presuntivo**, la ocurrencia que propone el sistema (EN-184)
  y **principal** si la atención no tiene uno, y enlazar la propuesta
  (AS-037). La fila DEBERÁ decir entonces «Registrado · <código>» con
  **Editar**, que abre el diálogo de hoy; ✕ descarta. SI la propuesta de la
  ocurrencia no llega, el toque DEBERÁ abrir «Registrar diagnóstico» con el
  código puesto, como hoy.

### 57. La receta completa (D2, P5)

- **AS-269** — La concentración escrita DEBERÁ leerse en la forma del cuadro:
  «500 miligramos», «500mg» y «500 mg» son `500 mg`; y una cifra sola («de
  500») DEBERÁ tomarse como la concentración de la única presentación del
  medicamento que la tiene en su unidad, marcada «Nadie lo dijo»
  (`unsaid: 'presentation'`). Con más de una, la concentración queda vacía.
- **AS-270** — SI el modelo no elige presentación, o elige una que contradice
  lo escrito, el sistema DEBERÁ elegir la **única** presentación del
  medicamento compatible con la forma y la concentración escritas; con
  ninguna o más de una, la deja vacía y dice por qué (`presentationGap:
  'none' | 'several'`).
- **AS-271** _(solo interfaz)_ — Lo que el sistema dedujo y nadie dijo —la
  presentación o su forma, la vía, la dosis de una unidad, la cantidad total—
  DEBERÁ verse llenado y marcado «Nadie lo dijo» campo por campo, en la fila y
  en la línea del borrador; y SI quedó una presentación vacía, su porqué en una
  línea («Hay varias presentaciones: elíjala»).
- **AS-272** — La forma dicha («cápsula», «tableta») DEBERÁ ser la forma de
  la línea cuando la presentación la admite, y la vía oral del cuadro DEBERÁ
  llenarse marcada «Nadie lo dijo»; una dosis dicha en unidades («una
  cápsula») sin su unidad escrita DEBERÁ tomar la unidad de la forma. Las
  barreras de D2 siguen: la alergia falla cerrada (AS-070) y no se calcula
  ninguna dosis por peso (AS-068, D-084 §5).
- **AS-273** — El borrador de la nota DEBERÁ escribir cada medicamento del
  plan con todo lo que se dijo de él: concentración, forma, dosis, vía,
  frecuencia, duración y la condición («si tiene fiebre o dolor»), para que la
  receta lo lea; y NO DEBERÁ escribir en prosa las alergias, «sin alergias» ni
  las enfermedades del paciente o de su familia, que van a la ficha (AS-260):
  en antecedentes, sólo lo demás que se dijo (`c2-draft-4`).

### 58. Un ✓ por medicamento (D2, P1)

- **AS-274** _(solo interfaz)_ — Cada línea de la receta propuesta que se
  puede añadir DEBERÁ tener un ✓ «Añadir a la receta»; un toque DEBERÁ pasarla
  al borrador de la receta (AS-073), guardarlo sin emitir y enlazar la
  propuesta (AS-074), y la fila DEBERÁ decir «En la receta» con **Quitar**,
  que la saca del borrador y lo guarda. Desaparecen «Aceptada» y «Confirmar la
  receta». Una línea bloqueada por alergia, fuera del CNMB o ya recetada no
  tiene ✓ (AS-071).
- **AS-275** — `GET …/assistant/prescription` DEBERÁ decir de cada línea
  enlazada si su medicamento sigue en el borrador o la receta enlazada
  (`inPrescription`), para que la fila diga «En la receta» o «Se quitó de la
  receta» también tras recargar.

### 59. Las preguntas sin repetir (C3)

- **AS-276** — Dos preguntas DEBERÁN considerarse la misma cuando dicen lo
  mismo con otras palabras: las mismas palabras de contenido en cualquier
  orden, sin tildes ni mayúsculas, sin las palabras vacías ni los verbos de
  pregunta («presenta», «tiene», «ha tenido»), o casi todas (≥ 0,75 de
  coincidencia). Una pregunta igual a una ya propuesta en la atención DEBERÁ
  mostrarse con la redacción de la primera; una revisión no DEBERÁ mostrar dos
  iguales; y una descartada no DEBERÁ volver con ninguna redacción.

### 60. Medir y demostrar (P7)

- **AS-277** — El arnés DEBERÁ medir, fuera del verify, SC-102 a SC-104 con
  el camino del producto: la receta (`prescription-from-note`) y los problemas
  (`cie10-by-problem`) sobre sus sets con el libreto y tres variantes, y una
  tarea nueva `chart-background` sobre conversaciones inventadas con sus
  alergias y antecedentes esperados; sin ningún dato real.
- **AS-278** — El guion del modo de demostración DEBERÁ responder a la
  conversación del libreto: «sin alergias conocidas» e «Hipertensión
  arterial · Madre»; el problema «Amigdalitis aguda» con J03.9 y J02.9 y los
  síntomas «Dolor de garganta» (R07.0) y «Fiebre» (R50.9), que la barrera de
  AS-267 vuelve frases; y la amoxicilina y el paracetamol con lo que el
  libreto dice de ellos.
- **AS-279** _(solo interfaz)_ — A 375 px de ancho, cada ✓ y cada ✕ de las
  propuestas de Antecedentes, Diagnósticos y Receta DEBERÁN medir al menos
  44 px de alto y la página no DEBERÁ desbordar a lo ancho.

### 61. La talla dicha con «y» y el motivo redactado (B3, D-263, P2, P5)

- **AS-280** — El lector de números (el de «Dictar», las reglas y la
  barrera de AS-247) DEBERÁ leer como **un solo número**, en la talla y en
  las medidas que se dicen enteras (presión, pulso, frecuencia
  respiratoria, saturación), una decena o una centena escrita en cifras
  (20, 30… 90, 110… 190, 210…; en la talla, sólo desde 110; nunca 100, 200
  ni un número que no termine en cero) seguida de «y» y de una sola unidad
  del 1 al 9, en cifras o en palabras, que no cuente otra cosa («litros»,
  «l», «lpm», «veces», «días»…): «talla
  150 y 8» es 158, «saturación 90 y 4» es 94, «talla 150 y ocho» es 158; y
  «ciento cincuenta y ocho», como hasta hoy, 158. La frase citada DEBERÁ
  seguir siendo la dicha. NO DEBERÁ unir lo que no es esa forma —«presión
  120 y 80», «36 y medio», «18 y 97», «70 y 2.5», «saturación 90 y 3
  litros»— ni nada en la temperatura, los perímetros, la hemoglobina y el
  peso, ni en una talla bajo 110, que siguen como antes («temperatura 40 y
  2» es 40,2; «peso 70 y 5» y «talla 50 y 5» no se proponen; D-263 §3). En esos campos, la barrera de AS-247 NO DEBERÁ
  proponer ninguno de los dos números de un «X y U»: «peso 80 y 3» no es
  un peso de 3.
  > Whisper escribe así lo que se dice «ciento cincuenta y ocho»; es la
  > forma que el reconocedor deja, no la que alguien dicta. En los campos
  > con décimas «40 y 2» ya era 40,2 (revisión clínica G1).
- **AS-281** — La lectura del asistente DEBERÁ pedir al modelo, para el
  motivo, además de la línea y la frase copiada del paciente, su
  **redacción** (`written`): como la escribe la enfermera, en tercera
  persona o sin persona, sin muletillas ni vocativos («ay», «señorita»,
  «doctora», «mire») y concisa; y el modelo DEBERÁ dar el número de «150 y
  8» como 158.
- **AS-282** — El motivo propuesto DEBERÁ ser la redacción SÓLO SI, frente
  a la frase entera de AS-249 (su **fuente**): (a) no es más larga que
  ella ni que 500 caracteres; (b) cada palabra suya la dijo el paciente
  **en el mismo orden** —comparadas sin mayúsculas, tildes ni signos: la
  misma palabra o con otro género o número, nunca por una raíz común, y
  «dolor» por «duele» (nunca por «dolió» ni «dolía»), «mareo» por
  «mareada», «siente» por «siento»—, salvo
  las de enlace y de redacción («de», «con», «desde», «hace», «sensación»,
  «refiere»…; nunca «al», «por» ni «para», que añaden una causa, ni
  «unos», «varios», que cambian una cantidad); (c) cada palabra con
  contenido que dijo el paciente está en ella, salvo muletillas,
  vocativos, la primera persona y verbos de apoyo en presente («tengo»,
  «me siento», «vengo»); (d) dice los mismos números que la fuente, «un
  día» como 1; y (e) no niega nada. Y NO DEBERÁ creerse ninguna redacción si la fuente niega
  algo (sin contar el «no sé» que duda ni el «¿no?» final), nombra a otra
  persona («mi mamá», «mi hijito», «mi señora», «la guagua», «le duele»,
  «a ella»…), lleva un posesivo («mi», «su»…), se aparta de otro con «yo»
  o «a mí», o usa un verbo de otra
  persona («tiene», «está», «siente»: «el niño tiene fiebre y yo tengo
  tos»), dice derecha e izquierda, o trae más de
  una duración o más de un número: lo que una comparación palabra por
  palabra no distingue; ni una redacción que nombre a alguien que el
  seudonimizador quitó. SI no las pasa, o el modelo no la da, ENTONCES el
  motivo DEBERÁ ser la frase entera, como AS-249. La respuesta DEBERÁ
  llevar, en `complaint`, el texto propuesto (`text`), su fuente (`quote`)
  y su inicio (`startMs`).
  > Lo que el modelo escribe sólo se cree si dice todo lo que dijo el
  > paciente y nada más (P2). La revisión clínica mostró que comparar
  > palabras sueltas deja pasar una negación invertida, duraciones
  > cruzadas, un síntoma quitado o el de otra persona; en esos casos queda
  > lo literal, que nunca se inventa.
- **AS-283** — DONDE `ASSISTANT_FAKE_PROVIDER` sea `true`, el lector de
  demostración DEBERÁ redactar el motivo sin red: quitar del comienzo de la
  frase las muletillas y los vocativos y un «tengo», empezar «me duele…»
  como «Dolor en…» y pasar «me siento» a «se siente»; y su redacción DEBERÁ
  pasar las mismas barreras (AS-282).
- **AS-284** — El arnés (`pnpm eval:preparacion`) DEBERÁ medir además un set
  propio (`eval/casos/preparaciones-motivo.json`, inventado, escrito antes
  de medir) con la frase del autor tal como la escribió el reconocedor,
  variantes «X y Y» en talla, peso, presión y perímetro, los falsos
  positivos de AS-280, motivos con muletillas y motivos que DEBEN quedar
  literales (una negación, otra persona, dos duraciones, derecha e
  izquierda, un síntoma de alarma junto a otro); aceptar como dicho
  literalmente un número escrito «150 y 8» en los campos de AS-280
  (SC-099); contar como **grave** cada motivo que debía quedar literal y
  salió redactado, que DEBERÁ ser **0**; e informar qué parte de los demás
  motivos propuestos sale **redactada** —sin primera persona («me», «mi»,
  «tengo», «estoy»), sin muletillas ni vocativos y distinta de la frase—
  con su intervalo de Wilson, que con el proveedor principal DEBERÁ ser
  **≥ 90 %**.
- **AS-285** _(solo interfaz)_ — La casilla del motivo DEBERÁ llamarse
  **«Motivo de consulta»** en la toma, con la ayuda «Lo que refiere el
  paciente», y en su lectura guardada, sin ayuda (D-263 §2).
- **AS-286** _(solo interfaz)_ — Bajo el motivo propuesto, la procedencia
  DEBERÁ citar la **fuente** («Paciente · 00:07 «Ay, señorita, tengo…»»), no
  la redacción, y abrir la transcripción en esa frase como las demás.

### 62. Lo que la prueba de Carmen enseñó (D-263, D-265 §2 y §4, P1, P5)

- **AS-290** — Una fracción «N/M» de una frase del borrador DEBERÁ tenerse por
  dicha, y no por una fecha no dicha (AS-091), cuando la conversación dice «N
  de M» o «N sobre M» con esos mismos números («intensidad 3/10» por «un 3 de
  10»). Una «N/M» que la conversación no dice así sigue marcada «Nadie lo
  dijo».
- **AS-291** — Lo que la nota manda **seguir tomando** («continuar con»,
  «siga con», «como siempre», «de manera habitual») sin decir dosis,
  frecuencia ni duración NO DEBERÁ proponerse como línea de receta: no es una
  receta nueva. Con alguna de ellas dicha, se propone como hoy.
- **AS-292** — `GET …/assistant/chart` DEBERÁ decir de un antecedente
  propuesto que la ficha ya tiene con otras palabras (`alreadyAs`, el texto de
  la ficha): del mismo tipo, con el mismo parentesco y con una palabra de
  enfermedad de la misma raíz (las seis primeras letras: «HIPERTENSO» e
  «Hipertensión arterial», «DIABETES» y «Diabetes mellitus»). La ficha no
  DEBERÁ mandarse al modelo; un antecedente igual al de la ficha sigue sin
  mostrarse (AS-263).
- **AS-293** _(solo interfaz)_ — Un antecedente con `alreadyAs` DEBERÁ decir
  «Ya consta como <texto de la ficha>» y NO DEBERÁ tener ✓; sólo ✕.
- **AS-294** — El motivo de la preparación DEBERÁ poder citar **varias líneas
  seguidas** del paciente (`complaint.toLine`): su fuente es esas líneas
  unidas, hasta 500 caracteres, y SI entre ellas hay una que no dijo el
  paciente, o no son seguidas, ENTONCES el motivo DEBERÁ ser sólo la primera.
  Las barreras de AS-282 se aplican a la fuente unida.
- **AS-295** — SI la frase de un valor de la preparación nombra **otro**
  signo del que el modelo propone («frecuencia cardíaca 16» propuesto como
  FR) y lo demás de AS-247 se cumple, ENTONCES el sistema DEBERÁ proponerlo
  aparte, como **dudoso** (`doubtful`: campo, valor, frase, inicio y el signo
  que la frase nombra), y NO DEBERÁ ponerlo entre los valores propuestos. Un
  campo que ya tiene un valor creído no tiene dudoso.
- **AS-296** _(solo interfaz)_ — Un valor dudoso DEBERÁ verse en ámbar con
  su frase y el aviso «La frase dice <signo>», y NO DEBERÁ llenar su casilla
  hasta que quien prepara lo confirme con un toque.
- **AS-297** — CUANDO el médico dice en voz alta su impresión diagnóstica, el
  borrador DEBERÁ escribirla al comienzo del Plan de tratamiento como
  «Impresión diagnóstica: …» con su línea; y la lectura de problemas DEBERÁ
  tomarla como el problema, con los síntomas que explica dentro de él y no
  aparte (AS-267). Sin impresión dicha, como hoy.
- **AS-298** _(solo interfaz)_ — CUANDO el borrador de la nota se relee con
  preguntas a la vista, la pantalla DEBERÁ pedir una revisión de las
  preguntas (AS-119), para que la respondida se retire (AS-122).
- **AS-299** — `GET …/assistant/certificate` DEBERÁ proponer, sin modelo y
  leyendo la conversación, el certificado dicho: el **tipo** (`MEDICAL_REST`
  por «certificado de reposo», `ATTENDANCE` por «certificado de asistencia»)
  y, en el reposo, los **días** dichos («por un día», «por 3 días»), cada uno
  con su frase y su inicio; `null` si no se dijo, o si la frase lo niega. Nada
  se emite: el médico lo emite como hoy (D-265 §4).
- **AS-300** _(solo interfaz)_ — En Certificados, la propuesta DEBERÁ verse
  como «Reposo · 1 día» con sus frases y un botón **Usar** que abre «Emitir
  certificado» con el tipo y el reposo desde el día de la atención por esos
  días puestos.
- **AS-301** — El arnés DEBERÁ tener el caso de Carmen (la transcripción
  seudonimizada) con lo esperado del libreto: en la preparación, el motivo de
  L4 a L6 y la FR de L20; SC-099 sigue midiéndose igual.

---

## Códigos de error nuevos

| Código                                  | Clase base             | HTTP      | Cuándo                                                                                                                                        |
| --------------------------------------- | ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSISTANT_NOT_CONFIGURED`              | `ExternalServiceError` | 502       | La cadena está vacía (AS-006)                                                                                                                 |
| `ASSISTANT_PROVIDER_FAILED`             | `ExternalServiceError` | 503 / 502 | Ningún proveedor respondió (reintentable, AS-007) o el modelo falló (AS-008)                                                                  |
| `SUGGESTION_ALREADY_DECIDED`            | `ConflictError`        | 409       | La propuesta ya se aceptó o se descartó (AS-023)                                                                                              |
| `SUGGESTION_NOT_FOUND`                  | `NotFoundError`        | 404       | La propuesta, o su atención, no existe o está fuera del alcance (AS-021)                                                                      |
| `SUGGESTION_INVALID`                    | `ValidationError`      | 422       | Fuentes que no son un lugar conocido, o aceptar sin nada guardado (AS-020)                                                                    |
| `ASSISTANT_SPENDING_CEILING_REACHED`    | `QuotaExceededError`   | 429       | El techo del mes no admite el intento, o no hay techo (AS-017)                                                                                |
| `ASSISTANT_NOTE_EMPTY`                  | `ValidationError`      | 422       | La nota de la atención no tiene texto del que leer problemas (AS-028)                                                                         |
| `ASSISTANT_NOT_ENCOUNTER_OWNER`         | `ForbiddenError`       | 403       | Quien pide no es el profesional de la atención (AS-039)                                                                                       |
| `SUGGESTION_DIAGNOSIS_MISMATCH`         | `ValidationError`      | 422       | El diagnóstico con que se acepta no es de esa atención o no está (AS-037)                                                                     |
| `ASSISTANT_ENCOUNTER_NOT_FOUND`         | `NotFoundError`        | 404       | La atención no existe o es de una sede fuera del alcance (AS-039, EN-121)                                                                     |
| `ASSISTANT_ENCOUNTER_CLOSED`            | `ConflictError`        | 409       | La atención ya no admite contenido clínico nuevo (AS-039)                                                                                     |
| `ASSISTANT_PROPOSAL_NOT_KEPT`           | `ExternalServiceError` | 503       | El modelo respondió pero su intento no quedó en `ai_run` (AS-036, AS-040)                                                                     |
| `ASSISTANT_READING_IN_PROGRESS`         | `ConflictError`        | 409       | Ya hay una lectura de esa atención en curso (AS-040)                                                                                          |
| `ASSISTANT_PSEUDONYMIZER_FAILED`        | `ExternalServiceError` | 503 / 502 | `clinica-ai` no respondió (reintentable) o respondió fuera de contrato (AS-033)                                                               |
| `ASSISTANT_LISTENING_UNAVAILABLE`       | `ExternalServiceError` | 503       | `clinica-ai` no puede escuchar: sin reconocedor, sin detector de voz o caído (AS-048)                                                         |
| `ASSISTANT_LISTENING_NOT_OPEN`          | `ConflictError`        | 409       | Una orden de pausar o una trama sin escucha abierta en ese canal (AS-049)                                                                     |
| `ASSISTANT_LISTENING_FAILED`            | `ExternalServiceError` | 503       | Una orden de la escucha falló por algo que no es del médico: la base, un fallo (AS-058)                                                       |
| `ASSISTANT_ALLERGY_CHECK_FAILED`        | `ExternalServiceError` | 503       | Las alergias del paciente no se pudieron leer o comparar: nada se propone ni se confirma (AS-070)                                             |
| `ASSISTANT_ALLERGY_CONTRAINDICATION`    | `ConflictError`        | 409       | Una línea a confirmar coincide exactamente con una alergia (AS-071, AS-073)                                                                   |
| `ASSISTANT_PRESCRIPTION_LINE_NOT_READY` | `ValidationError`      | 422       | Una línea a confirmar no es de la última lectura, ya se decidió, no tiene medicamento del CNMB o ya está en la receta (AS-073)                |
| `SUGGESTION_PRESCRIPTION_MISMATCH`      | `ValidationError`      | 422       | La receta con que se enlaza no es de la atención, está descartada o no tiene esa línea (AS-074)                                               |
| `SUGGESTION_ORDER_MISMATCH`             | `ValidationError`      | 422       | La orden con que se enlaza no es de la atención, está descartada, no tiene ese examen o el examen no es un candidato de la propuesta (AS-109) |

| `ASSISTANT_TRANSCRIPT_EMPTY`         | `ValidationError`      | 422       | No hay transcripción de la que redactar el borrador (AS-086) |
| `ASSISTANT_NOTE_NOT_OPEN`            | `ConflictError`        | 409       | La atención no tiene la nota 002 abierta en borrador (AS-086, AS-094) |
| `ASSISTANT_DRAFT_INTERRUPTED`        | `ExternalServiceError` | 503       | La API se reinició mientras redactaba el borrador (AS-093) |
| `ASSISTANT_DRAFT_FAILED`             | `ExternalServiceError` | 503       | El borrador falló por algo que no es del médico: la base, un fallo (AS-093) |
| `ASSISTANT_DRAFT_RETRY_LIMIT`        | `QuotaExceededError`   | 429       | «Volver a pedir» sobre un tramo que ya falló tres veces (AS-093) |
| `ASSISTANT_DRAFT_CANCELLED`          | `ConflictError`        | 409       | El borrador se canceló: se firmó la nota o el médico dejó de esperarlo (AS-143, AS-147) |
| `NOTE_SIGN_WHILE_LISTENING`          | `ConflictError`        | 409       | Se pidió firmar mientras el asistente escucha la atención (AS-140). Vive en `encounter` |
| `NOTE_SIGN_WHILE_DRAFTING`           | `ConflictError`        | 409       | Se pidió firmar mientras se redacta el borrador de la nota (AS-141). Vive en `encounter` |
| `CLINICAL_HISTORY_CHART_NOT_OPEN`    | `ConflictError`        | 409       | La ficha de la historia no existe o la absorbió una unificación (AS-200)     |
| `ASSISTANT_PREPARATION_OVER`         | `ConflictError`        | 409       | La consulta de la atención ya se escucha: la preparación terminó (AS-240, AS-244) |
| `SUGGESTION_CHART_MISMATCH`          | `ValidationError`      | 422       | Lo registrado con que se acepta una propuesta de la ficha no es de su paciente, de su clase, de quien acepta o es anterior a ella (AS-265) |

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
| AS-086 (la base), AS-090, AS-094, AS-096, AS-097 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-087, AS-088, AS-089, AS-091, AS-092, AS-093, AS-095, AS-099 | Unitario con seudonimizador, proveedor, reloj y almacenes falsos |
| AS-098 | Arnés (`eval/`), fuera del verify |
| AS-100, AS-101, AS-102 | Componente y composable; recorrido F-04 con el audio de prueba |
| AS-119 a AS-125 | Unitario con seudonimizador, proveedor, reloj y almacenes falsos |
| AS-119, AS-121 (la base), AS-122, AS-123, AS-125 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-126 | Arnés (`eval/`), fuera del verify |
| AS-127 | Unitario del proveedor de demostración |
| AS-118, AS-128 a AS-133 | Componente y composable; recorrido F-04 con el audio de prueba |
| AS-200 a AS-207 (la base) | Integración HTTP contra PostgreSQL, con control positivo |
| AS-203, AS-204, AS-205, AS-206 (el cálculo) | Unitario del dominio con el día de hoy inyectado |
| SC-097 | Guion contra la API de la rama en marcha, fuera del verify |
| AS-210 a AS-216 | Componente; recorrido F-04 |
| AS-030 a AS-034                        | Unitario con `fetch` falso; AS-031 y AS-032 sobre `env.schema`; prueba manual contra `clinica-ai` en marcha |
| AS-063 a AS-073, AS-077, AS-078 | Unitario con seudonimizador, proveedor y lector de alergias falsos |
| AS-064, AS-069, AS-070, AS-072 a AS-076 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-079 | Arnés (`eval/`), fuera del verify |
| AS-080 a AS-082 | Componente de la pestaña y recorrido F-05 |
| AS-103 a AS-108, AS-110, AS-112, AS-113 | Unitario con seudonimizador, proveedor y catálogo falsos |
| AS-104, AS-106, AS-107, AS-109 a AS-111 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-109 (la base) | Integración contra PostgreSQL, con control positivo |
| AS-114 | Arnés (`eval/`), fuera del verify |
| AS-115 a AS-117 | Componente de la pestaña y recorrido F-05 |
| AS-140 a AS-142, AS-144, AS-147 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-143, AS-146, AS-151 | Unitario con almacenes, reloj, reconocedor y proveedor falsos |
| AS-145 | Integración contra PostgreSQL, con control positivo |
| AS-148 a AS-150, AS-152 | Componente y composable; recorrido F-04 con el audio de prueba |
| `ASSISTANT_TRANSCRIPT_EMPTY` | `ValidationError` | 422 | No hay transcripción de la que redactar el borrador (AS-086) |
| `ASSISTANT_NOTE_NOT_OPEN` | `ConflictError` | 409 | La atención no tiene la nota 002 abierta en borrador (AS-086, AS-094) |
| `ASSISTANT_DRAFT_INTERRUPTED` | `ExternalServiceError` | 503 | La API se reinició mientras redactaba el borrador (AS-093) |
| `ASSISTANT_DRAFT_FAILED` | `ExternalServiceError` | 503 | El borrador falló por algo que no es del médico: la base, un fallo (AS-093) |
| `ASSISTANT_DRAFT_RETRY_LIMIT` | `QuotaExceededError` | 429 | «Volver a pedir» sobre un tramo que ya falló tres veces (AS-093) |
| `ASSISTANT_DRAFT_CANCELLED` | `ConflictError` | 409 | El borrador se canceló: se firmó la nota o el médico dejó de esperarlo (AS-143, AS-147) |
| `NOTE_SIGN_WHILE_LISTENING` | `ConflictError` | 409 | Se pidió firmar mientras el asistente escucha la atención (AS-140). Vive en `encounter` |
| `NOTE_SIGN_WHILE_DRAFTING` | `ConflictError` | 409 | Se pidió firmar mientras se redacta el borrador de la nota (AS-141). Vive en `encounter` |

| `ASSISTANT_DICTATION_NOT_HEARD`      | `ValidationError`      | 422       | La grabación del dictado llegó vacía, no se pudo leer o no se oyó ninguna voz (AS-186) |
| `ASSISTANT_DICTATION_UNAVAILABLE`    | `ExternalServiceError` | 503       | `clinica-ai` no puede transcribir: sin reconocedor, sin secreto, caído o sin responder (AS-186) |

## Niveles de prueba

| Requisito                                                      | Nivel                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| AS-001                                                         | Tipos (`@ts-expect-error`, lo comprueba `tsc`) y recorrido de `src/`                                        |
| AS-002 a AS-010                                                | Unitario, con `fetch` y proveedores falsos                                                                  |
| AS-015 (al arrancar y cada día)                                | Unitario del módulo con reloj falso                                                                         |
| AS-011, AS-012, AS-014, AS-015, AS-017                         | Integración contra PostgreSQL, con control positivo                                                         |
| AS-020 a AS-024 (la base)                                      | Integración contra PostgreSQL, con control positivo                                                         |
| AS-022 (el cálculo)                                            | Unitario del dominio                                                                                        |
| AS-013, AS-016, AS-018, AS-019                                 | Unitario (AS-018 sobre `pruneToAllowlist`)                                                                  |
| AS-025, AS-028, AS-035, AS-036, AS-039, AS-040, AS-041         | Unitario con seudonimizador y proveedor falsos                                                              |
| AS-026, AS-027, AS-036, AS-037, AS-038                         | Integración HTTP contra PostgreSQL, con control positivo                                                    |
| AS-042                                                         | Arnés (`eval/`), fuera del verify                                                                           |
| AS-043, AS-044                                                 | Componente de la pestaña y recorrido F-04                                                                   |
| AS-045, AS-046, AS-047, AS-056                                 | Integración HTTP y del canal contra PostgreSQL, con control positivo                                        |
| AS-048, AS-049, AS-050, AS-051, AS-054, AS-055, AS-058         | Unitario con reconocedor y reloj falsos; AS-051 también de punta a punta en la integración                  |
| AS-052, AS-053 (la base), AS-057                               | Integración contra PostgreSQL, con control positivo                                                         |
| AS-053 (el código)                                             | Recorrido de los archivos de la escucha                                                                     |
| AS-059, AS-060, AS-061                                         | Componente y composable; recorrido F-04 con el audio de prueba                                              |
| AS-062                                                         | Guion contra la API y `clinica-ai` en marcha, fuera del verify                                              |
| AS-086 (la base), AS-090, AS-094, AS-096, AS-097               | Integración HTTP contra PostgreSQL, con control positivo                                                    |
| AS-087, AS-088, AS-089, AS-091, AS-092, AS-093, AS-095, AS-099 | Unitario con seudonimizador, proveedor, reloj y almacenes falsos                                            |
| AS-098                                                         | Arnés (`eval/`), fuera del verify                                                                           |
| AS-100, AS-101, AS-102                                         | Componente y composable; recorrido F-04 con el audio de prueba                                              |
| AS-119 a AS-125                                                | Unitario con seudonimizador, proveedor, reloj y almacenes falsos                                            |
| AS-119, AS-121 (la base), AS-122, AS-123, AS-125               | Integración HTTP contra PostgreSQL, con control positivo                                                    |
| AS-126                                                         | Arnés (`eval/`), fuera del verify                                                                           |
| AS-127                                                         | Unitario del proveedor de demostración                                                                      |
| AS-118, AS-128 a AS-133                                        | Componente y composable; recorrido F-04 con el audio de prueba                                              |
| AS-030 a AS-034                                                | Unitario con `fetch` falso; AS-031 y AS-032 sobre `env.schema`; prueba manual contra `clinica-ai` en marcha |
| AS-063 a AS-073, AS-077, AS-078                                | Unitario con seudonimizador, proveedor y lector de alergias falsos                                          |
| AS-064, AS-069, AS-070, AS-072 a AS-076                        | Integración HTTP contra PostgreSQL, con control positivo                                                    |
| AS-079                                                         | Arnés (`eval/`), fuera del verify                                                                           |
| AS-080 a AS-082                                                | Componente de la pestaña y recorrido F-05                                                                   |
| AS-103 a AS-108, AS-110, AS-112, AS-113                        | Unitario con seudonimizador, proveedor y catálogo falsos                                                    |
| AS-104, AS-106, AS-107, AS-109 a AS-111                        | Integración HTTP contra PostgreSQL, con control positivo                                                    |
| AS-109 (la base)                                               | Integración contra PostgreSQL, con control positivo                                                         |
| AS-114                                                         | Arnés (`eval/`), fuera del verify                                                                           |
| AS-115 a AS-117                                                | Componente de la pestaña y recorrido F-05                                                                   |
| AS-140 a AS-142, AS-144, AS-147                                | Integración HTTP contra PostgreSQL, con control positivo                                                    |
| AS-143, AS-146, AS-151                                         | Unitario con almacenes, reloj, reconocedor y proveedor falsos                                               |
| AS-145                                                         | Integración contra PostgreSQL, con control positivo                                                         |
| AS-148 a AS-150, AS-152                                        | Componente y composable; recorrido F-04 con el audio de prueba                                              |

| AS-180 a AS-183 (la lectura) | Unitario del dominio, con las frases de SigmAI |
| AS-180, AS-184, AS-186 | Unitario del servicio y del adaptador con `fetch` y reconocedor falsos |
| AS-180, AS-185, AS-186, AS-187, AS-196 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-188 | Arnés (`eval/`), fuera del verify |
| AS-189 a AS-195, AS-198 | Componente y composable; recorrido F-03 con el audio de prueba y `clinica-ai` |
| AS-160 (la base), AS-161, AS-162, AS-164, AS-165, AS-167, AS-168, AS-169 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-160 (el dominio), AS-163, AS-166 | Unitario con lector y reloj falsos; AS-163 y AS-166 también en la integración del canal |
| AS-170 a AS-175 | Componente y composable; recorridos F-08 y F-02 |
| AS-240, AS-241 (la base), AS-243, AS-245, AS-252 | Integración HTTP contra PostgreSQL, con control positivo |
| AS-240, AS-242, AS-244 | Unitario del acceso y del servicio con lectores, reloj y reconocedor falsos; integración del canal |
| AS-246 a AS-251, AS-253, AS-254 | Unitario del dominio y del servicio con seudonimizador y proveedor falsos |
| AS-255 | Arnés (`eval/`), fuera del verify |
| AS-256 a AS-259 | Componente y composable; recorrido F-03 con el audio de prueba, `clinica-ai` y el modo de demostración |
| AS-280 | Unitario del lector de números, con los falsos positivos |
| AS-281 a AS-283 | Unitario del dominio y del servicio con seudonimizador y proveedor falsos, y del proveedor de demostración |
| AS-284 | Arnés (`eval/`), fuera del verify |
| AS-285, AS-286 | Componente; recorrido F-03 con el modo de demostración |

## Preguntas abiertas

Todas en **D-241**: el monto del techo, el plazo del texto sin atención, qué
fallos activan el respaldo, los modelos de OpenAI, el tope para atenciones sin
firma, cuánto se guarda `ai_run`, si los intentos rechazados cuentan en el
techo, la reserva con varias instancias y la retención en cada proveedor.
En **D-243**: si las propuestas salen en un derecho de acceso y cuánto se
guarda la descartada. En **D-247**: escuchar sin la autorización de grabar
hasta A3 (resuelto por A3: AS-165), el tope de 90 días de una transcripción sin firma, quién ve la
transcripción, el léxico de la clínica y el estado de la escucha en una sola
instancia de la API. En **D-249**: la ficha fuera del borrador, dónde va un
diagnóstico dicho, de qué reloj son los 3 minutos, el borrador con la nota
abierta, el vocabulario protegido del léxico y la redacción en el proceso.
En **D-250**: los procedimientos ordenables, lo que pide el paciente en la
conversación, el umbral para encender, el catálogo entero en el prompt y la
prioridad que nadie marca. En **D-253**: las secciones vacías con el asistente
apagado, las opcionales en la lista, revisar de nuevo al escribir, preguntar
por alergias y lo que la ficha ya sabe.
prioridad que nadie marca. En **D-252**: interrumpir sin bloqueo, la escucha
en pausa, firmar cualquier nota de la atención, qué secciones se miden y
«Dejar de esperar».
En **D-254**: dónde va el interruptor, con qué valor nacen las sedes, quién
registra la autorización de grabar, qué pasa con lo transcrito al revocarla,
si vale para todas las atenciones y qué funciones no la piden.
En **D-255**: el permiso propio de enfermería, el interruptor de la sede sin
la autorización de grabar, la temperatura axilar en la única casilla, los
límites de SigmAI frente a los de la base, lo que no mide la voz sintética,
reemplazar lo ya tecleado y los graves que deja el reconocedor.
