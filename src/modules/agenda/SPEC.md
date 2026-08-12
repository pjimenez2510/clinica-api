# SPEC — Módulo `agenda`

**Estado:** borrador para revisión · **Fecha:** 12 de agosto de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

Criterios de aceptación del módulo de agenda. Cada requisito lleva un ID estable
que **nunca se reutiliza** y que al menos una prueba debe nombrar.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Reserva, modificación y seguimiento de citas y bloqueos de agenda por
profesional, consultorio y sede, incluida la lista de espera y el registro de
llegada.

**Fuera de alcance de este módulo:** el contenido clínico de la atención
(módulo `encounter`), la facturación, los recordatorios por WhatsApp
(no confirmado, ROADMAP Fase 4) y la sincronización con calendarios externos.

**Depende de:** `patients`, `catalogs` (tipo de servicio), y del modelo
`AgendaEntry` / `PractitionerScheduleRule` / `WaitlistEntry` ya migrado.
**No depende de** CIE-10 ni CNMB, y por eso es el único entregable de Fase 1 que
no está bloqueado por los catálogos.

## Vocabulario

| Término              | Significado exacto en este módulo                                                           |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Cupo** (_slot_)    | Intervalo derivado de una `PractitionerScheduleRule`; no existe como fila                   |
| **Ocupa calendario** | `blocks_calendar = true AND released_at IS NULL`. Es el predicado de los dos `EXCLUDE`      |
| **Sobrecupo**        | Cita creada con `blocks_calendar = false`: rompe la regla a propósito y deja constancia     |
| **Liberado**         | `released_at IS NOT NULL`. El cupo vuelve a estar disponible aunque la fila siga existiendo |
| **Bloqueo**          | `kind = BLOCK`: ausencia, quirófano, reunión. Sin paciente                                  |
| **Fecha clínica**    | La fecha resuelta en `America/Guayaquil`, nunca en el huso de la sesión                     |

---

## Entregas priorizadas

Cada una es una rebanada **entregable y comprobable por separado**: si solo se
implementa la primera, la clínica ya puede usar la agenda. El orden es de valor,
no de comodidad técnica.

### E1 — Reservar sin pisar a nadie _(P1)_

Recepción busca al paciente, ve los cupos libres de un profesional y reserva.
Dos recepcionistas nunca consiguen el mismo cupo.

**Por qué es P1:** sin esto no hay agenda. Y el no-solapamiento es la única
regla del módulo cuyo fallo produce dos pacientes en la misma silla.
**Prueba independiente:** reservar contra un PostgreSQL real con dos clientes
concurrentes y comprobar que gana exactamente uno.
**Cubre:** AG-001 a AG-003, AG-010 a AG-014, AG-017, AG-018, AG-020 a AG-030,
AG-034, AG-104, AG-105, AG-106.

> AG-031 a AG-033 (antelación mínima, máxima y reserva en el pasado) **no son de
> E1 aunque estén en §3**: leen la configuración de la sede, que no existe hasta
> E7. Se cubren allí. Ponerlas aquí obligaría a quemar los valores de D-001 en el
> código, que es justo lo que REQ-145 prohíbe.

### E2 — El día de la consulta _(P2)_

Confirmar, registrar la llegada, pasar a atención y marcar inasistencia, con
historial de cada transición.

**Por qué es P2:** sin E2 la agenda es una lista de intenciones; con ella la
clínica sabe quién está en sala. **Prueba independiente:** recorrer la máquina
de estados y verificar que cada transición dejó fila en `agenda_status_history`.
**Cubre:** AG-004, AG-005, AG-040 a AG-046.

### E3 — Reprogramar y anular con rastro _(P3)_

**Por qué es P3:** ocurre a diario, pero una clínica puede operar una semana
anulando y volviendo a reservar a mano. **Prueba independiente:** reprogramar y
comprobar que el cupo original quedó libre y ambas entradas se referencian.
**Cubre:** AG-050 a AG-052.

### E4 — Bloqueos y sobrecupo _(P3)_

**Por qué es P3:** son la vía documentada para romper la regla; sin ellos el
personal la rompe por fuera del sistema. **Cubre:** AG-035 a AG-039, AG-100,
AG-101, AG-103.

### E5 — Lista de espera _(P4)_

**Por qué es P4:** aporta ingreso y equidad, pero nada se rompe sin ella.
**Depende del módulo de paciente**, no solo de agenda: AG-062 necesita los campos
de grupo prioritario que la ficha aún no tiene (D-003). No se cierra sin ellos.
**Cubre:** AG-060 a AG-067.

### E6 — Métrica de inasistencia _(P5)_

**Por qué es P5:** es explotación de datos que ya existen. **Cubre:** AG-080, AG-081.

### E7 — Parametrización por sede _(P2)_

Feriados y reglas de operación se cambian sin desplegar código.

**Por qué es P2 pese a ir la última:** no es una entrega de valor propio, es el
prerrequisito de AG-015, AG-016, AG-028, AG-031 a AG-033, AG-035, AG-039,
AG-066, AG-100 y AG-101. Sin ella todos esos requisitos quedan con el valor
quemado en el código, que es exactamente lo que REQ-145 prohíbe. Entra antes que
E4 y E5, aunque se especifique después. **Prueba independiente:** cambiar la
antelación mínima de una sede y comprobar que la reserva siguiente la respeta y
que las ya creadas no se tocan (AG-098). **Cubre:** AG-015, AG-016, AG-031 a
AG-033, AG-090 a AG-099, AG-102.

> AG-015 y AG-016 —los feriados en la consulta de disponibilidad— estaban
> declarados y no pertenecían a ninguna entrega. Lo detectó `pnpm estado`, no una
> lectura. Pertenecen aquí: sin el catálogo de feriados de E7 no se pueden
> implementar.

> Las AG-070 a AG-074 (autorización y bitácora) **no son una entrega**: aplican a
> todas. Una ruta de E1 sin permiso declarado no pasa la prueba de rutas.

## Criterios de éxito

Medibles y sin nombrar tecnología. Son la respuesta a «¿esto quedó bien?» cuando
todos los requisitos están en verde.

- **SC-001** — Una recepcionista reserva una cita en menos de 30 segundos desde
  que empieza a teclear el apellido del paciente.
- **SC-002** — Bajo reservas concurrentes sobre el mismo cupo, el número de
  citas que ocupan calendario y se solapan es **cero**, sin excepción y sin
  depender de la carga.
- **SC-003** — La agenda de un día de una sede con 40 profesionales se muestra
  en menos de 500 ms en el percentil 95.
- **SC-004** — Listar o buscar en la agenda genera **cero** registros en la
  bitácora de acceso a historia clínica; abrir una ficha genera exactamente uno.
- **SC-005** — El 100 % de las citas anuladas, reprogramadas o marcadas como
  inasistencia conservan el historial completo de sus transiciones, con autor e
  instante.
- **SC-006** — Ningún mensaje de error de agenda que lea el usuario contiene
  nombre, documento ni motivo de consulta de otro paciente.

## Supuestos

Decisiones razonables tomadas donde la descripción no lo especificaba. Si alguna
es falsa, hay requisitos que cambian.

- Una cita pertenece a **un solo profesional**. La atención conjunta (dos
  profesionales, un paciente) no existe en este alcance.
- El consultorio es **opcional**: hay sedes que no lo gestionan. Por eso el
  `EXCLUDE` de consultorio es parcial.
- **El paciente no reserva por sí mismo.** El portal es Fase 3; todo canal de
  reserva pasa por personal de la clínica.
- La duración por defecto de una cita es el `slot_minutes` de la regla
  aplicable.
- Toda la clínica opera en `America/Guayaquil`. No hay sedes en otro huso.
- Los datos de profesionales, sedes y consultorios ya existen y se administran
  fuera de este módulo.
- **La antelación mínima no aplica a la reserva presencial** (AG-032). Un
  paciente en el mostrador no puede esperar a la ventana de antelación, y la
  alternativa real no es que espere: es que recepción declare otro canal.

---

## 1. Requisitos ubicuos

- **AG-001** — El sistema DEBERÁ resolver toda fecha y hora mostrada o comparada
  en la zona `America/Guayaquil`, con independencia del huso del servidor y del
  cliente.
- **AG-002** — El sistema DEBERÁ almacenar todo instante de agenda como
  `timestamptz` y toda regla de horario semanal como hora de pared.
- **AG-003** — El sistema DEBERÁ derivar los cupos disponibles de las reglas de
  horario vigentes menos las entradas que ocupan calendario, y NO DEBERÁ
  materializar cupos libres como filas.
- **AG-004** — El sistema DEBERÁ registrar en `agenda_status_history` toda
  transición de estado, con estado anterior, estado nuevo, autor e instante.
- **AG-005** — El sistema DEBERÁ tratar `agenda_status_history` como
  append-only: ninguna operación del módulo la actualiza ni la borra.

## 2. Disponibilidad

- **AG-010** — CUANDO se consulta la disponibilidad de un profesional en un
  rango de fechas, el sistema DEBERÁ devolver los cupos derivados de las reglas
  cuyo `valid_from`/`valid_to` cubra cada fecha y cuyo `active` sea verdadero.
- **AG-011** — CUANDO una regla de horario deja de estar vigente, el sistema
  DEBERÁ seguir mostrando las citas ya agendadas bajo esa regla.
- **AG-106** — CUANDO más de una regla vigente cubra el intervalo solicitado, el
  sistema DEBERÁ aplicar la que entró en vigor más tarde y, a igual `valid_from`,
  la declarada después.
  > «La regla aplicable», en singular, aparece en AG-012, AG-028 y AG-104, y la
  > base **no la hace única**: nada impide dos reglas activas solapadas para el
  > mismo profesional, sede y día. Sin desempate escrito, una reserva de 08:00 a
  > 08:30 se aceptaba o se rechazaba según qué fila devolviera PostgreSQL
  > primero, y eso puede cambiar solo tras un `VACUUM`.
  >
  > El criterio no es arbitrario: un horario se cambia **añadiendo** la regla
  > nueva, así que la vieja que quedó abierta es el olvido y no la intención.
  > «El cupo más corto» mantendría viva para siempre una rejilla retirada.
- **AG-107** — CUANDO se consulten las sedes de agenda, el sistema DEBERÁ listar
  únicamente aquellas donde quien llama tiene `agenda:read`, con identificador y
  nombre, y NO DEBERÁ revelar la existencia de las demás.
  > Añadido al construir la interfaz de E1: los grants viajan con `siteId` sin
  > nombre y no existía **ninguna** ruta que enumerara sedes, así que una
  > recepcionista no tenía forma de elegir dónde reservar. Lo detectó el
  > contrato generado, no una lectura — «la API está lista» y «la API es
  > operable desde una pantalla» no son lo mismo.
- **AG-108** — CUANDO se consulten los profesionales agendables de una sede, el
  sistema DEBERÁ listar identificador y nombre de los que están activos, con
  `schedulable = true` y vinculados a esa sede, y NO DEBERÁ incluir cédula,
  registro ACESS ni ningún dato de contacto.
  > El selector de la pantalla de reserva necesita el nombre y nada más. La
  > cédula del profesional viaja en documentos firmados (REQ-050), no en un
  > desplegable que cualquier usuario con `agenda:read` puede abrir.
  >
  > **Falta esquema.** El desempate hace determinista lo que no debería poder
  > ocurrir. La garantía es un `EXCLUDE USING gist` con `btree_gist` sobre
  > `(practitioner_id, site_id, weekday)` más el solape de horas y el de
  > vigencia, parcial `WHERE active`. No es de una línea: `start_time` y
  > `end_time` son `time` y PostgreSQL no trae `timerange`, así que hay que
  > rangificarlos y combinarlos con el `daterange` de la vigencia.
- **AG-012** — SI la duración solicitada no es múltiplo de `slot_minutes` de la
  regla aplicable, ENTONCES el sistema DEBERÁ rechazar la reserva con
  `INVALID_SLOT_DURATION` indicando la duración admitida.
- **AG-104** — SI el inicio solicitado no coincide con el borde de un cupo
  derivado de la regla aplicable, ENTONCES el sistema DEBERÁ rechazar la reserva
  con `SLOT_NOT_ALIGNED` indicando los inicios admitidos más próximos, salvo que
  se declare sobrecupo.
  > D-007, 12-08-2026. AG-012 solo hablaba de la duración, y con eso una cita de
  > 08:10 a 08:30 bajo cupos de 20 se aceptaba: duraba exactamente lo que debía y
  > aun así dejaba detrás dos huecos de 10 minutos que ya nadie podía reservar.
  > La agenda solo se rellena por la rejilla que ella misma ofrece, que es lo que
  > hace que AG-003 signifique algo.
  >
  > **La excepción del sobrecupo no es un descuido: es la contrapartida.** Meter
  > a alguien a las 08:10 sigue siendo posible por la vía que exige motivo y deja
  > constancia (AG-035). Sin esa salida, esto no quita el caso: lo empuja fuera
  > del sistema, que es lo que D-005 razona para el sobrecupo entero.
- **AG-013** — MIENTRAS un profesional tenga `schedulable = false`, el sistema
  NO DEBERÁ ofrecer cupos suyos ni admitir citas nuevas para él.
- **AG-014** — MIENTRAS un profesional no esté vinculado a una sede en
  `practitioner_site`, el sistema NO DEBERÁ ofrecer cupos suyos en esa sede.
- **AG-015** — CUANDO la fecha consultada sea un feriado nacional o local
  vigente, el sistema DEBERÁ marcar los cupos de ese día como no disponibles y
  DEBERÁ indicar el motivo.
- **AG-016** — DONDE la sede declare un feriado local propio, el sistema DEBERÁ
  aplicarlo solo a esa sede.
- **AG-017** — CUANDO se solicite la agenda de un día, el sistema DEBERÁ devolver
  las entradas de la sede indicada, opcionalmente acotadas a un profesional o a
  un consultorio, ordenadas por instante de inicio, y DEBERÁ resolver los límites
  del día en `America/Guayaquil`.
- **AG-018** — El listado de la agenda de un día NO DEBERÁ incluir las entradas
  liberadas salvo que se pidan de forma explícita, y CUANDO se pidan DEBERÁ
  señalar cuáles lo están.
  > Es el contrato del índice parcial que ya existe:
  > `agenda_entry_daily_agenda … WHERE released_at IS NULL`. Un listado que
  > mezcle liberadas por defecto no puede usarlo y deja de cumplir SC-003.

## 3. Reserva de cita

- **AG-020** — CUANDO se reserva una cita, el sistema DEBERÁ exigir paciente,
  profesional, sede, inicio y fin.
- **AG-021** — SI la entrada es de tipo `APPOINTMENT` y no tiene paciente, o es
  de tipo `BLOCK` y sí lo tiene, ENTONCES el sistema DEBERÁ rechazarla
  — garantía `agenda_entry_patient_coherence`.
- **AG-022** — SI el fin no es posterior al inicio, ENTONCES el sistema DEBERÁ
  rechazar la operación — garantía `agenda_entry_time_order`.
- **AG-023** — SI el intervalo solicitado se solapa con otra entrada del mismo
  profesional que ocupa calendario, ENTONCES el sistema DEBERÁ rechazar la
  reserva con `PRACTITIONER_SLOT_TAKEN` y estado 409, nombrando el campo en
  conflicto.
- **AG-024** — SI el intervalo solicitado se solapa con otra entrada del mismo
  consultorio que ocupa calendario, ENTONCES el sistema DEBERÁ rechazar la
  reserva con `ROOM_SLOT_TAKEN` y estado 409.
- **AG-025** — CUANDO dos reservas compitan por el mismo cupo de forma
  concurrente, el sistema DEBERÁ conceder el cupo a exactamente una y rechazar
  la otra con el error de solapamiento.
- **AG-026** — SI PostgreSQL aborta la transacción por serialización (`40001`),
  ENTONCES el sistema DEBERÁ reintentar la reserva, y agotados los reintentos
  DEBERÁ responder 503 con `Retry-After` y registrar a nivel `error`; NO DEBERÁ
  presentarlo como conflicto de cupo.
- **AG-027** — SI el paciente indicado está fusionado en otro, ENTONCES el
  sistema DEBERÁ rechazar la reserva con `PATIENT_MERGED` indicando la historia
  vigente, y NO DEBERÁ responder 404.
  > **Garantía parcial, a propósito y por escrito** (revisión adversarial de E1,
  > P2-1). La comprobación es leer-luego-escribir fuera de transacción: una
  > fusión confirmada en la misma ventana de milisegundos deja la cita colgada
  > de la historia muerta, y una escritura ajena a este módulo la esquiva
  > entera. El cierre real —comprobar dentro de la transacción del INSERT, o un
  > trigger que rechace `patient_id` fusionado— va con la **tanda 2 de
  > migraciones** (D-006), donde ya hay cambios de esquema de agenda.
- **AG-028** — CUANDO el intervalo solicitado quede fuera de toda regla de
  horario vigente, el sistema DEBERÁ rechazar la reserva con
  `OUTSIDE_SCHEDULE_RULE`, salvo que se declare sobrecupo.
- **AG-029** — CUANDO se reserve una cita, el sistema DEBERÁ registrar el canal
  de reserva (`PHONE`, `WALK_IN`, `WEB`, `REFERRAL`) y el usuario que la creó.
- **AG-030** — SI el paciente ya tiene una cita que ocupa calendario solapada
  con el intervalo solicitado, ENTONCES el sistema DEBERÁ rechazar la reserva
  con `PATIENT_DOUBLE_BOOKED`.
- **AG-105** — SI el consultorio indicado no pertenece a la sede de la entrada,
  ENTONCES el sistema DEBERÁ rechazar la reserva con `ROOM_NOT_IN_SITE`, y el
  mensaje NO DEBERÁ nombrar ninguna de las dos sedes.
  > Lo encontró la revisión adversarial del 12 de agosto de 2026. El alcance por
  > sede lo comprueba el guard sobre `param:siteId`, pero `roomId` viaja en el
  > cuerpo: sin esto se ocupa un consultorio de una sede sobre la que no se tiene
  > alcance, y AG-071 queda esquivado por el costado.
  >
  > El daño peor no es el acceso: la entrada **nunca aparece** en la agenda de la
  > otra sede, porque esa pantalla filtra por `site_id`. El consultorio se ve
  > libre, `agenda_entry_no_room_overlap` rechaza la reserva legítima y nada en
  > pantalla lo explica. No nombrar las sedes evita convertir el error en un
  > identificador por intento.
  >
  > **Falta esquema.** Hoy la regla vive solo en la aplicación, así que una
  > escritura por fuera del módulo la esquiva. La garantía es una FK compuesta
  > `agenda_entry (room_id, site_id) → site_room (id, site_id)`, que exige antes
  > un `UNIQUE (id, site_id)` en `site_room`. Con `room_id` anulable,
  > `MATCH SIMPLE` deja pasar la fila sin consultorio, que es lo correcto.
  > Garantía de la base desde `20260812125924_agenda_guarantees`:
  > `agenda_entry_no_patient_overlap`, el tercer `EXCLUDE USING gist` junto a los
  > de profesional y consultorio. Comprobarlo solo en la aplicación era una
  > condición de carrera que AG-025 no cubre. Exento el sobrecupo
  > (`blocks_calendar = false`) y la cita liberada, por las mismas razones que
  > sus dos vecinos.
- **AG-031** — SI el inicio solicitado es anterior al instante actual y la sede
  no admite reservar en el pasado (AG-094), ENTONCES el sistema DEBERÁ rechazar
  la reserva con `BOOKING_IN_THE_PAST`.
- **AG-032** — SI el inicio solicitado dista del instante actual menos que la
  antelación mínima de la sede, ENTONCES el sistema DEBERÁ rechazar la reserva
  con `BOOKING_TOO_SOON` indicando el primer instante admisible. DONDE el canal
  de reserva sea `WALK_IN`, la antelación mínima NO DEBERÁ aplicarse.
  > La excepción de `WALK_IN` no es comodidad: el paciente ya está en el
  > mostrador. Una antelación mínima de 30 minutos que se aplique a la ventanilla
  > obliga a recepción a falsear el canal, y entonces AG-080 mide humo.
- **AG-033** — SI el inicio solicitado dista del instante actual más que la
  antelación máxima de la sede, ENTONCES el sistema DEBERÁ rechazar la reserva
  con `BOOKING_TOO_FAR` indicando la última fecha admisible.
- **AG-034** — SI el canal de reserva no es uno de `PHONE`, `WALK_IN`, `WEB` o
  `REFERRAL`, ENTONCES el sistema DEBERÁ rechazar la reserva con
  `INVALID_BOOKING_CHANNEL`.
  > Desde `20260812125924_agenda_guarantees` el canal es el enum
  > `booking_channel`, y `agenda_entry_booking_channel_coherence` lo exige para
  > `APPOINTMENT` y lo prohíbe para `BLOCK` — un bloqueo de quirófano no se
  > reserva por teléfono. Antes era `VARCHAR(32)` libre y anulable, así que
  > `'telefono'`, `'Phone'` y `NULL` podían convivir y AG-080 agrupaba por ahí:
  > la métrica salía partida en variantes ortográficas.
  >
  > **Dos códigos, y no es redundancia.** Un valor fuera de la lista lo rechaza
  > el cast al enum (`22P02`) **antes** de que corra ningún `CHECK`, así que no
  > hay constraint que nombrar y la base responde `INVALID_FORMAT`.
  > `INVALID_BOOKING_CHANNEL` lo produce el dominio, que es quien puede decir
  > cuál era el valor admitido. La base es la red, no el mensaje.

## 4. Sobrecupo y bloqueos

- **AG-035** — CUANDO se reserve una cita declarada como sobrecupo, el sistema
  DEBERÁ crearla con `blocks_calendar = false`, DEBERÁ exigir un motivo y DEBERÁ
  registrar quién la autorizó.
  > **Falta esquema.** `agenda_entry` tiene `created_by_id`, pero no un campo de
  > autorización. Quien reserva y quien autoriza el sobrecupo no son la misma
  > persona: ese es el control. Requiere migración nueva.
- **AG-036** — El sistema DEBERÁ exponer en la respuesta de listado el indicador
  de sobrecupo y su motivo, de forma que un cliente pueda distinguirlo sin
  consultar otra vez.
  > Antes decía «mostrar visualmente distinguidas»: ni es verificable en el
  > backend ni es competencia de este módulo. La presentación es de `clinica-web`.
  >
  > **Choca con AG-072 y AG-074 sobre la columna `reason`.** El listado del día
  > dejó de exponer `reason` porque es texto libre donde recepción escribe el
  > motivo de consulta —dato de salud servido sin bitácora—. Exponerlo «solo
  > cuando `blocks_calendar = false`» sería exposición condicional de PHI: nada
  > impide que en un sobrecupo se escriba lo mismo, y una condición en el
  > serializador no es una garantía.
  >
  > **Falta esquema.** El motivo del sobrecupo es un dato administrativo —por qué
  > se rompió la rejilla—, no clínico, y merece columna propia
  > (`agenda_entry.overbooking_reason`), hermana del campo de autorizador que
  > AG-035 ya espera de la tanda 2. Con eso AG-036 se cumple sin condiciones y
  > `reason` queda fuera de toda lectura. Si en cambio se decide reutilizar
  > `reason`, entonces AG-036 y AG-072 se contradicen y hay que decir cuál cede:
  > eso es política, no implementación.
- **AG-037** — CUANDO se cree un bloqueo, el sistema DEBERÁ aplicarle las mismas
  reglas de solapamiento que a una cita.
- **AG-038** — SI se intenta crear un bloqueo sobre un intervalo que ya contiene
  citas que ocupan calendario, ENTONCES el sistema DEBERÁ rechazarlo y DEBERÁ
  enumerar las citas que lo impiden.
- **AG-039** — MIENTRAS la sede tenga el sobrecupo deshabilitado (AG-094), el
  sistema NO DEBERÁ admitir ninguna entrada con `blocks_calendar = false` y
  DEBERÁ rechazarla con `OVERBOOKING_NOT_ALLOWED`.
- **AG-100** — SI el profesional ya alcanzó el número máximo de sobrecupos de la
  sede para esa **fecha clínica**, ENTONCES el sistema DEBERÁ rechazar la reserva
  con `OVERBOOKING_LIMIT_REACHED` indicando el tope vigente.
  > El día se delimita en `America/Guayaquil` (AG-001). Contado en UTC, un
  > sobrecupo de las 19:30 cuenta contra el día siguiente y el tope no limita
  > nada las tardes, que es justo cuando se abusa de él.
- **AG-101** — MIENTRAS el usuario indicado como autorizador del sobrecupo no
  tenga el permiso que la sede configura para ello (AG-094), el sistema DEBERÁ
  rechazar la reserva con `OVERBOOKING_NOT_AUTHORISED`, y NO DEBERÁ crear la
  entrada.
- **AG-103** — SI el autorizador del sobrecupo es el mismo usuario que reserva,
  ENTONCES el sistema DEBERÁ rechazar la reserva con `SELF_AUTHORISATION_DENIED`,
  salvo que ese usuario tenga el permiso `agenda:overbook:self`.
  > D-005, 12-08-2026. La separación de personas **es** el control: un campo de
  > autorización que se rellena solo no autoriza nada. La excepción por permiso
  > existe para el caso real que la separación no cubre —un médico de guardia a
  > las 21:00 sin nadie más conectado— y se concede a quien deba tenerla, no a
  > todos. En ambos caminos AG-035 registra quién autorizó, así que el rastro no
  > depende de cuál se tomó.

## 5. Estados de la cita

Transiciones admitidas. Cualquier par no listado se rechaza.

| Desde                               | Hacia                                             |
| ----------------------------------- | ------------------------------------------------- |
| `BOOKED`                            | `CONFIRMED`, `CHECKED_IN`, `CANCELLED`, `NO_SHOW` |
| `CONFIRMED`                         | `CHECKED_IN`, `CANCELLED`, `NO_SHOW`              |
| `CHECKED_IN`                        | `IN_PROGRESS`, `CANCELLED`, `NO_SHOW`             |
| `IN_PROGRESS`                       | `FULFILLED`                                       |
| `FULFILLED`, `CANCELLED`, `NO_SHOW` | _(terminal)_                                      |
| `BLOCKED`                           | _(solo `kind = BLOCK`; terminal)_                 |

- **AG-040** — SI se solicita una transición que no aparece en la tabla anterior,
  ENTONCES el sistema DEBERÁ rechazarla con `INVALID_AGENDA_TRANSITION` y estado
  409, nombrando el estado actual.
- **AG-041** — CUANDO una cita pase a `CHECKED_IN`, el sistema DEBERÁ registrar
  `checked_in_at` con el instante real de llegada.
- **AG-042** — CUANDO una cita pase a `NO_SHOW`, el sistema DEBERÁ registrar
  `no_show_at` y DEBERÁ liberar el cupo fijando `released_at`.
- **AG-043** — SI se intenta marcar `NO_SHOW` antes de la hora de inicio de la
  cita, ENTONCES el sistema DEBERÁ rechazarlo.
- **AG-044** — CUANDO una cita pase a `CANCELLED`, el sistema DEBERÁ exigir
  motivo, DEBERÁ registrar `cancelled_at` y DEBERÁ liberar el cupo.
- **AG-045** — MIENTRAS una cita tenga un `Encounter` asociado, el sistema NO
  DEBERÁ permitir anularla ni marcarla como `NO_SHOW`.
- **AG-046** — El estado `BLOCKED` DEBERÁ ser válido únicamente para entradas de
  tipo `BLOCK`.
  > Garantía de la base desde `20260812125924_agenda_guarantees`:
  > `agenda_entry_kind_status_coherence`. Antes, `agenda_entry_patient_coherence`
  > ataba `kind` con `patient_id` pero nada ataba `kind` con `status`, y la base
  > aceptaba un `APPOINTMENT` en `BLOCKED`.
  >
  > Un `BLOCK` admite `BOOKED`, `BLOCKED` y `CANCELLED`, y nada más. Los otros
  > cinco estados afirman algo **de un paciente** —confirmó, llegó, se le está
  > atendiendo, se le atendió, no vino— y AG-021 garantiza que un bloqueo no lo
  > tiene. Se enumeran los admitidos en vez de excluir los prohibidos para que
  > añadir un valor a `AgendaStatus` obligue a decidir aquí.

## 6. Reprogramación

- **AG-050** — CUANDO se reprograme una cita, el sistema DEBERÁ liberar el cupo
  original y crear una entrada nueva, y NO DEBERÁ mover el intervalo de la fila
  existente.
- **AG-051** — CUANDO se reprograme una cita, el sistema DEBERÁ dejar en el
  historial de ambas entradas la referencia a la otra.
  > **Falta esquema.** `agenda_entry` no tiene autorreferencia y
  > `agenda_status_history` solo ofrece `note`, un texto libre que ningún cliente
  > puede recorrer. Guardar el enlace en prosa no es guardarlo. Requiere migración.
- **AG-052** — SI la cita nueva no puede crearse, ENTONCES el sistema NO DEBERÁ
  liberar el cupo original.

## 7. Lista de espera

- **AG-060** — CUANDO no haya cupo disponible en el rango solicitado, el sistema
  DEBERÁ permitir inscribir al paciente en lista de espera con sede, rango de
  fechas preferido y, opcionalmente, profesional y tipo de servicio.
- **AG-061** — CUANDO se libere un cupo que ocupaba calendario, el sistema
  DEBERÁ proponer los candidatos de la lista de espera compatibles con ese cupo,
  ordenados por prioridad ascendente y, a igual prioridad, por antigüedad de
  inscripción. Compatible significa: misma sede, y el cupo cae dentro de
  `preferred_from`–`preferred_to`, y —si la entrada los fija— mismo profesional y
  mismo tipo de servicio.
- **AG-062** — El sistema DEBERÁ admitir prioridad 1 para los grupos de atención
  prioritaria del artículo 35 de la Constitución: adultos mayores, niñas, niños y
  adolescentes, mujeres embarazadas, personas con discapacidad, personas privadas
  de libertad y quienes adolezcan de enfermedades catastróficas o de alta
  complejidad. NO DEBERÁ tratarse como preferencia opcional.
  > **Depende del módulo de paciente** (decisión D-003, 12-08-2026). La ficha
  > guarda fecha de nacimiento —de donde sale la edad—, pero embarazo,
  > discapacidad y enfermedad catastrófica no tienen campo. Se descartó
  > implementarlo solo por edad: media prioridad aplicada es peor que ninguna,
  > porque parece que funciona. **E5 no se cierra sin esto**, y esos campos son
  > los que el RDACAA exige de todos modos (REQ-024).
- **AG-063** — CUANDO una entrada de lista de espera se convierta en cita, el
  sistema DEBERÁ marcarla `SCHEDULED` y DEBERÁ enlazarla con la cita creada.
- **AG-064** — El sistema DEBERÁ registrar cada intento de contacto con su
  instante, y NO DEBERÁ reasignar automáticamente el cupo sin confirmación.
  > **Falta esquema.** `waitlist_entry` guarda `contact_attempts` (un contador) y
  > `last_contacted_at` (solo el último). «Cada intento con su instante» no cabe
  > ahí: al tercer intento no se puede responder cuándo fueron los dos primeros
  > ni quién llamó. O se añade una tabla de intentos, o AG-064 se rebaja a
  > «el número de intentos y el último instante» y se dice.
- **AG-065** — CUANDO la fecha preferida máxima quede en el pasado, el sistema
  DEBERÁ marcar la entrada como `EXPIRED`.
- **AG-066** — SI una entrada alcanza el número máximo de intentos de contacto de
  la sede (AG-094), ENTONCES el sistema DEBERÁ marcarla `EXPIRED` y NO DEBERÁ
  seguir proponiéndola como candidata.
- **AG-067** — MIENTRAS una entrada esté en `SCHEDULED`, `EXPIRED` o `CANCELLED`,
  el sistema NO DEBERÁ proponerla como candidata de AG-061.

## 8. Autorización y trazabilidad

- **AG-070** — El sistema NO DEBERÁ exponer ninguna ruta de agenda sin
  declaración explícita de permiso.
- **AG-071** — MIENTRAS el usuario no tenga alcance sobre la sede de la entrada,
  el sistema DEBERÁ rechazar la operación con `SITE_SCOPE_DENIED`.
- **AG-072** — CUANDO se consulte la agenda de un día, el sistema NO DEBERÁ
  registrar un acceso a historia clínica por cada fila listada.
- **AG-073** — CUANDO se abra la ficha de un paciente desde la agenda, el
  sistema DEBERÁ registrar el acceso en la bitácora con quién, qué, cuándo y
  desde dónde.
- **AG-074** — El sistema NO DEBERÁ incluir nombre, documento ni motivo de
  consulta del paciente en ningún registro de log.

## 9. Métricas

- **AG-080** — El sistema DEBERÁ calcular la tasa de inasistencia por
  profesional, por sede y por canal de reserva sobre un rango de fechas.
- **AG-081** — El cálculo de inasistencia DEBERÁ excluir las citas anuladas y
  DEBERÁ contar solo las que alcanzaron su hora de inicio.

## 10. Parametrización

La clínica cambia sus reglas de operación sin que nadie despliegue código. Esto
sustituye a lo que antes eran preguntas abiertas: no se decide un valor, se
decide que el valor es configurable.

### Qué es parametrizable

- **AG-090** — El sistema DEBERÁ resolver los feriados desde un catálogo
  administrable con fecha, nombre y ámbito, y NO DEBERÁ calcularlos en código.
  > Los feriados ecuatorianos se trasladan por decreto según la Ley Orgánica para
  > la Optimización de la Jornada Laboral y los Feriados. Cualquier cálculo queda
  > desfasado el año en que el Ejecutivo mueve uno.
- **AG-091** — DONDE un feriado se declare de ámbito local, el sistema DEBERÁ
  aplicarlo solo a las sedes indicadas; los de ámbito nacional aplican a todas.
- **AG-092** — El sistema DEBERÁ admitir marcar un feriado como **laborable para
  una sede concreta**: una clínica con urgencias atiende el 25 de diciembre.
- **AG-093** — CUANDO se consulte disponibilidad de una fecha sin feriados
  cargados para ese año, el sistema DEBERÁ ofrecer los cupos y DEBERÁ advertir
  que el calendario de ese año no está cargado, y NO DEBERÁ suponer que no hay
  feriados.
- **AG-094** — El sistema DEBERÁ tomar de la configuración de la sede, con valor
  por defecto a nivel de clínica: antelación mínima y máxima de reserva, si se
  permite reservar en el pasado, si el sobrecupo está habilitado, el permiso que
  lo autoriza, el número máximo de sobrecupos por profesional y día, los días de
  retención de citas anuladas, y el número máximo de intentos de contacto de la
  lista de espera.
- **AG-095** — SI un parámetro no está definido para la sede, ENTONCES el sistema
  DEBERÁ usar el valor de la clínica, y si tampoco existe, el valor por defecto
  del código.

  Valores de arranque fijados por el usuario el 12 de agosto de 2026 (D-001):

  | Parámetro                        | Defecto       | Por qué                                                               |
  | -------------------------------- | ------------- | --------------------------------------------------------------------- |
  | Antelación mínima de reserva     | **0 min**     | Recepción agenda al paciente que está en el mostrador                 |
  | Antelación máxima                | **180 días**  | Cubre control anual; más allá la agenda del profesional aún no existe |
  | Sobrecupos por profesional y día | **2**         | Permite la urgencia real sin que el sobrecupo sea la vía normal       |
  | Retención de anuladas            | **no borrar** | Ver AG-102: no hay purgado                                            |

- **AG-099** — El sistema DEBERÁ conceder los permisos `settings:read` y
  `settings:write` al rol administrador en la semilla, y DEBERÁ permitir
  reasignarlos a otros roles desde la aplicación sin desplegar código.
  > D-002. `role_permission` es una tabla y los permisos se resuelven por
  > petición, no dentro del token, para que revocar surta efecto en segundos.
  > Lo que **no** es configurable es qué códigos de permiso existen: eso vive en
  > `permission.catalogue.ts` porque es la enumeración contra la que se valida
  > cada ruta.
- **AG-096** — El sistema DEBERÁ validar todo parámetro al guardarlo y DEBERÁ
  rechazar el guardado con un error por campo; NO DEBERÁ aceptar un valor
  inválido para descubrirlo al reservar.
- **AG-097** — El sistema DEBERÁ registrar quién cambió cada parámetro, cuándo y
  desde qué valor.
- **AG-098** — CUANDO cambie un parámetro, el sistema NO DEBERÁ alterar
  retroactivamente las citas ya reservadas bajo el valor anterior.
- **AG-102** — El parámetro de retención de citas anuladas DEBERÁ limitarse a
  excluirlas de los listados operativos. El sistema NO DEBERÁ borrar ni
  anonimizar entradas de agenda ni `agenda_status_history`.
  > Mientras el plazo legal de conservación siga siendo el bloqueante externo #6
  > del ROADMAP (REQ-006), no se conoce el mínimo que el parámetro no puede
  > bajar. Un parámetro de días que además borre convierte un descuido de
  > configuración en pérdida irreversible de prueba médico-legal. Cuando el plazo
  > se confirme, AG-102 se revisa; hasta entonces «retención» significa «deja de
  > verse», no «deja de existir».

### Qué NO es parametrizable, y por qué

Esto no es una limitación técnica: es lo que hace que el sistema sea seguro.
Convertirlo en configuración sería regalar la garantía.

| No configurable                                            | Por qué                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **El no solapamiento de profesional y de consultorio**     | Vive en dos `EXCLUDE USING gist` de PostgreSQL. Un interruptor «permitir solapes» exigiría eliminar el constraint, y entonces deja de existir para todos. La vía documentada para saltárselo es el sobrecupo, que sí es un parámetro y **deja constancia por cita** |
| **La coherencia paciente/bloqueo y `ends_at > starts_at`** | `CHECK` de la base. No hay clínica que necesite una cita que termina antes de empezar                                                                                                                                                                               |
| **La inmutabilidad del historial de estados**              | Es la respuesta a «¿por qué salió anulada esta cita?». Un parámetro que la desactive convierte la bitácora en decorado                                                                                                                                              |
| **La zona horaria `America/Guayaquil`**                    | Parametrizarla parece flexible y es una trampa: el sistema es de una sola clínica ecuatoriana, y un huso mal configurado cambia `age_days` de un neonato, que es como el RDACAA lo clasifica. Se revisará si algún día hay sedes fuera del país                     |
| **Que toda ruta declare permiso**                          | Cerrado por defecto no admite excepción configurable, o no está cerrado                                                                                                                                                                                             |

> **Falta esquema.** No existen las tablas `holiday` ni la de parámetros por
> sede. Son dos migraciones nuevas, y son prerrequisito de AG-015, AG-016,
> AG-028, AG-035 y AG-090 a AG-098.

---

## Códigos de error nuevos

Entran en `shared/domain/errors/error-catalogue.ts` (regla de ADR-008 §1):

| Código                        | Estado | Requisito |
| ----------------------------- | ------ | --------- |
| `INVALID_AGENDA_TRANSITION`   | 409    | AG-040    |
| `OUTSIDE_SCHEDULE_RULE`       | 422    | AG-028    |
| `AGENDA_ENTRY_HAS_ENCOUNTER`  | 409    | AG-045    |
| `BLOCK_OVERLAPS_APPOINTMENTS` | 409    | AG-038    |
| `BOOKING_IN_THE_PAST`         | 422    | AG-031    |
| `BOOKING_TOO_SOON`            | 422    | AG-032    |
| `BOOKING_TOO_FAR`             | 422    | AG-033    |
| `INVALID_BOOKING_CHANNEL`     | 422    | AG-034    |
| `INVALID_SLOT_DURATION`       | 422    | AG-012    |
| `OVERBOOKING_NOT_ALLOWED`     | 422    | AG-039    |
| `OVERBOOKING_LIMIT_REACHED`   | 409    | AG-100    |
| `OVERBOOKING_NOT_AUTHORISED`  | 403    | AG-101    |
| `SELF_AUTHORISATION_DENIED`   | 403    | AG-103    |
| `SLOT_NOT_ALIGNED`            | 422    | AG-104    |
| `ROOM_NOT_IN_SITE`            | 422    | AG-105    |
| `BOOKING_RETRY_EXHAUSTED`     | 503    | AG-026    |

> `BOOKING_RETRY_EXHAUSTED` lo fijó la implementación de E1: AG-026 nombra el
> estado (503) y la cabecera (`Retry-After`) pero no el código, y sin uno el
> cliente no puede distinguir «reintente» de cualquier otro 503. Sale de la
> categoría reintentable, así que la respuesta lleva `Retry-After`; **no** es un
> conflicto de cupo, que es justo lo que el requisito prohíbe presentar.

Estos **no** entran, porque los produce el mapeo de errores de PostgreSQL en
`shared/http/database-problem.ts`, que tiene su propia tabla:

| Código                     | Estado | Constraint                               | Requisito |
| -------------------------- | ------ | ---------------------------------------- | --------- |
| `PRACTITIONER_SLOT_TAKEN`  | 409    | `agenda_entry_no_practitioner_overlap`   | AG-023    |
| `ROOM_SLOT_TAKEN`          | 409    | `agenda_entry_no_room_overlap`           | AG-024    |
| `PATIENT_DOUBLE_BOOKED`    | 409    | `agenda_entry_no_patient_overlap`        | AG-030    |
| `INVALID_STATUS_FOR_KIND`  | 422    | `agenda_entry_kind_status_coherence`     | AG-046    |
| `BOOKING_CHANNEL_REQUIRED` | 422    | `agenda_entry_booking_channel_coherence` | AG-029    |

`PATIENT_DOUBLE_BOOKED` estaba arriba hasta que AG-030 pasó a ser un `EXCLUDE`.
Se mueve por la regla de esta misma sección: un código que nace de un constraint
no lo declara el catálogo de dominio, o habría dos sitios donde cambiarlo y solo
uno se acordaría.

## Trazabilidad

Toda prueba que cubra un requisito lo nombra en su título:

```ts
it('AG-023 rejects an overlapping booking for the same practitioner', …)
```

`spec-traceability.spec.ts` lee este archivo y los títulos de las pruebas, y
falla si un requisito no tiene prueba o si una prueba cita un ID inexistente.

| Requisitos                                      | Nivel de prueba obligatorio                                |
| ----------------------------------------------- | ---------------------------------------------------------- |
| AG-021 a AG-026, AG-030                         | Integración contra PostgreSQL real                         |
| AG-040 a AG-046, AG-050 a AG-052                | Unitario de dominio + integración                          |
| AG-070 a AG-074                                 | Seguridad dirigida                                         |
| AG-023, AG-024, AG-027, AG-028, AG-030, AG-040  | Contrato HTTP (código, estado, mensaje)                    |
| AG-031 a AG-034, AG-039, AG-100, AG-101, AG-103 | Contrato HTTP + unitario de dominio                        |
| AG-001, AG-015, AG-017, AG-100                  | Unitario con huso alterado, como en `encounter_freeze_age` |
| AG-018, AG-046, AG-066, AG-067                  | Integración contra PostgreSQL real                         |
| AG-012, AG-104, AG-105                          | Unitario de dominio + contrato HTTP                        |
| AG-106                                          | Unitario de dominio + integración con dos reglas solapadas |
| AG-096, AG-097, AG-098, AG-102                  | Integración + contrato HTTP por campo                      |

## Preguntas abiertas

**Resueltas el 12 de agosto de 2026** — el detalle y el porqué de cada una están
en `../clinica-docs/DECISIONES-PENDIENTES.md`:

| #     | Decisión                                                                                   |
| ----- | ------------------------------------------------------------------------------------------ |
| D-001 | Valores de arranque: 0 min · 180 días · 2 sobrecupos · no borrar                           |
| D-002 | El administrador tiene todos los permisos; quién lleva cada uno se cambia en la aplicación |
| D-003 | AG-062 espera al módulo de paciente. No se implementa a medias                             |
| D-004 | **El sistema no borra historia clínica.** No hay purgado                                   |
| D-006 | Migraciones en dos tandas; el historial de contactos se rebaja                             |

| D-005 | El sobrecupo **se mantiene**. Quien reserva no lo autoriza, salvo permiso `agenda:overbook:self` |

**No queda ninguna decisión abierta.**

Lo que sigue son las consecuencias ya decididas, que sí siguen siendo trabajo:

1. **Dos tandas de migración** (D-006). Tanda 1, sin dependencias y prerrequisito
   de E1 y E7: tabla `holiday` y parámetros por sede (§10) · `EXCLUDE` por
   paciente (AG-030) · `CHECK` de coherencia `kind`/`status` (AG-046) · canal de
   reserva como enum (AG-034). Tanda 2, cuando D-005 esté resuelta: campo de
   autorización de sobrecupo (AG-035) y autorreferencia de reprogramación
   (AG-051).
2. **El historial de intentos de contacto (AG-064) se rebaja, no se migra.** Se
   conserva el contador y el último instante que `waitlist_entry` ya tiene. Si
   al usar la lista de espera de verdad hace falta el historial completo, será
   una migración con motivo, no por si acaso.
3. **Dos códigos de permiso nuevos** en `permission.catalogue.ts`:
   `settings:read` y `settings:write` (AG-099). Es cambio de código porque el
   catálogo es la enumeración contra la que se valida cada ruta; a quién se
   conceden es configurable.
