# SPEC — Módulo `agenda`

**Estado:** borrador para revisión · **Fecha:** 20 de agosto de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

Criterios de aceptación del módulo de agenda. Cada requisito lleva un ID estable
que **nunca se reutiliza** y que al menos una prueba debe nombrar.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Reserva, modificación y seguimiento de citas y bloqueos de agenda por
profesional, consultorio y sede, incluida la lista de espera, el registro de
llegada con su calificación de emergencia, el estado del paciente dentro de la
visita y el tablero del día.

**Fuera de alcance de este módulo:** el contenido clínico de la atención
(módulo `encounter`), la facturación, los recordatorios por WhatsApp
(no confirmado, ROADMAP Fase 4) y la sincronización con calendarios externos.

**El estado del paciente vive aquí aunque lo disparen hechos de `encounter`**
(§5 bis). Es el eje del tablero, y el tablero es una lectura de la agenda del
día: ponerlo en `encounter` obligaría a la agenda a importar de otro módulo, que
`pnpm arch:check` prohíbe. Lo que la agenda guarda es **dónde está el paciente**;
lo que se documentó de él sigue siendo de `encounter`, y la agenda nunca lo ve.

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
| **Estado de la cita** | El estado administrativo del compromiso: `BOOKED` … `FULFILLED`. Es de la CITA, no del paciente |
| **Estado del paciente** | Dónde está la persona dentro de la visita: `ARRIVED` … `DEPARTED`. Separado del anterior, §5 bis |
| **Retraso de llegada** | `checked_in_at − starts_at` en minutos. Es un número calculado, nunca un estado (AG-118) |
| **Calificación de emergencia** | La constancia de que la llegada se calificó, Ley 77 art. 10. **No es una escala de gravedad** |
| **Proyección**       | Qué campos del tablero se sirven: `STAFF` o `PUBLIC`. Son dos rutas, no un interruptor      |

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
AG-034, AG-070 a AG-074, AG-104, AG-105, AG-106, AG-107, AG-108, AG-109,
AG-111, AG-112, AG-113, AG-144, AG-145.

> AG-111 y AG-112 se añadieron el 14-08-2026, y pertenecen aquí por lo mismo
> que AG-107 y AG-108: son **las listas de referencia que la pantalla de
> reserva elige**, y sin ellas el diálogo no es operable por quien reserva. Se
> descubrieron revisando C4 —el selector de especialidad y tipo pedía rutas con
> `config:read`, que `RECEPCION` no tiene—, así que la mitad de C4 que se ve
> depende de esta entrega, no al revés.

> AG-031 a AG-033 (antelación mínima, máxima y reserva en el pasado) **no son de
> E1 aunque estén en §3**: leen la configuración de la sede, que no existe hasta
> E7. Se cubren allí. Ponerlas aquí obligaría a quemar los valores de D-001 en el
> código, que es justo lo que REQ-145 prohíbe.

**Solo servidor:** AG-001, AG-002, AG-003, AG-010, AG-020, AG-021, AG-022,
AG-023, AG-024, AG-025, AG-026, AG-029, AG-034, AG-106, AG-144. Son garantías de
almacenamiento y de la base —el huso, el `timestamptz`, los `EXCLUDE`, el
desempate entre reglas solapadas, la coherencia paciente/bloqueo y el orden de
los tiempos—, concurrencia y reintento de serialización, o campos que se
registran sin que nadie los vea. Se demuestran contra PostgreSQL con dos
clientes a la vez, no en una pantalla: una interfaz que los «probara» estaría
comprobando su propio doble.

> **AG-144 entra en esta lista el 30-09-2026 (`fix/agenda-estados-y-sobrecupo`).**
> Es una resta que hace el servidor: la interfaz pinta los cupos que recibe y
> no tiene ninguna lógica que pueda equivocarse en ella, así que una prueba de
> interfaz que lo citara comprobaría su propio doble. Lo que de AG-144 se ve
> en la rejilla —«No disponible» donde el profesional está en otra sede— es
> AG-145, que sí tiene su prueba de interfaz. Se demuestra contra PostgreSQL
> (`agenda-availability`).

> **Lo que sí tiene mitad visible y por qué esta lista es corta.** AG-011,
> AG-012, AG-013, AG-014, AG-017, AG-018, AG-027, AG-028, AG-030, AG-104,
> AG-105 y AG-109 SE VEN: son lo que la rejilla enseña, a quién ofrece cupos y
> dónde aterriza cada rechazo. Un rechazo que el servidor escribe y la pantalla
> tapa con un aviso de esquina es un requisito cumplido a medias, y el que lo
> paga es quien está en el mostrador.

### E2 — El día de la consulta _(P2)_

Confirmar, registrar la llegada, pasar a atención y marcar inasistencia, con
historial de cada transición.

**Por qué es P2:** sin E2 la agenda es una lista de intenciones; con ella la
clínica sabe quién está en sala. **Prueba independiente:** recorrer la máquina
de estados y verificar que cada transición dejó fila en `agenda_status_history`.
**Cubre:** AG-004, AG-005, AG-040 a AG-046, AG-143.

**Solo servidor:** AG-004, AG-005. La fila de `agenda_status_history` y
su inmutabilidad son garantías de la base —dos disparadores y un `RESTRICT`,
D-022— y, además, **no existe todavía ruta de lectura del historial**: no hay
pantalla que pueda enseñarlo aunque quisiera. Con qué permiso se lee es decisión
del usuario (ver AG-005); cuando exista esa ruta, AG-004 recupera mitad visible y
sale de esta lista.

> **AG-045 entra aquí el 15-08-2026, al cerrar la mitad visible de E2, y con el
> argumento escrito** —la regla de esta lista es que quien calla debe interfaz—.
> **El hecho que decide la regla no viaja al cliente.** `AgendaEntryDto` no lleva
> ningún campo que diga si la cita tiene un `Encounter` asociado, y no es un
> descuido del DTO: el módulo `encounter` todavía no existe, así que no hay
> siquiera dato que publicar. Ninguna pantalla puede por tanto ofrecer ni retirar
> «Anular…» ni «No asistió» por este motivo, que es lo que sí se hizo con AG-043
> —ahí el dato es la hora, y la hora la sabe cualquiera—.
>
> Lo único observable es el rechazo, y es el camino GENÉRICO: un 409
> `AGENDA_ENTRY_HAS_ENCOUNTER` lo cuenta el aviso global con la frase en español
> de la propia API, exactamente igual que el 409 de una transición inválida
> (AG-040) o el de un cupo perdido (AG-023). Escribir una prueba de interfaz
> sobre eso citando AG-045 afirmaría que existe la política de errores, no que se
> respeta esta regla — y la política ya tiene sus pruebas.
>
> **Cuando `encounter` publique si una cita tiene atención, AG-045 recupera mitad
> visible** —no ofrecerlas— y sale de esta lista, igual que AG-004 con la ruta de
> historial.
>
> **Salió el 30-09-2026 (`fix/agenda-estados-y-sobrecupo`).** La entrada lleva
> ya `attention` (AG-150) y el menú del tablero y del calendario deja de
> ofrecer lo que AG-045 rechaza.

### E3 — Reprogramar y anular con rastro _(P3)_

**Por qué es P3:** ocurre a diario, pero una clínica puede operar una semana
anulando y volviendo a reservar a mano. **Prueba independiente:** reprogramar y
comprobar que el cupo original quedó libre y ambas entradas se referencian.
**Cubre:** AG-050 a AG-052 y AG-115.

### E4 — Bloqueos y sobrecupo _(P3)_

**Por qué es P3:** son la vía documentada para romper la regla; sin ellos el
personal la rompe por fuera del sistema. **Cubre:** AG-035 a AG-039, AG-100,
AG-101, AG-103, AG-114, AG-151, AG-152.
**Solo servidor:** AG-152. El diálogo de bloqueo ya enumera lo que el servidor
devuelve con `BLOCK_OVERLAPS_APPOINTMENTS` (AG-038); AG-152 añade el sobrecupo
a esa lista y la pantalla no cambia.

### E5 — Lista de espera _(P4)_

**Por qué es P4:** aporta ingreso y equidad, pero nada se rompe sin ella.
**Dependía del módulo de paciente**, no solo de agenda: AG-062 necesitaba los
campos de grupo prioritario que la ficha no tenía (D-003), y los tiene desde el
16-08-2026. **Cubre:** AG-060 a AG-067.

> ### ⏸ Construida y EN REPOSO desde el 19-08-2026
>
> **Sin punto de entrada en la interfaz.** El backend, el esquema y todos los
> requisitos de abajo siguen vigentes y probados en los dos lados; lo que se
> apagó son las puertas: el diálogo de candidatos ya no se abre solo al anular,
> al marcar una inasistencia ni al quitar un bloqueo, y no quedan el botón de la
> barra de la agenda, el de una entrada ya liberada ni la salida «Inscribir en
> lista de espera» de la reserva sin cupos.
>
> **Por qué.** El usuario la probó y decidió dejarla dormida: en su clínica
> generalmente sí hay cupo, así que la cola casi no se usaría, y lo que de
> verdad quiere es recordar la cita por WhatsApp y reprogramar fácil, que ataca
> el problema antes de que el hueco exista. La primera vez que la usó de verdad
> se llamó a una persona por un cupo que ya había pasado —defecto ya corregido—,
> y lo que dejó claro es que todo esto termina en una llamada de teléfono.
>
> **El interruptor** es `WAITLIST_UI_ENABLED`, una constante en
> `clinica-web/app/modules/agenda/waitlist-access.ts`. Ponerla en `true` la
> devuelve entera; ese archivo lleva escrito qué mirar antes, empezando por lo
> principal: que exista un canal para avisar sin llamar.
>
> `pnpm estado` sigue contando E5 como completa, y es cierto: las pruebas de la
> interfaz siguen citando AG-060 a AG-067 porque los componentes siguen ahí. Lo
> que el contador no puede decir es que nada los abre, y por eso lo dice esto.

> **Cerrada el 19-08-2026.** Esquema en `agenda_waitlist_contact_trail`; código
> en `waitlist.ts`, `waitlist.repository.ts`, `waitlist.service.ts`,
> `prisma-waitlist.repository.ts` y `waitlist.controller.ts`.
>
> **La prioridad se deriva al proponer, y la deriva `shared`.** AG-061 ordena
> por un número que ninguna columna guarda: `waitlist_entry.priority` se quitó
> en la migración porque congelarlo reintroduce el defecto que PA-036 evita —la
> mujer que ya dio a luz seguiría siendo prioridad 1 para siempre—, y aquí es
> peor que en la ficha porque el dato caducado no se muestra: ordena una cola.
> Quien sabía derivarlo era `patients`, y **ningún módulo importa de otro**
> (`pnpm arch:check` lo hace fallar). Así que la parte MÍNIMA se movió a
> `shared/domain/priority-level.ts` —la derivación del nivel a partir de la
> fecha de nacimiento y de los periodos vigentes— por el mismo camino que
> `clinic-time.ts`, el value object `Ruc` y `master-data.errors.ts`. En
> `patients` se queda lo suyo: el catálogo de los diez grupos, los orígenes, el
> subconjunto registrable y el restringido. **La agenda nunca ve el motivo**:
> `priorityLevelOf` recibe PERIODOS y ningún código de grupo, así que la
> consulta que alimenta la lista no lo selecciona y PA-042 deja de ser una
> regla que alguien tiene que recordar.
>
> **La base cuenta y el dominio decide**, como en E6. El adaptador trae los
> hechos crudos —las dos fechas, lo que la entrada fija, cuántas llamadas
> lleva, la fecha de nacimiento y los periodos— y `waitlist.ts` decide quién
> encaja, quién caducó y quién va primero. Los periodos se resuelven por el
> alcance de ficha (PA-055): un embarazo registrado en la ficha absorbida sigue
> priorizando a la superviviente.
>
> **AG-061 se dispara pidiéndolo sobre la entrada liberada, no solo.**
> «Proponer» necesita a quién proponerle, y este sistema no tiene canal al que
> empujar —el portal es Fase 3 y los recordatorios Fase 4—: un efecto dentro de
> la anulación calcularía una lista y la tiraría al suelo. Y un cupo se libera
> de cuatro formas —anular (AG-044), inasistencia (AG-042), la mitad original
> de una reprogramación (AG-050), retirar un bloqueo (AG-114)—, y las cuatro
> sellan `released_at` sobre una fila que ocupaba calendario. Nombrando ESA
> FILA, una sola ruta sirve a las cuatro, presentes y futuras, en vez de cuatro
> copias de «qué es un cupo liberado». El servidor deriva el día, el
> profesional y el tipo de la fila liberada, así que nadie puede preguntar por
> un intervalo que nunca se liberó, y una entrada que sigue en pie se rechaza
> con `SLOT_NOT_RELEASED`: la precondición del requisito se hace cumplir en vez
> de suponerse.
>
> **AG-065 y AG-066 son actos, y ocurren donde no se pueden olvidar.** Cuando
> una fecha pasa no OCURRE nada —el reloj avanza y a la base no se le dice—,
> así que ninguna restricción puede marcar la fila. El barrido corre a la
> cabeza de todo caso de uso que podría actuar sobre una entrada caducada
> —proponer, listar, llamar— y en la misma transacción. **No es un proceso
> programado** porque ésa es la respuesta que depende de que alguien se
> acuerde: de configurarlo, de mantenerlo vivo, de notar la noche que no corrió
> —y una corrida perdida es una entrada cuya quincena terminó en julio
> compitiendo por los cupos de octubre con su antigüedad original, sin que nada
> se ponga rojo. Resolverlo donde se lee no se puede olvidar: la única forma de
> observar la diferencia es hacer la lectura que la corrige. AG-066 es la otra
> mitad y sí es un EVENTO —el intento que alcanza el tope—, así que se aplica
> en el acto, en la misma transacción que el intento.
>
> **Lo que quedó fuera al cerrarla, y ya no.** El tipo de atención de la
> inscripción, que la entrega dejó sin admitir porque su columna apuntaba a otra
> tabla que la de la cita. Corregido el 19-08-2026 con
> `waitlist_service_type_follows_agenda`: `waitlist_entry.service_type_id`
> nombra ahora `service_type`, la misma tabla que `agenda_entry`, así que la
> mitad de AG-061 que compara los dos tipos —escrita y probada en `waitlist.ts`
> desde el principio— dejó de ser imposible de cumplir. Ver la nota junto a
> AG-060.

### E6 — Métrica de inasistencia _(P5)_

**Por qué es P5:** es explotación de datos que ya existen. **Cubre:** AG-080, AG-081.

> **Cerrada el 16-08-2026.** `GET /agenda/metrics/no-show?from&to`, bajo
> `agenda:read` con alcance `'query'` — el desglose POR SEDE es el requisito, y
> una métrica colgada de `/sites/{siteId}` no podría contestarlo; el handler
> estrecha con el alcance resuelto de la sesión, como AG-107. Sin migración: no
> se añadió ni una columna.
>
> **La base cuenta y el dominio decide.** El adaptador devuelve el cubo
> sede·profesional·canal·estado con su recuento, y `summariseNoShow` es quien
> aplica AG-081 y divide. Un `WHERE status <> 'CANCELLED'` en la consulta sería
> una segunda copia de la regla que ninguna prueba puede romper. El cubo no
> crece con la historia de la clínica —su tamaño es sedes × profesionales × 4
> canales × 8 estados—, así que un año de citas y una tarde cruzan igual.
>
> **Lo que destapó, y no era de la agenda.** La prueba que pide el mismo rango
> bajo dos husos de sesión devolvía dos cifras: `@prisma/adapter-pg` serializa
> un `Date` sin sufijo de zona y PostgreSQL lo resuelve con el `TimeZone` de la
> sesión, así que TODO instante clínico del sistema dependía de cómo estuviera
> configurado el servidor. Corregido fijando la zona de sesión en el arranque de
> cada conexión (`shared/infrastructure/prisma/pg-adapter.ts`), con su prueba en
> `clinical-date-timezone.spec.ts`.

### E7 — Parametrización por sede _(P2)_

Feriados y reglas de operación se cambian sin desplegar código.

**Por qué es P2 pese a ir la última:** no es una entrega de valor propio, es el
prerrequisito de AG-015, AG-016, AG-028, AG-031 a AG-033, AG-035, AG-039,
AG-066, AG-100 y AG-101. Sin ella todos esos requisitos quedan con el valor
quemado en el código, que es exactamente lo que REQ-145 prohíbe. Entra antes que
E4 y E5, aunque se especifique después. **Prueba independiente:** cambiar la
antelación mínima de una sede y comprobar que la reserva siguiente la respeta y
que las ya creadas no se tocan (AG-098). **Cubre:** AG-015, AG-016, AG-031 a
AG-033, AG-090 a AG-099, AG-102, AG-110.

**Solo servidor:** AG-095, AG-097, AG-098. El segundo es bitácora —quién cambió
qué parámetro, cuándo y desde qué valor, en `access_audit`— y el tercero se
demuestra mirando las citas anteriores al cambio, que es exactamente lo que una
pantalla no puede enseñar.

> **AG-095 entra en esa lista el 15-08-2026, al cerrar la mitad visible de E7, y
> con el argumento escrito.** La cadena de escalones **no es observable desde
> ninguna pantalla**: `SiteParametersDto` entrega el valor YA RESUELTO y no lleva
> ningún campo que diga de qué escalón sale. Y el segundo escalón no tiene tabla
> —el disparador de
> `20260813040610_configuration_holidays_and_site_parameters` escribe los valores
> de la clínica en la fila de cada sede en cuanto la sede existe—, así que hoy
> los dos escalones inferiores COINCIDEN: un `0` tecleado por un administrador y
> un `0` heredado del código llegan idénticos, y ninguna pantalla puede
> distinguirlos ni verlos caer.
>
> Lo que la pantalla de parámetros sí enseña —el defecto del código junto a cada
> casilla, «Valor de arranque del sistema: 0 minutos»— es otra afirmación:
> CF-062, con la tabla de D-001 detrás, y ya tiene sus pruebas. Llamarla AG-095
> sería dar por probada la resolución mirando un rótulo. La cadena se comprueba
> donde ocurre, con la prueba de integración que reserva contra una sede sin fila
> de parámetros (ver el recuadro de AG-095).
>
> **Si algún día la respuesta dice de qué escalón sale cada valor**, AG-095
> recupera mitad visible —enseñarlo junto a la casilla— y sale de esta lista.

> **AG-090, AG-091, AG-099 y AG-102 NO están en esa lista, y es deliberado.**
> Cada uno tiene una mitad que se ve: AG-090 vive en el catálogo administrable de
> feriados, AG-091 en el alcance que cada fila del calendario escribe, AG-099 se
> reasigna desde la pantalla de roles y AG-102 en que la retención se presenta
> como valor fijo y nada de lo que la pantalla envía puede ordenar un borrado.
> Declararlos «solo servidor» los daría por cerrados sin haberlos mirado, y eso
> es peor que dejarlos pendientes: quien calla debe interfaz. **Los cuatro
> quedaron con prueba de interfaz el 15-08-2026.**

> AG-015 y AG-016 —los feriados en la consulta de disponibilidad— estaban
> declarados y no pertenecían a ninguna entrega. Lo detectó `pnpm estado`, no una
> lectura. Pertenecen aquí: sin el catálogo de feriados de E7 no se pueden
> implementar.

### E8 — Desenlaces reales de la llegada _(P1)_

El paciente llega, se le califica el estado de emergencia como manda la ley, y
la cita termina en el desenlace que de verdad ocurrió: se le atendió, no vino,
se fue sin ser atendido, o la cita nunca debió existir.

**Por qué es P1 pese a ir después de E2:** una parte de esto es **obligación
legal con pena de prisión** —Ley 77, art. 10 y art. 13, D-A-002—, y el resto es
lo que impide que la única métrica del módulo mienta. Hoy a quien llegó y se
marchó sólo se le puede poner `NO_SHOW`, que es registrar una falsedad sobre una
persona que sí vino, y contarla en el mismo número que AG-032 se esforzó en no
falsear con el canal `WALK_IN`. Un indicador envenenado es peor que ninguno,
porque se actúa sobre él.

**Prueba independiente:** llevar una cita de `CHECKED_IN` a
`LEFT_WITHOUT_BEING_SEEN`, comprobar que el cupo quedó liberado, que
`agenda_status_history` tiene su fila, que la tasa de inasistencia del día **no
subió** y que el recuento propio sí; y registrar una llegada sin calificación de
emergencia y comprobar que se rechaza.
**Cubre:** AG-116 a AG-120, AG-128 a AG-132, AG-140, AG-141, AG-142.

**Solo servidor:** AG-132, AG-140. La inmutabilidad del registro de la
calificación son dos disparadores de PostgreSQL, por la misma razón que AG-005;
y AG-140 es qué NO entra en una división, que es exactamente lo que ninguna
pantalla puede enseñar —lo único visible es la cifra, y la cifra sale igual de
bien calculada mal—.

> **Lo demás SE VE, y es la mitad que decide si la ley se cumple.** AG-128 a
> AG-131 viven en la pantalla de llegada: la casilla de emergencia que no se
> puede omitir, el aviso al profesional de turno, y —lo más importante— que la
> verificación de cobertura se pueda **saltar dejando el motivo**. El art. 9
> prohíbe exigir documento de pago antes de recibir y estabilizar: una pantalla
> que bloquee el paso hasta registrar la forma de pago es ilegal justo en el
> caso en que más importa, y eso no lo puede garantizar el servidor solo — un
> backend que acepta el campo vacío y una interfaz que no deja avanzar sin
> llenarlo incumplen igual.

### E9 — El tablero del día y el estado del paciente _(P2)_

Dónde está cada paciente ahora mismo, en una lista ordenada por hora, y cuánto
lleva ahí.

**Por qué es P2:** es lo que convierte la agenda en la pantalla que el personal
mira todo el día, y el estado del paciente es el eje que hoy no existe. No es P1
porque la clínica opera sin él —con E1 y E2 ya sabe quién está en sala— y porque
la mayor parte de sus estados los DERIVAN hechos del módulo `encounter`, que
todavía no existe.

**Prueba independiente:** abrir la toma de signos de una cita y comprobar que su
estado de paciente pasó a `IN_PREPARATION` **sin que nadie lo teclee**, que el
tablero lo ordena por hora de la cita, que el tiempo en el estado actual lo
calcula el servidor, y que la proyección `PUBLIC` de esa misma fila no lleva
nombre completo ni nota corta.
**Cubre:** AG-121 a AG-127, AG-133 a AG-139.

**Solo servidor:** AG-122, AG-126, AG-139. Que un estado NO se pueda teclear se
demuestra por la ausencia de ruta —una pantalla no puede enseñar un botón que no
existe—; el rastro append-only del estado del paciente es garantía de la base
como el de AG-005; y quién consultó el tablero se escribe en `access_audit` sin
que nadie lo vea.

> **El esquema del eje entró el 20-08-2026 y no bloquea nada**
> (`20260820052524_clinical_flow_states`): el enum `patient_subject_status`, las
> dos columnas de `agenda_entry` y sus dos `CHECK` ya existen, igual que los dos
> valores nuevos de `agenda_status` de E8, las columnas de la calificación de
> emergencia y el umbral de llegada tardía. Lo que queda de esquema está anotado
> requisito a requisito y es poco: el historial del estado del paciente
> (AG-126), la nota del tablero (AG-134), las vistas por rol (AG-138) y las dos
> mitades que la ley exige y la migración no cubre (AG-128, AG-132).
>
> **AG-121 a AG-127 dependen de `encounter` y no al revés.** Cinco de los seis
> estados los dispara un hecho que documenta ese módulo —se abre la toma de
> signos, se guardan, se abre la nota, se firma, se cierra la cuenta—, así que
> E9 no se puede cerrar antes que H1 y H4. Lo que **sí** se puede construir
> antes es la mitad que no depende de nadie: `ARRIVED` lo escribe el registro de
> llegada de E8, y el tablero puede servir las filas con el estado de la CITA
> mientras el del paciente esté vacío. Esa es la razón de que el tablero y el
> estado vayan juntos en una entrega y no en dos: separarlos daría una entrega
> con dos columnas y ninguna pantalla, y otra con una pantalla que enseña una
> columna siempre vacía.
>
> **Y no es un kanban, por evidencia y no por gusto.** El kanban con evidencia
> en salud es el de inventario y farmacia; para flujo de pacientes en consulta
> externa no se encontró un solo estudio controlado, y todo lo que describe
> columnas «Programado → En sala → Cerrado» para una clínica sale de blogs de
> fabricantes de herramientas kanban. Epic, Cerner, NextGen y eClinicalWorks
> convergen los cuatro en **lista ordenada por hora con columna de estado**. La
> razón es estructural: en urgencias no hay plan y el tablero ES el orden; en
> consulta externa el plan es la agenda, y lo valioso no es qué pacientes hay
> —eso ya lo dice el calendario— sino **en qué se desvía la realidad del plan**.
> Un kanban no representa el tiempo transcurrido, que es justo el dato que
> importa, y el orden por hora —que es un compromiso con el paciente— se pierde
> en cuanto alguien arrastra una tarjeta.

### E10 — Lo que la atención marca en la cita _(P1)_

Abrir la nota pasa la cita a «en atención»; la atención anulada devuelve la
cita a la sala; la interrumpida la deja atendida y marcada; y el paciente que
se va con la atención abierta y sin nota queda «se fue sin ser atendido».

**Por qué es P1:** es un defecto visto por el autor el 30-09-2026 —Carlos
Álvarez «En atención» con «Pasar a atención», «Se fue sin ser atendido» y
«Anular…» en el menú— y cada una de esas tres acciones escribía un hecho falso
sobre una consulta que sí ocurrió. **Prueba independiente:** abrir la nota de
una cita en sala, comprobar contra la base que la cita está `IN_PROGRESS` con
su fila de historial, que el servidor rechaza `LEFT_WITHOUT_BEING_SEEN` y
`CANCELLED` sobre ella, y que el menú ya no los ofrece.
**Cubre:** AG-045, AG-146 a AG-150, AG-153, **AG-160 y AG-161** (ver la atención de una cita cerrada, 04-10-2026). Decisiones D-076, D-077, D-080,
D-081, D-082, D-085, D-099.

> **AG-045 se cubre otra vez aquí** porque su mitad visible nace en esta
> entrega; su mitad de servidor sigue en E2.

> **AG-070 a AG-074, AG-107 y AG-108 pasan a E1 el 20-08-2026, y con el
> argumento escrito.** Los siete estaban declarados y no pertenecían a ninguna
> entrega; `pnpm estado` los cantaba como huérfanos, y un requisito que no es de
> nadie no lo trabaja nadie. AG-107 y AG-108 son las listas de referencia que la
> pantalla de reserva elige, exactamente por lo que ya decía la nota de AG-111 y
> AG-112 —que las nombraba como precedente sin que ellas mismas tuvieran
> entrega—.
>
> **AG-070 a AG-074 aplican a todas las entregas y aun así pertenecen a E1**, que
> es donde nacen las primeras rutas: la prueba que las sostiene recorre las rutas
> que NestJS registró de verdad, así que una ruta de E8 sin permiso declarado
> hace fallar la misma prueba de E1. Declararlas «de todas» era declararlas de
> ninguna. Cada entrega posterior las vuelve a atravesar; ninguna las vuelve a
> cubrir.
>
> _(Resuelto el 30-09-2026 en `feat/f01-dar-cita`: la bitácora gana el contexto
> de la cita; ver la nota bajo AG-073.)_
>
> **AG-073 entra sin prueba, y eso es el hallazgo.** Los otros seis ya tienen
> pruebas que los nombran; AG-073 —registrar en la bitácora la apertura de la
> ficha desde la agenda— tiene cero, porque no existe todavía la ruta que abre
> la ficha DESDE la agenda: hoy se navega a `patients`, y la bitácora que
> escribe ese módulo no afirma «se llegó desde la agenda». E1 pasa por tanto de
> 29/29 a 35/36, y esa fila roja es trabajo real que llevaba escondido detrás de
> una nota.

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
- La duración por defecto de una cita es el **turno de la sede**
  (`site_parameter.slot_atom_minutes`, D-021). Hasta el 14-08-2026 era el
  `slot_minutes` de la regla aplicable, que ya no existe.
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
  horario vigentes menos las entradas que ocupan calendario (del profesional, en
  cualquier sede: AG-144), y NO DEBERÁ
  materializar cupos libres como filas.
- **AG-004** — El sistema DEBERÁ registrar en `agenda_status_history` toda
  transición de estado, con estado anterior, estado nuevo, autor e instante.
- **AG-005** — El sistema DEBERÁ tratar `agenda_status_history` como
  append-only: ninguna operación la actualiza ni la borra, y la base DEBERÁ
  rechazar el intento venga de donde venga, incluido el borrado de la entrada de
  agenda de la que cuelga.
  > **D-022, 14-08-2026: de convención a garantía de la base.** Hasta esa fecha
  > esto se sostenía sólo porque el módulo únicamente hace `INSERT`. Un `UPDATE`
  > por `psql` reescribía por qué se anuló una cita, y borrar la entrada se
  > llevaba el historial entero **en silencio**, porque la clave foránea era
  > `ON DELETE CASCADE`. Desde
  > `20260814210843_agenda_status_history_immutable` lo garantiza PostgreSQL:
  > `trg_agenda_status_history_immutable` rechaza `UPDATE` y `DELETE`,
  > `trg_agenda_status_history_no_truncate` rechaza `TRUNCATE` —que no dispara
  > los de fila— y la clave foránea es `RESTRICT`. Lo único que sigue pudiendo
  > saltárselo es un superusuario que desactive el disparador a propósito, que
  > queda en el registro del servidor; es la misma puerta que `access_audit`
  > lleva desde `20260806011045`.
  >
  > **Lo que D-022 deja pendiente y este cambio NO cubre:** la ruta de
  > **lectura** del historial. El rastro está escrito y ningún cliente lo puede
  > leer, así que SC-005 es cierto en almacenamiento e invisible para quien
  > audita. Con qué permiso se lee es decisión del usuario, no de este módulo.

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
- **AG-144** — CUANDO se consulte la disponibilidad de un profesional en una
  sede, el sistema NO DEBERÁ ofrecer ningún cupo que se solape con una entrada
  del mismo profesional que ocupa calendario **en cualquier sede**, con el mismo
  predicado que `agenda_entry_no_practitioner_overlap` (`released_at IS NULL AND
  blocks_calendar`, intervalo `[)`); y la lista de lo ocupado que acompaña a los
  cupos NO DEBERÁ incluir las entradas de otras sedes.
  > **Añadido el 30-09-2026 (`fix/agenda-otra-sede`).** AG-003 decía «menos las
  > entradas que ocupan calendario» y la consulta lo leía como «de esta sede»,
  > mientras que el `EXCLUDE` de AG-023 compara sólo `practitioner_id`. La
  > rejilla de la sede B ofrecía la hora en que el profesional atiende en la A,
  > y la reserva la rechazaba con `PRACTITIONER_SLOT_TAKEN`: la pantalla
  > prometía lo que la base no deja cumplir. Lo destaparon los recorridos, porque
  > la semilla da a cada médico el mismo horario en tres sedes.
  >
  > **Por qué el hueco se quita y la cita ajena no se muestra.** El cupo se
  > descuenta porque la base lo va a rechazar; la entrada de la otra sede no
  > viaja porque quien consulta puede no tener `agenda:read` allí, y AG-107 no
  > deja revelar ni que esa sede existe. La rejilla muestra el hueco ausente, no
  > el porqué.
- **AG-145** — CUANDO se consulte la disponibilidad de un profesional en una
  sede, el sistema DEBERÁ devolver en `unavailable` los intervalos en que ese
  profesional ocupa calendario en **otra** sede, recortados a las ventanas de
  las reglas vigentes de **esta** sede en las fechas abiertas del rango y
  fusionados cuando se tocan o se solapan; SI el profesional no es agendable o
  no está vinculado a esta sede, ENTONCES DEBERÁ devolverlo vacío; y cada
  intervalo NO DEBERÁ llevar más que su inicio y su fin — ni sede, ni motivo,
  ni paciente, ni tipo de entrada, ni identificador.
  > **Añadido el 30-09-2026 por la revisión clínica de AG-144.** Sin esto, un
  > día que el profesional pasa entero en otra sede llegaba sin cupos y sin
  > ocupados, y la pantalla lo leía como «Sin horario · reservar aquí será
  > sobrecupo»: un motivo falso que empujaba a la única vía que ni el `EXCLUDE`
  > ni el servidor frenan (D-069). Y en la rejilla, la hora ocupada fuera seguía
  > pareciendo libre.
  >
  > **Por qué solo dos instantes, fusionados y recortados al horario de aquí.**
  > Quien consulta puede no tener `agenda:read` en la otra sede (AG-107). Lo
  > que revelaba el `409 PRACTITIONER_SLOT_TAKEN` es que una hora **del
  > horario de esta sede** no está libre, intento a intento, y eso es lo que
  > viaja — con una diferencia que se acepta por escrito: el 409 solo llegaba
  > dentro de la ventana de reserva (AG-031, AG-033), y esto responde también
  > para fechas pasadas y hasta el rango máximo de la consulta (366 días), de
  > una vez. Siguen siendo dos instantes, sin sede ni paciente: la fusión oculta cuántas entradas hay; el recorte al horario
  > oculta cuánto dura una licencia y todo lo que el profesional hace fuera de
  > las horas que esta sede podría reservar. La segunda revisión clínica vio
  > que la primera versión, recortada solo al rango, daba un año de la agenda
  > de otra sede en una llamada, también de médicos no vinculados a esta.
  >
  > **Consecuencia que la pantalla usa:** una franja en una fecha implica que
  > esta sede tiene horario esa fecha. Un día sin regla aquí sigue leyéndose
  > «Sin horario», aunque el médico trabaje ese día en otra sede.
  > «No disponible» es el estado; el porqué es de la otra sede.
- **AG-107** — CUANDO se consulten las sedes de agenda, el sistema DEBERÁ listar
  únicamente aquellas donde quien llama tiene `agenda:read`, con identificador y
  nombre, y NO DEBERÁ revelar la existencia de las demás.
  > Añadido al construir la interfaz de E1: los grants viajan con `siteId` sin
  > nombre y no existía **ninguna** ruta que enumerara sedes, así que una
  > recepcionista no tenía forma de elegir dónde reservar. Lo detectó el
  > contrato generado, no una lectura — «la API está lista» y «la API es
  > operable desde una pantalla» no son lo mismo.
- **AG-109** — CUANDO se consulte la agenda de un día, el sistema DEBERÁ
  incluir el nombre del paciente de cada cita, en orden de archivo
  («Apellido, Nombre»), y NO DEBERÁ incluir su documento ni el motivo de
  consulta.
  > Decisión del rediseño de calendario (12-08-2026, pedida por el usuario
  > sobre su maqueta): la primera versión excluía también el nombre, y una
  > rejilla de citas anónimas es inoperable — recepción llama a la gente por
  > su nombre. La línea queda donde estaba para lo demás: la identificación es
  > operativa; el documento y el motivo son de la ficha, que se abre por su
  > ruta auditada (AG-073). AG-072 no cambia: listar sigue sin auditar por fila.
- **AG-143** — CUANDO recepción consulte el resumen de un día en la agenda, el
  sistema DEBERÁ nombrar, junto a la cifra de inasistencias, a cada paciente
  cuya cita de ese día esté en `NO_SHOW`, con su nombre en orden de archivo, la
  hora de inicio de la cita en `America/Guayaquil` y el profesional, con el
  mismo alcance de profesionales que los recuentos del resumen, y NO DEBERÁ
  mostrar su documento ni el motivo de consulta.
  > D-061, opción C (30-09-2026, decisión del autor). La rejilla no cambia:
  > una cita liberada bajo una cita viva cede carril y texto
  > (`fix/agenda-carriles`), así que si el paciente A de las 08:00 quedó como
  > inasistencia y su hora ya es de B, en la rejilla sólo se lee B. Cuando A
  > llega a las 08:15 diciendo «tenía cita a las 8», recepción lo lee en el
  > resumen sin abrir nada.
  >
  > **El límite es el de AG-109**, por la misma razón: el nombre es operativo;
  > documento y motivo son de la ficha, que se abre por su ruta auditada
  > (AG-073). No hace falta dato nuevo: la agenda del día con las liberadas ya
  > trae nombre, estado, hora y profesional. **`LEFT_WITHOUT_BEING_SEEN` no
  > entra**: esa persona sí llegó, y AG-140 ya la separa de la inasistencia;
  > nombrarla aquí haría que la lista no cuadrara con la cifra que acompaña.
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
- **AG-111** — CUANDO se consulten los profesionales agendables de una sede, el
  sistema DEBERÁ acompañar a cada uno de sus especialidades activas, con
  identificador, nombre e indicación de cuál es la principal.
  > **Por qué lo expone la agenda y no `staff`.** Es el mismo razonamiento de
  > AG-108, aplicado al defecto que una revisión destapó en C4: el diálogo de
  > reserva ofrecía **todas** las especialidades del catálogo pidiéndolas a
  > `GET /specialties`, que exige `config:read`, y el rol `RECEPCION` —el que
  > reserva— no lo tiene. El selector construido para recepción era
  > inalcanzable para recepción. La salida no es conceder `config:read` ni
  > `staff:read` al mostrador, que abriría el catálogo entero y la ficha del
  > personal para llenar un desplegable: es que **la agenda publique bajo
  > `agenda:read` el mínimo que su pantalla necesita**.
  >
  > **Y de paso deja de ofrecer combinaciones que no existen.** El profesional
  > ya tiene las suyas en `practitioner_specialty` con una `is_primary`
  > (SP-005); las demás no las ejerce, así que ofrecerlas es ofrecer un
  > rechazo. Esto es lo que hace verdadera SP-008 **para la agenda** — hasta
  > hoy sólo lo era para quien tuviera `staff:read`.
  >
  > **Sólo las activas** (SP-004): una especialidad desactivada no se ofrece
  > para citas nuevas. Un profesional cuya única especialidad se desactivó
  > llega con la lista vacía, y eso es la respuesta correcta, no un hueco.
- **AG-112** — CUANDO se consulten los tipos de atención de una especialidad
  para la agenda de una sede, el sistema DEBERÁ listar únicamente los activos,
  con identificador, nombre y duración base, y NO DEBERÁ exigir más permiso que
  `agenda:read` sobre esa sede.
  > La otra mitad de SP-028: elegida la especialidad, el diálogo necesita sus
  > tipos y cuánto dura cada uno. `GET /specialties/{id}/service-types` los
  > sirve desde C1, pero bajo `config:read`, que es de la pantalla de
  > administración —y allí sigue siendo lo correcto, porque allí se editan—.
  >
  > **La duración base viaja, y la propuesta sigue siendo del servidor.** Este
  > número es el del catálogo; el que se reserva lo resuelve
  > `GET /agenda/sites/{siteId}/duration` aplicando SP-023 entero —excepción
  > del médico primero—. Sirve para que el desplegable diga «Control · 20 min»
  > sin una petición por opción, no para calcular el fin de la cita.
  >
  > **La sede va en la ruta aunque `service_type` no tenga sede.** Es lo que
  > permite declarar `param:siteId` y que el guard decida antes que ninguna
  > tubería (AG-071): una ruta de agenda sin sede tendría que narrar su propio
  > alcance en el handler, y aquí no hay nada que narrar. El precio es que el
  > identificador de la sede no filtra nada, y se dice en voz alta.
- **AG-012** — SI la duración solicitada no es múltiplo del **turno de la sede**
  (`site_parameter.slot_atom_minutes`, AG-094), ENTONCES el sistema DEBERÁ
  rechazar la reserva con `INVALID_SLOT_DURATION` indicando la duración
  admitida.
  > **D-021, 14-08-2026. AG-012 Y AG-104 SE CUMPLEN AHORA POR CONSTRUCCIÓN, y
  > por eso siguen aquí.** Decía «múltiplo de `slot_minutes` de la regla
  > aplicable»; la regla ya no lleva ese número, porque la rejilla subió a la
  > sede como un átomo único del que **toda duración configurable es múltiplo**
  > (SP-021, SP-022, CF-062), validado al guardar.
  >
  > **Lo que desaparece no es el requisito: es que pueda fallar por
  > configuración.** Antes, una duración base de 30 sobre cupos de 20 se
  > guardaba sin protesta y recepción se topaba con el rechazo en el mostrador.
  > Hoy esa configuración no se puede guardar. Lo que estos dos requisitos
  > siguen atrapando es lo que ningún guardado puede impedir: la API recibe
  > `startsAt` y `endsAt`, no una duración, así que un intervalo compuesto a
  > mano —45 minutos sobre una rejilla de 20, un inicio a las 08:10— sigue
  > estando a un POST de distancia. **Borrarlos porque «ya no pueden pasar»
  > sería confundir la garantía con la forma en que se incumplía.**
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
  >
  > **Desde D-021 la rejilla que arbitra es la de la sede** y ya no la de la
  > regla; lo que decide DÓNDE empieza cada cupo sigue siendo la hora de
  > apertura de la regla aplicable, que es lo que hace que AG-106 siga teniendo
  > consecuencias observables.
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
  > Garantía de la base desde `20260812125924_agenda_guarantees`:
  > `agenda_entry_no_patient_overlap`, el tercer `EXCLUDE USING gist` junto a los
  > de profesional y consultorio. Comprobarlo solo en la aplicación era una
  > condición de carrera que AG-025 no cubre. Exento el sobrecupo
  > (`blocks_calendar = false`) y la cita liberada, por las mismas razones que
  > sus dos vecinos.
  >
  > _(Este recuadro colgaba de AG-105, dos requisitos más abajo, donde describía
  > una garantía que no es la suya. Recolocado el 18-08-2026.)_
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
  > **Garantía de la base desde el 13-08-2026**, en
  > `20260813025017_organization_establishment_and_emission_points`, firmada en
  > su propio comentario como `OR-021 / AG-105`: la clave foránea compuesta
  > `agenda_entry_room_in_site` sobre `(room_id, site_id) → site_room (id,
  > site_id)`, apoyada en el `site_room_id_site_unique` que PostgreSQL exige
  > como destino. Con `room_id` anulable, `MATCH SIMPLE` deja pasar la fila sin
  > consultorio —un bloqueo de agenda no ocupa sala—, y en cuanto hay valor el
  > par entero tiene que existir. La comprobación del servicio se queda para dar
  > el mensaje legible; una escritura por fuera del módulo ya no la esquiva.
  >
  > Este recuadro decía «**Falta esquema**» hasta el 18-08-2026, cinco días
  > después de que la migración existiera, y `pnpm estado` lo cantaba como uno
  > de los cuatro bloqueos del módulo. Un bloqueo inventado hace que el
  > orquestador aparte requisitos que podía trabajar.
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
  >
  > **Segunda exención, fijada por la implementación de E7.** «Dista del
  > instante actual» no dice cómo se mide para un inicio que ya pasó, y sólo hay
  > un caso donde eso ocurre: una sede que habilitó AG-031. Ahí la antelación
  > mínima **no se aplica**, porque esa sede está registrando una atención que
  > ya sucedió y medirle antelación rechazaría todos esos registros en cuanto la
  > mínima pase de cero — el interruptor que la clínica encendió a propósito no
  > haría nada. Con los valores de D-001 (0 minutos, pasado cerrado) la
  > combinación es inalcanzable; queda escrita porque una sede puede alcanzarla.
- **AG-033** — SI el inicio solicitado dista del instante actual más que la
  antelación máxima de la sede, ENTONCES el sistema DEBERÁ rechazar la reserva
  con `BOOKING_TOO_FAR` indicando la última fecha admisible.
  > **El límite es una FECHA, no un instante**, y lo fija este requisito: pide
  > que el rechazo nombre «la última **fecha** admisible» —mientras AG-032 pide
  > «el primer **instante**»— y su parámetro se cuenta en días, no en minutos.
  > La consecuencia es que el día límite es reservable entero: la frase que lee
  > recepción es igual de cierta a las 08:00 que a las 19:00. Medido desde el
  > instante, el mismo mensaje sería falso durante parte de su propio día y el
  > límite se movería según el minuto en que se preguntara. La fecha se resuelve
  > en `America/Guayaquil` (AG-001): en UTC, una cita de las 21:00 cae al día
  > siguiente y el último día admisible perdería su tarde.
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
- **AG-110** — CUANDO se reserve una cita en una fecha que un feriado cierra
  para esa sede (AG-015, AG-016, AG-091, AG-092), el sistema DEBERÁ aceptar la
  reserva y DEBERÁ advertirlo en la respuesta indicando el motivo del cierre, y
  NO DEBERÁ rechazarla.
  > D-019, 14 de agosto de 2026, decidida por el usuario: «no bloquea porque
  > muchas veces sí se trabaja». Lo encontró la revisión adversarial de E7:
  > `GET /availability` del 25 de diciembre devuelve `slots: []` y
  > `closedDates: [{ date, reason: 'Navidad' }]`, y `POST …/entries` con esa
  > misma fecha respondía **201 sin decir nada**. Dos respuestas distintas a
  > «¿qué puedo reservar?», y ningún requisito pedía que coincidieran.
  >
  > **Advierte sin impedir, que es la forma que este sistema ya usa** cuando
  > una acción es legítima pero merece constancia (AU-034). Prohibirla no
  > quitaría el caso real —una clínica con urgencias atiende el 25 de
  > diciembre—: lo empujaría fuera del sistema, que es el argumento de D-005
  > sobre el sobrecupo. Rechazar es defendible **cuando exista E4**, no antes.
  >
  > **La advertencia se calcula sobre lo que SE GUARDÓ**, no sobre lo que se
  > pidió: la fecha clínica es la del instante almacenado, resuelta en
  > `America/Guayaquil` (AG-001). Y el feriado se lee con el mismo calendario
  > que la disponibilidad, no con una segunda copia — una segunda lectura sería
  > exactamente la deriva que este requisito viene a cerrar.
  >
  > **No es un error y no lleva código.** Viaja en el cuerpo de un 201, como
  > `warnings` en la respuesta de AU-034; un `code` en el catálogo congelado
  > diría que la reserva falló, y no falló.

## 4. Sobrecupo y bloqueos

- **AG-035** — CUANDO se reserve una cita declarada como sobrecupo, el sistema
  DEBERÁ crearla con `blocks_calendar = false`, DEBERÁ exigir un motivo y DEBERÁ
  registrar quién la autorizó.
  > **Esquema resuelto el 14-08-2026 — migración
  > `agenda_overbooking_authorisation`.** `agenda_entry.overbooking_authorised_by_id`
  > apunta a la cuenta que autorizó, con `ON DELETE RESTRICT` (§5: una cita no se
  > borra, y el rastro de quién autorizó tampoco). NO se reutiliza
  > `created_by_id`: quien reserva y quien autoriza son personas distintas y ése
  > es el control entero — una columna que sirviera para las dos cosas haría
  > AG-103 incomprobable desde la fila.
  >
  > **Lo garantiza la base, no el servicio.**
  > `agenda_entry_overbooking_coherence` exige que el autorizador y el motivo
  > estén los dos presentes exactamente cuando `blocks_calendar = false`, y los
  > dos ausentes cuando ocupa calendario: un sobrecupo sin constancia no se
  > puede escribir ni por `psql`, y una cita normal no puede llevar una
  > autorización que nadie dio.
  >
  > El bloqueo se anota como resuelto y no se borra, por la misma razón que el
  > de AG-051 y el de §10: `pnpm estado` los cuenta leyendo este archivo.
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
  > **Esquema resuelto el 14-08-2026 — migración
  > `agenda_overbooking_authorisation`.** El motivo del sobrecupo es un dato
  > administrativo —por qué se rompió la rejilla—, no clínico, y tiene columna
  > propia: `agenda_entry.overbooking_reason`, hermana del autorizador de
  > AG-035. Con eso AG-036 se cumple SIN CONDICIONES —el listado expone
  > `blocksCalendar` y `overbookingReason` en todas las filas— y `reason`
  > queda fuera de toda lectura, que es lo que AG-072 y AG-074 exigen.
  >
  > **Reutilizar `reason` era la otra opción y se descartó**: exponerlo «sólo
  > cuando `blocks_calendar = false`» es exposición condicional de PHI —nada
  > impide escribir el motivo de consulta en el motivo del sobrecupo, y una
  > condición en el serializador no es una garantía—. Con dos columnas, lo que
  > el listado sirve no depende de ninguna condición: la que se sirve nunca
  > tuvo dentro un dato de salud.
- **AG-037** — CUANDO se cree un bloqueo, el sistema DEBERÁ aplicarle las mismas
  reglas de solapamiento que a una cita.
  > **Ya lo garantizaba la base, y por eso no se escribió regla nueva.** El
  > predicado de los tres `EXCLUDE USING gist` es `released_at IS NULL AND
  > blocks_calendar` —no menciona `kind`—, así que un bloqueo que ocupa
  > calendario compite exactamente igual que una cita desde
  > `20260806022956_clinical_core_constraints`. Lo que E4 añadió fue la RUTA que
  > crea el bloqueo y la traducción del rechazo; reimplementar el solapamiento
  > en TypeScript habría sido una segunda copia con una condición de carrera.
- **AG-038** — SI se intenta crear un bloqueo sobre un intervalo que ya contiene
  citas que ocupan calendario, ENTONCES el sistema DEBERÁ rechazarlo y DEBERÁ
  enumerar las citas que lo impiden.
  > **Qué se puede decir de esas citas, y qué no** (AG-072, AG-074, AG-109,
  > SC-006). Se enumeran **por su hora de inicio** —«Hay 2 citas dentro de ese
  > intervalo: 08:00, 09:00»— y nada más: ni nombre, ni documento, ni motivo de
  > consulta. El mensaje de un error llega al registro y a una captura de
  > soporte, y AG-109 concede el nombre al LISTADO del día —una ruta con su
  > permiso y su alcance—, no a un problem document. Con la hora, quien está en
  > el mostrador las abre en la agenda del día y actúa; sin la lista tendría
  > que buscarlas a mano, que es la mitad útil del requisito.
  >
  > La hora y no el identificador porque el documento RFC 9457 de este sistema
  > sirve `code`, `title`, `detail` y `errors`, y **nunca los `params` de un
  > error de dominio**: los identificadores quedan del lado del servidor. Se
  > nombran como mucho cinco horas y luego «y N más» — un bloqueo de una semana
  > de vacaciones cruza cuarenta citas, y una frase con cuarenta horas dentro
  > no la lee nadie.
  >
  > **Es una lectura antes de escribir, y el `EXCLUDE` sigue siendo la
  > garantía** (AG-037). La lista puede quedar obsoleta entre la lectura y el
  > `INSERT`; lo que no puede es dejar pasar el solapamiento, porque entonces
  > responde la base con `PRACTITIONER_SLOT_TAKEN`. Esta comprobación mejora el
  > mensaje, no sustituye al control.
- **AG-039** — MIENTRAS la sede tenga el sobrecupo deshabilitado (AG-094), el
  sistema NO DEBERÁ admitir ninguna entrada con `blocks_calendar = false` y
  DEBERÁ rechazarla con `OVERBOOKING_NOT_ALLOWED`.
  > **Nace HABILITADO en cada sede** (`site_parameter.overbooking_enabled`,
  > decisión del usuario del 14-08-2026), al revés que `allow_past_booking`. El
  > sobrecupo es la vía documentada de romper la rejilla (D-005) y una sede que
  > lo tuviera cerrado de fábrica empujaría la urgencia fuera del sistema desde
  > el primer día; lo que lo limita es el tope de D-001 —dos por profesional y
  > día—, que sí es un número. Se administra desde `configuration`, como
  > `allow_past_booking`.
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

- **AG-113** — CUANDO recepción esté reservando y el paciente no exista todavía,
  el sistema DEBERÁ permitir crearlo sin abandonar la reserva, y DEBERÁ
  continuar la reserva con la ficha recién creada.
  > Pedido por el usuario el 14-08-2026, y es la mitad que faltaba para que la
  > agenda sirva en el mostrador: el paciente nuevo es el caso NORMAL en una
  > clínica que crece, no la excepción. Obligar a cerrar la reserva, irse a
  > «Pacientes», crear la ficha y volver a empezar es donde recepción abandona
  > el sistema y apunta la cita en un cuaderno — el mismo argumento con el que
  > D-005 defiende el sobrecupo: lo que el sistema no admite no desaparece, se
  > hace fuera.
  >
  > El alta rápida NO es una ficha distinta: es la misma de `patients` con lo
  > mínimo, y lo que falte se completa después. Inventar un segundo modelo de
  > paciente «provisional» sería crear un duplicado que nadie fusiona.

- **AG-114** — CUANDO se elimine un bloqueo de agenda, el sistema DEBERÁ liberar
  el intervalo y DEBERÁ dejar constancia de quién lo eliminó y cuándo, y NO
  DEBERÁ borrar la fila.
  > Lo destapó la revisión de E4: la máquina de estados rechaza toda transición
  > de un `BLOCK`, así que un bloqueo creado por error no tenía deshacer y la
  > única salida era la base de datos. Un control sin marcha atrás se rodea: se
  > deja de usar el bloqueo y la ausencia del médico se gestiona por fuera.
  >
  > **Liberar y no borrar**, por lo mismo que AG-050 en la reprogramación: la
  > fila es la prueba de que ese intervalo estuvo cerrado, y `released_at` ya es
  > el predicado que ambos `EXCLUDE` miran. Borrarla haría desaparecer que
  > alguien bloqueó el quirófano un martes.
  >
  > **Cerrado el 14-08-2026.** `DELETE /agenda/sites/{siteId}/blocks/{entryId}`
  > bajo `agenda:write` y alcance `param:siteId`, como el resto de la agenda.
  > Pasa el bloqueo a `CANCELLED` fijando `released_at` y `cancelled_at`, por el
  > MISMO puerto que una transición: así la fila del historial (AG-004) viaja en
  > la misma transacción y el `UPDATE` condicional vuelve a arbitrar lo que se
  > leyó. No hace falta migración —`agenda_entry_kind_status_coherence` ya
  > admite `CANCELLED` para un bloqueo— ni estado nuevo, que sería una segunda
  > palabra para «ya no cierra nada».
  >
  > **No pide motivo**, a diferencia de AG-044: «quién y cuándo» son
  > `changed_by_id` y `changed_at` de la fila de historial, y un texto libre que
  > ningún requisito exige es una casilla más en la pantalla cuyo objeto es
  > deshacer un error deprisa. Un paciente merece la explicación de una
  > anulación; un bloqueo no se la debe a nadie.
- **AG-151** — SI un sobrecupo se solapa con un bloqueo del profesional en
  cualquier sede, con una entrada suya que ocupa calendario en otra sede, con
  su horario vigente en otra sede o con un sobrecupo suyo vigente en otra sede,
  ENTONCES el sistema DEBERÁ rechazarlo con
  `OVERBOOKING_PRACTITIONER_UNAVAILABLE`, diciendo cuál de los cuatro casos es
  sin nombrar la otra sede; dentro de la misma sede DEBERÁ seguir admitiéndolo
  encima de citas.
  > **D-069, recomendación ampliada aceptada el 30-09-2026.** Un sobrecupo
  > lleva `blocks_calendar = false`, así que el `EXCLUDE` por profesional no lo
  > frena, y antes de esto se podía autorizar en la Sede Sur a la hora en que
  > la médica tiene vacaciones o una cita en la Norte: el paciente llega y no
  > hay nadie. El sobrecupo existe para meter a alguien más en la consulta de
  > un médico **que está ahí** (REQ-143).
  >
  > **Sin nombrar la sede**, por AG-107: quien reserva puede no tener alcance
  > sobre la otra. «El profesional atiende en otra sede a esa hora» basta para
  > buscar otra hora.
  >
  > **Comprobación de la aplicación, con su ventana dicha.** Dos sobrecupos
  > simultáneos en dos sedes, autorizados en el mismo instante, pueden pasar
  > los dos: es la misma ventana que el tope de AG-101, que también cuenta y
  > luego escribe. Con D-070 (ST-042 sin sede) el caso del horario ajeno ya no
  > puede producirse entre dos reglas; lo que queda es el sobrecupo fuera de la
  > rejilla de su propia sede.
- **AG-152** — SI se intenta crear un bloqueo sobre un intervalo en que el
  profesional tiene un sobrecupo vigente en cualquier sede, ENTONCES el sistema
  DEBERÁ rechazarlo con `BLOCK_OVERLAPS_APPOINTMENTS` enumerando ese sobrecupo
  como AG-038 enumera las citas.
  > **D-085 §7 (01-10-2026), el camino inverso de D-069.** Un sobrecupo no
  > ocupa calendario, así que el `EXCLUDE` no lo ve: las vacaciones puestas
  > después caían encima de un paciente que viene igual.

## 5. Estados de la cita

Transiciones admitidas. Cualquier par no listado se rechaza.

| Desde         | Hacia                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `BOOKED`      | `CONFIRMED`, `CHECKED_IN`, `CANCELLED`, `NO_SHOW`, `ENTERED_IN_ERROR`     |
| `CONFIRMED`   | `CHECKED_IN`, `CANCELLED`, `NO_SHOW`, `ENTERED_IN_ERROR`                  |
| `CHECKED_IN`  | `IN_PROGRESS`, `CANCELLED`, `LEFT_WITHOUT_BEING_SEEN`                     |
| `IN_PROGRESS` | `FULFILLED`                                                               |
| `FULFILLED`, `CANCELLED`, `NO_SHOW`, `LEFT_WITHOUT_BEING_SEEN`, `ENTERED_IN_ERROR` | _(terminal)_ |
| `BLOCKED`     | `CANCELLED` _(solo por AG-114, y solo `kind = BLOCK`)_                    |

> **`CHECKED_IN → NO_SHOW` sale de la tabla con E8, y es el cambio entero.**
> Marcar «no vino» a quien está de pie en la sala de espera no es un atajo: es
> escribir en el historial un hecho falso sobre una persona, y meterlo en el
> numerador de AG-080 junto a las inasistencias de verdad. Mientras ese destino
> exista, es el que alguien va a usar —es el único que hay— y la tasa de
> inasistencia deja de medir lo que dice medir, que es exactamente el daño que
> AG-032 evitó al eximir al canal `WALK_IN`. Su reemplazo es
> `LEFT_WITHOUT_BEING_SEEN` (AG-116), que dice lo que pasó y cuenta aparte.
>
> **Los dos estados nuevos son de `kind = APPOINTMENT` y de ningún otro.** Los
> dos afirman algo de un paciente —se marchó, o la cita nunca debió existir— y
> AG-021 garantiza que un bloqueo no lo tiene. Un bloqueo creado por error tiene
> su propia salida desde el 14-08-2026 y no necesita palabra nueva: AG-114, que
> lo pasa a `CANCELLED` por una ruta propia.

**La ruta de transiciones sigue rechazando todo bloqueo** (AG-040 sobre
`assertTransition`): los seis destinos que un cliente puede pedir afirman algo
de un paciente —confirmó, llegó, se le atiende, se le atendió, no vino, se
anuló— y AG-021 garantiza que un bloqueo no lo tiene. La única salida de
`BLOCKED` es deshacer el bloqueo (AG-114), que tiene ruta propia
—`DELETE /agenda/sites/{siteId}/blocks/{entryId}`— y su propia regla pura,
`planBlockRelease`. Un bloqueo ya liberado se rechaza con
`INVALID_AGENDA_TRANSITION`, y una cita pedida por esa ruta responde
`AGENDA_ENTRY_NOT_FOUND`: `blocks/:id` no nombra citas, y distinguirlas ahí
convertiría la ruta en un oráculo de identificadores (AG-071).

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
- **AG-045** — MIENTRAS una cita tenga una atención viva (un `Encounter` que no
  esté `ENTERED_IN_ERROR`), el sistema NO DEBERÁ permitir anularla, marcarla
  como `NO_SHOW`, marcarla `ENTERED_IN_ERROR` ni marcarla
  `LEFT_WITHOUT_BEING_SEEN` salvo en el caso de AG-148; y la pantalla NO
  DEBERÁ ofrecer esas acciones.
  > **Ampliado el 30-09-2026 (D-076, D-077, D-081).** Decía «anularla ni
  > marcarla como `NO_SHOW`». Con la nota abierta la médica tenía delante a
  > un paciente «En atención» y el menú le ofrecía «Se fue sin ser atendido»
  > y «Anular…» (captura del autor): la cita seguía `CHECKED_IN` porque nada
  > la movía al abrir la nota (AG-146). Una vez abierta la nota hubo
  > atención, y la cita ya no se anula ni se da por no atendida; si la
  > atención no debió existir se anula **la atención** (EN-166), no la cita.
  > «Viva» porque una atención anulada no cuenta (EN-168): la cita vuelve a
  > estar como si no la hubiera tenido.
  > **Ventana aceptada, por escrito** (revisión adversarial de E2, P1). El
  > chequeo se decide dentro de la transacción y el `UPDATE` re-arbitra con
  > `encounter IS NULL`, así que la carrera anulación-vs-atención queda cerrada
  > hasta el intervalo intra-sentencia. Queda un resquicio: un `Encounter`
  > confirmado DESPUÉS de ese `UPDATE` sobre una cita recién anulada — nada en
  > la base ata la creación de un encounter al estado de la cita.
  > **Falta esquema.** El cierre definitivo es del módulo `encounter`: al crear
  > la atención, verificar el estado de la cita dentro de su propia transacción
  > con bloqueo de la fila de agenda (o trigger equivalente). Va con ese módulo,
  > no con una migración de agenda.
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

- **AG-116** — CUANDO una cita pase a `LEFT_WITHOUT_BEING_SEEN`, el sistema
  DEBERÁ registrar `left_without_being_seen_at`, DEBERÁ admitir un motivo
  opcional y DEBERÁ liberar el cupo fijando `released_at`; y NO DEBERÁ admitir
  esa transición desde ningún estado distinto de `CHECKED_IN`.
  > **D-A-009, pedido por el usuario COMO MÉTRICA.** El paciente llega, espera,
  > se cansa y se marcha. No es una inasistencia —vino— y no es una atención
  > —nadie lo atendió—. Sin este desenlace alguien lo marca «no vino», y la
  > métrica miente sobre la única persona que sí cumplió su parte.
  >
  > **Sólo desde `CHECKED_IN`, y es la mitad del requisito.** Es lo que hace que
  > el estado signifique algo: «se fue sin ser atendido» presupone que llegó, y
  > llegar es exactamente lo que `CHECKED_IN` registra (AG-041). Alcanzable
  > desde `BOOKED` sería un segundo sinónimo de `NO_SHOW`, y entonces cuál se
  > usa dependería de quién teclee.
  >
  > **El motivo es opcional a propósito**, al revés que en AG-044. Quien se
  > marchó no siempre dice por qué —ése es justo el caso—, y una casilla
  > obligatoria que nadie puede rellenar con la verdad se rellena con cualquier
  > cosa. La constancia que importa la da la fila de `agenda_status_history`
  > (AG-004): quién lo marcó y cuándo.
  >
  > **Libera el cupo como AG-042**, por el mismo motivo: la hora quedó vacía de
  > hecho, y una fila que sigue ocupando calendario impide reservar sobre un
  > tiempo que ya nadie usa. Con eso hereda gratis la propuesta de lista de
  > espera de AG-061, que se dispara sobre cualquier entrada liberada.
  >
  > **El valor del enum existe desde el 20-08-2026** (migración
  > `20260820052524_clinical_flow_states`): `agenda_status` ya lo admite.
  > Y **AG-046 se cumple sin tocar nada**, que no era evidente: su `CHECK`
  > `agenda_entry_kind_status_coherence` **enumera** los estados válidos para
  > `kind = BLOCK` y sólo **excluye** `BLOCKED` para `APPOINTMENT`, así que un
  > valor nuevo nace admitido para las citas y prohibido para los bloqueos, que
  > es exactamente lo que este requisito quiere. La nota de AG-046 dice que se
  > enumeran los admitidos «para que añadir un valor obligue a decidir aquí»:
  > eso es cierto de la mitad `BLOCK` del `CHECK`, no de la otra.
  >
  > **Falta esquema.** Queda `agenda_entry.left_without_being_seen_reason`, y el
  > instante: `agenda_entry` tiene `checked_in_at`, `no_show_at` y
  > `cancelled_at`, y el desenlace nuevo no tiene el suyo. No basta con la fila
  > de `agenda_status_history` —ahí está, pero AG-140 filtra por desenlace y
  > fecha sobre `agenda_entry`, y obligarla a unir contra el historial haría de
  > la métrica una consulta distinta a la de sus tres vecinas por una asimetría
  > que no responde a nada—.
- **AG-117** — CUANDO una cita pase a `ENTERED_IN_ERROR`, el sistema DEBERÁ
  exigir motivo, DEBERÁ registrar `entered_in_error_at` y DEBERÁ liberar el
  cupo; y NO DEBERÁ admitir esa transición sobre una cita que ya alcanzó
  `CHECKED_IN`.
  > **Anular una cita real y retirar una que nunca debió existir no son el mismo
  > acto** (D-A-009). Hoy las dos salen `CANCELLED` y cuentan igual en la
  > métrica de anulaciones, así que una tarde de errores de tecleo se lee como
  > una tarde en que la clínica canceló a sus pacientes. `CANCELLED` es una
  > decisión sobre una cita que existía —y por eso AG-044 exige motivo y el
  > paciente merece la explicación—; `ENTERED_IN_ERROR` dice que el hecho
  > registrado no ocurrió.
  >
  > **Exige motivo igual que AG-044, y por la razón contraria a AG-116**: aquí
  > el motivo siempre se puede escribir —quien se equivocó sabe en qué—, y sin
  > él «entrada por error» es una puerta para hacer desaparecer citas
  > incómodas sin dejar constancia de por qué. La fila de historial es
  > append-only (AG-005), así que el rastro sobrevive.
  >
  > **No después de `CHECKED_IN`**, porque en cuanto el paciente llegó la cita
  > dejó de ser sólo un registro: hay una persona en la sala y un hecho externo
  > que ocurrió. Lo que pase a partir de ahí tiene sus propios desenlaces
  > —AG-116, `CANCELLED`, la atención—. Es el mismo límite que AG-045 pone con
  > el `Encounter`: no se borra lo que ya tocó a alguien.
  >
  > **El valor del enum existe desde el 20-08-2026** (migración
  > `20260820052524_clinical_flow_states`), y AG-046 lo admite para las
  > citas y lo prohíbe para los bloqueos sin tocar el `CHECK`, por lo que se
  > explica en AG-116.
  >
  > **Falta esquema.** `agenda_entry.entered_in_error_at` y su motivo. **No** se
  > reutiliza la columna de motivo de anulación: el motivo de una retractación
  > no es el de una anulación, y una sola columna haría incomprobable desde la
  > fila cuál de los dos actos ocurrió — que es justo lo que este requisito
  > viene a separar.
- **AG-118** — CUANDO una cita pase a `CHECKED_IN`, el sistema DEBERÁ calcular
  el retraso de llegada como la diferencia en minutos entre `starts_at` y
  `checked_in_at`, DEBERÁ exponerlo en la respuesta y en el tablero, y NO DEBERÁ
  representar la llegada tardía como estado de la cita ni del paciente.
  > **La llegada tardía NO es un estado, y esto es lo que impide que se
  > convierta en uno** (D-A-009). El dato ya existe: AG-041 guarda el instante
  > real de llegada y la fila guarda la hora comprometida. Un estado
  > `LATE_ARRIVAL` sería una tercera copia de una resta —tecleada, envejecida y
  > discrepante— y además ocuparía el sitio del estado que sí hace falta:
  > `CHECKED_IN` seguiría siendo verdad al mismo tiempo, y la máquina de estados
  > tendría que estar en dos a la vez.
  >
  > **El signo importa y se conserva.** Un retraso negativo es el paciente que
  > llegó antes de su hora, que es información útil en el mostrador y en la
  > métrica de AG-141. Truncarlo a cero convertiría «llegó veinte minutos antes»
  > en «llegó a la hora».
  >
  > Se resuelve en `America/Guayaquil` (AG-001) como todo instante clínico, y
  > sale de los dos `timestamptz` de la fila: no hay nada que teclear ni nada
  > que guardar, que es la propiedad que lo mantiene cierto.
- **AG-119** — CUANDO el retraso de llegada supere el umbral de la sede
  (AG-142), el sistema DEBERÁ advertirlo en la respuesta del registro de
  llegada indicando el umbral y el retraso, y NO DEBERÁ rechazar el registro de
  llegada.
  > **Advierte sin impedir, que es la forma que este sistema ya usa** cuando una
  > acción es legítima pero merece constancia (AG-110, AU-034). Y aquí hay una
  > razón más dura que la costumbre: **la llegada es el momento en que la ley
  > obliga a calificar el estado de emergencia** (AG-128, Ley 77 art. 10). Un
  > registro de llegada que se pueda rechazar es un registro de llegada que
  > algún día no se hace, y con él se pierde la calificación que el art. 13
  > respalda con prisión. Lo que la política de la clínica decide es qué pasa
  > DESPUÉS —AG-120—, no si la persona que está delante del mostrador consta
  > como llegada.
  >
  > **No lleva código de error** porque no es un error: viaja en el cuerpo de la
  > respuesta correcta, como la advertencia de feriado de AG-110.
- **AG-120** — MIENTRAS el retraso de llegada de una cita supere el umbral de la
  sede y quien solicita la transición no tenga el permiso que la sede configura
  para admitirla (AG-142), el sistema DEBERÁ rechazar el paso a `IN_PROGRESS`
  con `LATE_ARRIVAL_NOT_AUTHORISED`, y DEBERÁ registrar quién admitió la cita
  fuera del umbral cuando sí lo tenga. DONDE la llegada esté calificada como
  situación de emergencia (AG-128), el umbral NO DEBERÁ aplicarse.

  > **La política es de la clínica; lo que el sistema aporta es poder aplicarla
  > y dejar constancia.** Sin este requisito, «a partir de veinte minutos se
  > reubica» es un cartel en la pared: se cumple con quien discute poco y se
  > salta con quien discute mucho, y no queda rastro de ninguna de las dos
  > cosas. Con él, saltárselo es un acto con nombre y hora.
  >
  > **El límite está en pasar a atención, no en llegar.** Reubicar a quien llegó
  > tarde es reprogramar su cita (AG-050), que ya existe y ya deja rastro; lo
  > que este requisito impide es que la reubicación se esquive en silencio.
  >
  > **La exención por emergencia no es un adorno: es el art. 12 de la Ley 77**
  > —«bajo ningún motivo un centro de salud podrá negar la atención de un
  > paciente en estado de emergencia»—, y su art. 13 lleva prisión. Un umbral
  > administrativo que pudiera detener a un paciente calificado como emergencia
  > convertiría un parámetro de sede mal puesto en un delito.
  >
  > Es el mismo patrón de AG-101 y AG-103: un permiso que la sede configura,
  > 403, y el rastro de quién lo ejerció en ambos caminos.

- **AG-146** — CUANDO se abra la nota clínica de una atención cuya cita esté
  `CHECKED_IN`, el sistema DEBERÁ pasar la cita a `IN_PROGRESS` en la misma
  transacción que crea la nota, con su fila en `agenda_status_history` cuyo
  autor es quien abre la nota.
  > **El estado lo marca el trabajo (AG-122), no un botón.** El eje del
  > paciente ya pasaba a `RECEIVING_CARE` al abrir la nota (EN-137) y el de la
  > cita se quedaba en `CHECKED_IN` hasta que alguien pulsara «Pasar a
  > atención», que nadie pulsa: la etiqueta leía un eje y el menú el otro.
  > Desde aquí la pantalla no ofrece «Pasar a atención»; la ruta lo sigue
  > admitiendo porque **AG-120** —sin construir— pone en ese paso el umbral de
  > llegada tardía, y dónde se aplica ahora que el paso lo da la nota lo decide
  > quien construya AG-120, no esta entrega.
  >
  > **Solo desde `CHECKED_IN`.** Una cita `BOOKED` o `CONFIRMED` cuya atención
  > se abrió sin registrar la llegada no salta a `IN_PROGRESS`: la llegada lleva
  > la calificación de emergencia (AG-128, Ley 77 art. 10) y saltarla la
  > perdería. Esa cita queda como está y AG-045 la protege igual.
- **AG-147** — CUANDO se anule la atención (EN-166) de una cita `IN_PROGRESS`,
  el sistema DEBERÁ devolver la cita a `CHECKED_IN` y su estado de paciente a
  `ARRIVED` en la misma transacción, con una fila en `agenda_status_history`
  que lleva el motivo de la anulación; y la cita DEBERÁ admitir una atención
  nueva (EN-168).
  > **D-077, D-080 §1.** La médica abrió la nota de Carlos con Juan delante:
  > el error fue abrir la atención, no dar la cita, y Carlos puede seguir en la
  > sala. `ARRIVED` y no lo que hubiera antes porque todo lo documentado de él
  > desde la llegada vivía en la atención anulada.
  >
  > **La fila de historial va hacia atrás y no borra nada**: AG-005 sigue
  > intacto, y la secuencia `CHECKED_IN → IN_PROGRESS → CHECKED_IN` es
  > exactamente lo que pasó. Si la cita ya está `FULFILLED` no se toca: la
  > anulación de una atención firmada y cerrada la corrige la atención, y la
  > cita ya no es el sitio.
- **AG-148** — CUANDO una cita `CHECKED_IN` cuya atención viva no tiene
  ningún acto clínico —nota con algo escrito, diagnóstico, procedimiento,
  receta, orden, certificado sin revocar, referencia ni interconsulta—
  pase a `LEFT_WITHOUT_BEING_SEEN`, el sistema DEBERÁ pasar esa atención, si
  sigue `OPEN` u `ON_HOLD`, a `DISCONTINUED` con origen `PATIENT`, el motivo dado (o
  «Se fue sin ser atendido» si no se dio), quien registra la salida y el mismo
  instante, en la misma transacción —una atención ya interrumpida se deja como
  está—; y CUANDO la atención tenga algún acto clínico, el sistema DEBERÁ
  rechazar la transición con `AGENDA_ENTRY_HAS_ENCOUNTER`.
  > **D-081 §2.** Recepción abrió la atención y enfermería tomó los signos,
  > pero el médico no abrió la nota: no hubo consulta. La frontera es la nota
  > (D-076). Sin esto el servidor rechazaba la salida y el paciente se quedaba
  > en el tablero para siempre.
  >
  > **D-085 §3 (01-10-2026): la frontera es cualquier acto clínico**, no solo
  > la nota: una receta emitida sin abrir la nota sigue siendo una consulta.
  > Y la escritura es condicional a que la atención siga en curso: una ya
  > interrumpida desde la atención conserva su motivo, su origen y su autor.
  >
  > **D-104 (01-10-2026).** También el certificado sin revocar, la referencia
  > (`ISSUED`, `ACCEPTED`, `COMPLETED`) y la interconsulta (`REQUESTED`,
  > `ANSWERED`): lo que impide anular la atención (D-103) cuenta como
  > atendido, con los mismos estados. Un certificado de asistencia sin nota
  > no deja la cita en «se fue sin ser atendido».
- **AG-149** — CUANDO se interrumpa la atención (EN-167) de una cita
  `IN_PROGRESS` o `CHECKED_IN`, el sistema DEBERÁ, en la misma transacción,
  pasar la cita a `FULFILLED` y su estado de paciente a `DEPARTED` si hubo
  algún acto clínico, y a `LEFT_WITHOUT_BEING_SEEN` con el cupo liberado si no
  lo hubo, con sus filas en `agenda_status_history`.
  > **D-076: hubo atención**, así que la cita nunca termina como «se fue sin
  > ser atendido». Atendida, y lo que dice que fue a medias es el estado de la
  > atención (`DISCONTINUED`, D-080 §3), que la cita publica (AG-150). Caja
  > propone la consulta y la quita con motivo (D-054 §2) **solo si hubo algún
  > acto clínico**; sin ninguno no propone nada (BI-180, D-085 §4).
  >
  > **D-099 §2 (01-10-2026).** Una cita `IN_PROGRESS` sin ningún acto vuelve
  > por `CHECKED_IN` a «se fue sin ser atendido», con sus dos filas. Una cita
  > `BOOKED` o `CONFIRMED` —la atención se abrió sin registrar la llegada— no
  > se cierra con verdad: la interrupción se rechaza
  > (`APPOINTMENT_ARRIVAL_NOT_RECORDED`) hasta registrar la llegada, que lleva
  > la calificación de emergencia (Ley 77 art. 10).
- **AG-153** — MIENTRAS la atención viva de una cita esté `OPEN` u `ON_HOLD`,
  el sistema NO DEBERÁ admitir que la cita pase a `FULFILLED`, y DEBERÁ
  rechazarlo con `ATTENTION_STILL_IN_PROGRESS`; la pantalla NO DEBERÁ
  ofrecerlo.
  > **D-099 §3 (01-10-2026).** La cita la cierran firmar o interrumpir la
  > atención. Marcada a mano, una anulación posterior dejaría una cita
  > «Atendida» sin ninguna atención detrás, y al paciente fuera de la sala.
  >
  > **Interrumpir la cierra sola (AG-149); firmar no.** La firma da el alta a
  > la atención (`DISCHARGED`) y desde ahí recepción la marca atendida, como
  > antes de esta entrega: firmar deja de estar en curso y AG-153 lo admite.
  > Que la firma cierre también la cita sería un cambio del flujo F-02 que
  > no se ha decidido; el mensaje dice lo que hay.
- **AG-150** — El sistema DEBERÁ publicar en cada cita el estado de su
  atención viva (`attention`: `null` o el `EncounterStatus`), y la pantalla
  DEBERÁ mostrar «Interrumpida» en una cita atendida cuya atención está
  `DISCONTINUED`.
  > Es el dato que AG-045 esperaba desde el 15-08-2026 para dejar de ofrecer
  > lo que el servidor rechaza. Solo el estado: el identificador de la atención
  > no viaja con la cita, porque quien ve la agenda puede no tener
  > `record:read`.

- **AG-160** — CUANDO quien tiene `record:read` elija «Ver atención» en una
  cita **cerrada** con atención (atendida, también interrumpida), la pantalla
  DEBERÁ abrir esa atención **como está**: en solo lectura si la atención ya
  terminó, y con la enmienda de su nota a mano si sólo tiene el alta
  (D-127); y SI la cita está cerrada,
  ENTONCES la pantalla NO DEBERÁ abrir una atención nueva desde ella, ni
  ofrecerlo.
  > Revisión de usabilidad del autor del 04-10-2026: una cita «Atendida» no
  > ofrecía nada salvo la ficha, y la búsqueda de su atención no encontraba
  > las cerradas, así que el camino de «Atender» habría abierto una atención
  > nueva sobre una consulta que ya ocurrió. La busca por la cita (EN-208), no
  > por el listado de la agenda (AG-150 no publica el identificador). Si no la
  > encuentra, lo dice; nunca abre el diálogo de abrir atención.
  >
  > Vale en la agenda y en el tablero del día con las cerradas a la vista.
- **AG-161** — CUANDO se vuelva desde la atención abierta con «Ver atención»,
  la pantalla DEBERÁ regresar a la agenda o al tablero en el **mismo día, la
  misma vista y los mismos filtros** de los que se salió.
  > PA-063: el `BackLink` vuelve por el historial, y el día y la vista viven en
  > la dirección de la agenda.

## 5 bis. El estado del paciente

**Es un eje distinto del estado de la cita, y no un refinamiento suyo** (D-A-008).
`CHECKED_IN` dice que el compromiso se cumplió; no dice si la persona está en
preconsulta, esperando al médico, dentro del consultorio o en el laboratorio de
al lado. El tablero del día necesita lo segundo, y ningún valor de `AgendaStatus`
lo puede contestar sin multiplicarse por seis.

**Sigue el estándar HL7 FHIR R5**, que separa `Encounter.status` —administrativo:
planificado, en curso, completado— de `Encounter.subjectStatus` —dónde está el
paciente—. No se adopta por simetría: es la separación que el estándar hizo
después de ver que un solo campo no puede contestar las dos preguntas, y sus
valores (`arrived`, `receiving-care`, `on-leave`, `departed`) son los mismos que
el flujo ecuatoriano necesita, más los dos que la preparación del A.M. 00115-2021
añade.

| Estado           | Qué afirma                                              | Lo deriva                        |
| ---------------- | ------------------------------------------------------- | -------------------------------- |
| `ARRIVED`        | Está aquí, todavía no lo ha tomado nadie                | Recepción, a mano                |
| `IN_PREPARATION` | Enfermería lo tiene en preconsulta                      | Se abre la toma de signos        |
| `READY`          | Terminó la preparación, espera al médico                | Se guardan los signos            |
| `RECEIVING_CARE` | La atención está en curso, esperas incluidas            | Se abre la nota clínica          |
| `ON_LEAVE`       | Salió del establecimiento con la atención abierta       | Se registra la salida temporal   |
| `DEPARTED`       | Terminó su paso por la clínica                          | Se cierra la cuenta              |

- **AG-121** — El sistema DEBERÁ mantener el estado del paciente separado del
  estado de la cita, con los valores `ARRIVED`, `IN_PREPARATION`, `READY`,
  `RECEIVING_CARE`, `ON_LEAVE` y `DEPARTED`, y NO DEBERÁ derivar el estado de la
  cita del estado del paciente ni al revés.
  > **El esquema existe desde el 20-08-2026** (migración
  > `20260820052524_clinical_flow_states`) y sus identificadores se citan
  > literales: el enum es `patient_subject_status` con los seis valores de
  > arriba, y las columnas son `agenda_entry.subject_status` y
  > `agenda_entry.subject_status_at`, las dos anulables —una cita que aún no
  > llegó no tiene estado de paciente, AG-127—.
  >
  > **Y la separación la garantiza la base, no la costumbre.**
  > `agenda_entry_subject_status_needs_a_patient` impide que un bloqueo tenga
  > estado de paciente —AG-021 otra vez: un quirófano no está en preconsulta— y
  > `agenda_entry_subject_status_carries_its_instant` exige que el estado y su
  > instante estén los dos o ninguno, que es lo que hace calculable AG-135.
  >
  > **Cuelga de `agenda_entry` y no de `encounter`, y es deliberado**: el
  > paciente está en la sala de espera ANTES de que exista ninguna atención, y
  > el que llega sin cita también tiene entrada de agenda (canal `WALK_IN`,
  > AG-029). Colgándolo de la atención, el tablero no podría enseñar a quien
  > acaba de llegar — que es la primera fila que alguien mira.
- **AG-122** — El sistema DEBERÁ derivar todo estado del paciente distinto de
  `ARRIVED` del hecho documentado que lo produce, y NO DEBERÁ exponer ninguna
  ruta que fije directamente `IN_PREPARATION`, `READY`, `RECEIVING_CARE`,
  `ON_LEAVE` ni `DEPARTED`.
  > **El hallazgo más replicado de veinticinco años de investigación sobre
  > tableros clínicos es que un tablero que se actualiza a mano miente.** En el
  > estudio longitudinal de referencia, a los 8-9 meses de implantar la pizarra
  > electrónica la única expectativa que NO se cumplió fue precisamente
  > «mantener la información actualizada». Y el dato que lo remata: en un
  > servicio que añadió un marcador al tablero, de 56 852 pacientes sólo el
  > **6,9 %** fue marcado.
  >
  > **Por eso la regla es una prohibición de ruta y no una recomendación.** Si
  > existe la casilla, un día se usa en vez del hecho y el tablero empieza a
  > divergir de la historia clínica; a partir de ahí ninguna de las dos se puede
  > creer. `ARRIVED` es la excepción porque el hecho que representa —la persona
  > cruzó la puerta— **no deja ningún otro rastro en el sistema**: no hay
  > alternativa, y por eso es el único que se teclea.
  >
  > **Que no haya ruta es lo que se prueba**, no que nadie la use: la prueba de
  > rutas de AG-070 recorre lo que NestJS registró de verdad, así que este
  > requisito se comprueba con la misma máquina que ya existe.
- **AG-123** — MIENTRAS la atención esté abierta, el sistema DEBERÁ mantener al
  paciente en `RECEIVING_CARE` durante las esperas entre pasos, y NO DEBERÁ
  introducir para ellas ningún estado de espera propio.
  > **Es la definición textual de FHIR R5 y conviene respetarla**:
  > `receiving-care` incluye *«periods of waiting between care»*. Esperar entre
  > un paso y el siguiente **es parte de la atención**, no un limbo entre dos
  > atenciones. Un estado «esperando resultado» o «esperando al médico otra vez»
  > partiría el tiempo de una misma visita en trozos, y entonces el tiempo en el
  > estado actual (AG-135) —que es el dato por el que existe el tablero— se
  > reiniciaría cada vez que alguien entra y sale del consultorio, justo cuando
  > más importa que siga corriendo.
  >
  > `READY` no lo contradice: ésa es la espera **antes** de que la atención se
  > abra, cuando todavía no hay nada en curso.
- **AG-124** — CUANDO se registre que el paciente sale del establecimiento con
  la atención abierta, el sistema DEBERÁ pasarlo a `ON_LEAVE`, DEBERÁ registrar
  el hecho que originó la salida, y NO DEBERÁ cerrar la atención ni dar por
  terminado su paso por la clínica.
  > El caso real es el laboratorio externo y la imagen que se hace en la otra
  > cuadra: el paciente se va y vuelve, y su atención sigue abierta. Sin este
  > estado, el tablero lo enseña «en atención» ocupando un consultorio vacío
  > durante una hora, o alguien lo cierra para que desaparezca de la lista y la
  > atención queda sin cerrar de verdad.
  >
  > **Sigue derivándose de un hecho documentado** (AG-122) y no de una casilla:
  > lo que lo dispara es la orden o la derivación que manda al paciente fuera,
  > que es un registro clínico con autor e instante.
  >
  > **El hecho que lo dispara ya tiene forma desde el 20-08-2026**: la misma
  > migración `20260820052524_clinical_flow_states` dio a `encounter` una
  > columna `status` con el valor `ON_HOLD` —«empezada, suspendida
  > temporalmente, SE ESPERA DE VUELTA»—, que es exactamente este caso visto
  > desde el otro eje. `ON_LEAVE` es lo que el tablero enseña cuando la atención
  > está `ON_HOLD`, y por eso los dos ejes no se pueden colapsar: el paciente
  > puede estar `RECEIVING_CARE` con la atención `ON_HOLD` mientras baja a
  > rayos.
  >
  > Lo que todavía no existe es la **orden de examen** que ponga la atención en
  > `ON_HOLD`, que es de `encounter` y de su entrega H8. Hasta entonces
  > `ON_LEAVE` es alcanzable en el modelo y no lo dispara nada — la respuesta
  > honesta, no un hueco.
- **AG-125** — CUANDO se cierre la cuenta de la atención, el sistema DEBERÁ
  pasar al paciente a `DEPARTED`, y `DEPARTED` NO DEBERÁ admitir ninguna
  transición posterior dentro de la misma cita.
- **AG-126** — El sistema DEBERÁ registrar todo cambio de estado del paciente
  con estado anterior, estado nuevo, autor, instante y el hecho que lo derivó, y
  DEBERÁ tratar ese registro como append-only: ninguna operación lo actualiza ni
  lo borra, y la base DEBERÁ rechazar el intento venga de donde venga.
  > **Es la misma garantía que AG-005 y por la misma razón**, más una propia: el
  > hecho que derivó cada cambio es lo único que permite comprobar que el
  > tablero no se tecleó. Sin esa columna, «se deriva de un hecho documentado»
  > es una afirmación sobre el código y no sobre los datos, y un día que alguien
  > añada la ruta prohibida por AG-122 nada en la base lo delataría.
  >
  > **Falta esquema.** Es el hueco que queda del eje entero.
  > `agenda_entry.subject_status_at` guarda **sólo el último** instante: al
  > tercer cambio no se puede contestar cuándo fueron los dos primeros ni quién
  > los provocó. Es literalmente el defecto que AG-064 tenía con
  > `last_contacted_at` y que se cerró construyendo
  > `waitlist_contact_attempt`. Hace falta `agenda_subject_status_history` con
  > la forma y los disparadores de `agenda_status_history` —rechazo de `UPDATE`,
  > `DELETE` y `TRUNCATE`, clave foránea `RESTRICT` (D-022)—, más la referencia
  > al hecho que lo originó.
  >
  > **No se reutiliza `agenda_status_history`**: son dos ejes distintos (AG-121)
  > y mezclarlos obligaría a que sus dos columnas de estado fueran anulables,
  > que es como se pierde la garantía de que siempre hay una.
  >
  > La columna `subject_status_at` **se queda**, al revés que el contador de
  > AG-064: no es una segunda verdad sobre el mismo hecho, es la caché de la
  > última fila y es lo que hace que AG-135 se calcule sin unir contra la
  > historia en cada carga del tablero.
- **AG-127** — MIENTRAS la cita no haya alcanzado `CHECKED_IN`, el sistema NO
  DEBERÁ asignarle estado de paciente; y CUANDO la cita pase a
  `LEFT_WITHOUT_BEING_SEEN`, el estado del paciente DEBERÁ pasar a `DEPARTED`.
  > El estado del paciente sólo existe **dentro de una llegada**. Una cita en
  > `BOOKED` no tiene a nadie en ningún sitio, y darle `ARRIVED` por defecto
  > llenaría el tablero de gente que no ha venido — que es exactamente la clase
  > de mentira que AG-122 evita.
  >
  > La segunda mitad cierra el único desenlace que dejaría a alguien en el
  > tablero para siempre: quien se marchó sin ser atendido no pasa por caja, así
  > que nada de AG-125 se dispara nunca.

## 5 ter. La calificación de emergencia al llegar

**Esto no es opcional, no depende de que la clínica tenga urgencias y no es una
elección de diseño.** La **Ley de Derechos y Amparo del Paciente (Ley 77**, R.O.
Sup. 626 de 3-II-1995) obliga en su **art. 10**: *«El estado de emergencia del
paciente será calificado por el centro de salud al momento de su arribo»*. Su
**art. 1** enumera expresamente a las **clínicas** entre los establecimientos
alcanzados, y su **art. 13** lo respalda con **prisión de 12 a 18 meses — de 4 a
6 años si el paciente desatendido fallece** (D-A-002).

**No es triaje y no es una escala de gravedad.** No reordena la agenda, no
clasifica en niveles y no exige que nadie sepa medicina de urgencias: es la
constancia de que la calificación del art. 10 se hizo. El día que alguien
reclame, esa fila es la diferencia entre un incidente y una imputación penal.

- **AG-128** — CUANDO se registre la llegada de un paciente, el sistema DEBERÁ
  exigir la calificación de situación de emergencia como valor afirmativo o
  negativo explícito, DEBERÁ registrar quién la hizo y en qué instante, y NO
  DEBERÁ admitir el registro de llegada sin ella.
  > **Explícito, y por eso no lleva valor por defecto.** Un campo que nace en
  > «no» y se puede dejar como está no prueba que nadie calificara nada: prueba
  > que nadie lo tocó. Lo que el art. 10 obliga a poder demostrar es que hubo
  > una calificación, y una calificación es un acto de una persona en un
  > instante.
  >
  > **Media pieza existe desde el 20-08-2026** (migración
  > `20260820052524_clinical_flow_states`): `agenda_entry.emergency_flagged_at`,
  > `emergency_flagged_by_id` —con `ON DELETE RESTRICT`, el rastro de quién
  > calificó no se borra, como el autorizador de AG-035— y `emergency_note`,
  > atados por `agenda_entry_emergency_flag_names_who_and_when`, que exige que
  > el quién y el cuándo estén los dos o ninguno.
  >
  > **Falta esquema.** Y es justo la mitad que la ley exige: esas tres columnas
  > registran la calificación **afirmativa** y nada más: con ellas, `NULL` no
  > distingue «se calificó y no era una emergencia» de «nadie calificó nada», y
  > lo que el art. 10 obliga a poder demostrar es lo segundo. Hacen falta las
  > dos columnas del ACTO —quién calificó y cuándo, con independencia del
  > resultado— y un `CHECK` que las exija presentes exactamente cuando la cita
  > alcanzó `CHECKED_IN`, en la forma de `agenda_entry_overbooking_coherence`.
  > Sin ese `CHECK` la exigencia vive sólo en el servicio, y una escritura por
  > fuera del módulo deja una llegada sin calificar que nada delata.
- **AG-129** — CUANDO la calificación de emergencia sea afirmativa, el sistema
  DEBERÁ avisar al profesional de turno de la sede y DEBERÁ dejar constancia del
  aviso con su destinatario y su instante.
  > **La consecuencia es fija y no configurable**, al revés que casi todo lo de
  > §10. Un aviso que una sede pueda apagar es un aviso que el día del incidente
  > no existió, y lo que la ley no admite es que la calificación no tenga
  > efecto: el art. 8 exige recibir **inmediatamente** y el art. 12 prohíbe
  > negar la atención.
  >
  > **La constancia del aviso importa tanto como el aviso.** «Se avisó» sin
  > destinatario ni hora no es prueba de nada; con ellos, la fila contesta a
  > quién se avisó y cuándo, que es lo que se pregunta después.
  >
  > **Falta esquema.** No existe «profesional de turno» como dato: hoy la sede
  > tiene profesionales agendables (AG-108) y reglas de horario, no un turno. Y
  > no existe ningún canal de notificación en el sistema —el portal es Fase 3 y
  > los recordatorios Fase 4—. Las dos piezas son de esta entrega y hay que
  > construirlas; mientras no existan, el requisito no se puede cumplir a medias
  > escribiendo sólo la fila.
- **AG-130** — La calificación de emergencia NO DEBERÁ admitir grados ni
  niveles, NO DEBERÁ alterar por sí sola el orden de la agenda ni la prioridad
  de la lista de espera, y NO DEBERÁ exigir ningún permiso distinto del que
  registra la llegada.
  > **Los tres «no» son el requisito.** El primero impide que esto se convierta
  > en el triaje que este sistema decidió no construir: si algún día se abre
  > urgencias, la tipología obliga a **Manchester Modificado** acreditado ante
  > la ACESS, y eso es una decisión de negocio con consecuencias regulatorias,
  > no una casilla. El segundo lo separa de la marca de «atender primero», que
  > ya está decidida aparte (D-033) y sí exige permiso y motivo. El tercero es
  > el que lo hace exigible: un permiso propio significaría que hay
  > recepcionistas que no pueden calificar, y entonces el art. 10 se incumple
  > los días que esa persona está en el mostrador.
- **AG-131** — El sistema DEBERÁ admitir que la verificación de cobertura se
  omita en el registro de llegada dejando constancia del motivo, y NO DEBERÁ
  condicionar el registro de llegada, la calificación de emergencia ni el paso a
  `IN_PROGRESS` a que se haya registrado forma de pago.
  > **El art. 9 de la Ley 77 prohíbe exigir cheque, tarjeta o cualquier
  > documento de pago como condición previa a ser recibido y estabilizado**, y
  > el art. 8 obliga a recibir al paciente en emergencia sin pago previo. Una
  > pantalla de llegada que bloquee el paso hasta registrar la forma de pago
  > sería ilegal **justo en el caso en que más importa**, que es el único en que
  > alguien la va a mirar después.
  >
  > **Y aun así hay que preguntarlo, y al llegar.** Quién paga decide el precio
  > de todo lo que venga después; preguntarlo en caja es valorar con el precio
  > equivocado lo que ya se hizo. Lo que este requisito fija no es que se deje
  > de preguntar: es que la respuesta pueda ser «ahora no» **con su motivo**,
  > que es lo que distingue un dato que falta de un dato que se decidió no
  > exigir.
  >
  > **El servidor no basta y por eso el requisito nombra las tres puertas.** Un
  > backend que acepta el campo vacío y una interfaz que no deja avanzar sin
  > llenarlo incumplen exactamente igual, y quien responde es la clínica.
  >
  > **El esquema existe desde el 20-08-2026** (migración
  > `20260820052524_clinical_flow_states`):
  > `agenda_entry.coverage_check_skipped_reason`, y su propio comentario cita el
  > art. 9. Lo que falta no es columna: es que las dos capas dejen de exigir el
  > dato, que es donde el requisito se incumple de verdad.
- **AG-132** — El registro de la calificación de emergencia DEBERÁ ser
  append-only: ninguna operación lo actualiza ni lo borra, y la base DEBERÁ
  rechazar el intento venga de donde venga.
  > Es la garantía de AG-005 aplicada a la fila que puede acabar delante de un
  > juez. Una calificación que se pueda reescribir después del incidente no
  > prueba lo que el art. 10 pide que se pruebe: la prueba es que la fila no ha
  > podido cambiar.
  >
  > **Falta esquema.** Un disparador `BEFORE UPDATE` sobre `agenda_entry` que
  > rechace modificar las tres columnas de AG-128 una vez escritas —no un
  > disparador de tabla entera, porque la fila sí cambia por lo demás—, en la
  > misma forma que `trg_agenda_status_history_immutable`.

## 5 quater. El tablero del día

**Una lista ordenada por hora, no un kanban** — el porqué está en la nota de E9,
y es evidencia, no preferencia. Lo que el tablero aporta sobre el calendario no
es qué pacientes hay, sino **en qué se está desviando la realidad del plan**:
quién lleva cuarenta minutos esperando, qué consultorio está ocupado, qué cita se
pasó de hora.

- **AG-133** — CUANDO se consulte el tablero del día de una sede, el sistema
  DEBERÁ devolver las citas cuya fecha clínica sea la solicitada, ordenadas por
  instante de inicio, opcionalmente acotadas por especialidad y por profesional,
  y DEBERÁ resolver los límites del día en `America/Guayaquil`.
  > **El orden es por la hora de la cita y no por el estado**, porque la hora es
  > el compromiso con el paciente y es lo único que no se mueve. Ordenar por
  > estado agrupa lo que ya se distingue por color y esconde al que lleva más
  > tiempo esperando entre los de su grupo.
  >
  > La sede va en la ruta —`param:siteId`, AG-071—; especialidad y profesional
  > son filtros de consulta, que es lo que pidió el usuario y lo que hacen los
  > cuatro sistemas de referencia.
- **AG-134** — El tablero DEBERÁ incluir por cada fila la hora de la cita, la
  identificación del paciente según la proyección, el profesional, el
  consultorio, el estado de la cita, el estado del paciente, el tiempo en el
  estado actual y la nota corta.
  > **La nota corta recupera algo que se perdió al informatizar la pizarra.** Al
  > sustituir la de rotulador por una electrónica se documentó la pérdida de
  > funciones que nadie había escrito: los símbolos improvisados entre colegas,
  > las señales visuales inmediatas. Un campo de texto corto y libre por fila es
  > lo que las devuelve.
  >
  > **Falta esquema.** `agenda_entry.board_note`, texto corto. No se reutiliza
  > `reason`: esa columna es donde recepción escribe el motivo de consulta y por
  > eso quedó fuera de toda lectura (AG-036, AG-072, AG-074), y una nota de
  > tablero que compartiera columna con un dato de salud volvería a meterlo en
  > una pantalla que está a la vista.
- **AG-135** — El sistema DEBERÁ calcular el tiempo transcurrido en el estado
  actual a partir del instante del último cambio registrado, y NO DEBERÁ
  admitirlo como dato de entrada en ninguna ruta.
  > **Es lo que hace útil el tablero y es lo que nunca teclea nadie.** Un número
  > que se escribe a mano envejece en el minuto siguiente; éste sale de las
  > filas de AG-004 y AG-126, que ya existen y son append-only.
  >
  > Se calcula sobre el estado del PACIENTE cuando lo hay, y sobre el de la cita
  > cuando todavía no —una cita que aún no llegó no tiene estado de paciente
  > (AG-127)—.
- **AG-136** — El sistema DEBERÁ servir el tablero en dos proyecciones,
  `STAFF` y `PUBLIC`, cada una con su propia ruta y su propio permiso, y NO
  DEBERÁ exponer ningún parámetro que convierta una en la otra.
  > **Dos proyecciones, no un interruptor de «modo privacidad»: el interruptor
  > se queda mal puesto.** Una pantalla colgada hacia la sala de espera se
  > configura una vez y se olvida durante dos años; el día que alguien reinicia
  > el equipo o abre la vista en otro navegador, un interruptor vuelve a su
  > defecto y el nombre completo de cada paciente queda a la vista de la sala.
  > Con dos rutas y dos permisos, la pantalla pública **no tiene forma** de
  > pedir la otra: no es que no la muestre, es que su sesión no la puede leer.
  >
  > **Permiso nuevo, `agenda:board:public`**, en `permission.catalogue.ts`. Es
  > cambio de código por lo mismo que AG-099: el catálogo es la enumeración
  > contra la que se valida cada ruta. A qué rol se concede es configurable, y
  > el rol que lo lleva es el de la pantalla de sala, que no lleva `agenda:read`.
- **AG-137** — MIENTRAS la proyección sea `PUBLIC`, el sistema DEBERÁ reducir la
  identificación del paciente al turno o al nombre y la inicial del primer
  apellido, y NO DEBERÁ incluir documento, nombre completo, motivo de consulta,
  diagnóstico, medicación ni la nota corta.
  > **Es la única pantalla del sistema que ve gente que no es el paciente**, y
  > por eso la línea de AG-109 —que concede el nombre al listado del día porque
  > recepción llama a la gente por su nombre— no se puede estirar hasta aquí:
  > allí quien mira es personal con permiso y alcance; aquí mira la sala de
  > espera entera.
  >
  > La nota corta queda fuera aunque no sea un dato clínico por definición:
  > es texto libre (AG-134) y nada impide que alguien escriba en ella lo que
  > AG-072 y AG-074 mantienen fuera de las lecturas. Es el mismo razonamiento
  > que dejó `reason` fuera del listado.
  >
  > > **[NECESITA ACLARACIÓN]** — turno o nombre e inicial: son dos formas
  > > distintas y la clínica tiene que elegir una. El turno no identifica a
  > > nadie pero obliga a repartir números en recepción; el nombre e inicial no
  > > cambia el flujo pero sigue identificando a quien ya sabe a quién busca. Y
  > > el razonamiento sobre qué puede verse en una pantalla a la vista está
  > > tomado de la guía estadounidense de divulgaciones incidentales, que es el
  > > estándar internacional de referencia: **HIPAA no aplica en Ecuador** y lo
  > > vinculante aquí es la **LOPDP**, que hay que verificar antes de cerrar
  > > esto. Es decisión de negocio y legal, no de un agente.
- **AG-138** — El sistema DEBERÁ resolver el conjunto de campos de la proyección
  `STAFF` a partir de una configuración por rol, administrable sin desplegar
  código, y NO DEBERÁ servir el mismo conjunto a todos los roles.
  > **Está medido que enfermería y médicos difieren significativamente en qué
  > les resulta útil en un tablero**: no existe «una» vista buena para todos, y
  > servir la unión de las dos es la forma de que ninguna de las dos se lea. Es
  > el mismo razonamiento de AG-099 aplicado a columnas en vez de a permisos:
  > qué campos existen es código, quién ve cuáles es configuración.
  >
  > **Falta esquema.** Una tabla `board_view_field` que ate rol y campo, con la
  > semilla de las dos vistas de arranque. El conjunto de campos posibles es una
  > unión cerrada en el código, como `permission.catalogue.ts`, para que un
  > campo nuevo obligue a decidir quién lo ve.
- **AG-139** — CUANDO se consulte el tablero, el sistema DEBERÁ registrar en la
  bitácora de acceso quién lo consultó, cuándo, desde dónde y con qué
  proyección, y NO DEBERÁ registrar un acceso por cada fila listada.
  > **Las dos mitades son la misma decisión que AG-072 y AG-073**, aplicada a
  > una pantalla que se abre una vez y se mira todo el día: una fila por consulta
  > es lo que permite contestar quién estaba mirando el tablero a las once; una
  > fila por cita convertiría la bitácora de historia clínica en ruido y haría
  > fallar SC-004.
  >
  > **Y de paso contesta si el tablero se usa de verdad**, que es el dato que
  > falta en todos los casos documentados de pizarra electrónica abandonada.

## 6. Reprogramación

- **AG-050** — CUANDO se reprograme una cita, el sistema DEBERÁ liberar el cupo
  original y crear una entrada nueva, y NO DEBERÁ mover el intervalo de la fila
  existente.
- **AG-051** — CUANDO se reprograme una cita, el sistema DEBERÁ dejar en el
  historial de ambas entradas la referencia a la otra.
  > **Esquema resuelto el 14-08-2026 — migración `agenda_reschedule_link`.**
  > `agenda_entry.rescheduled_from_id` apunta a la entrada de la que procede,
  > con `ON DELETE RESTRICT` (§5: una cita no se borra) y un índice único
  > **parcial**, `agenda_entry_one_reschedule_per_entry`, que hace dos cosas a
  > la vez: garantiza que una cita se reprograma **una** vez —anularla es
  > terminal— y es el índice con el que se recorre la cadena hacia adelante.
  > Con una sola columna se contestan los dos sentidos, y la respuesta viaja en
  > las dos entradas (`rescheduledFromId`, `rescheduledToId`).
  >
  > **No hace falta una tabla de enlace ni una columna en
  > `agenda_status_history`.** La relación es 1:1 y de una sola naturaleza, y
  > el CUÁNDO y el QUIÉN ya los guarda la fila de historial que la anulación
  > escribe en la misma transacción (AG-004). Lo que faltaba no era dónde
  > apuntar el hecho, sino un enlace **recorrible**: en el `note` no lo era.
  >
  > El bloqueo se anota como resuelto y no se borra, por la misma razón que el
  > de §10: `pnpm estado` los cuenta leyendo este archivo, y un bloqueo que
  > desaparece sin dejar rastro se vuelve a declarar la próxima vez.
- **AG-052** — SI la cita nueva no puede crearse, ENTONCES el sistema NO DEBERÁ
  liberar el cupo original.
  > **Es una propiedad transaccional, y por eso E3 no es «anular y volver a
  > reservar» encadenados.** Liberar el original y crear la entrada nueva
  > ocurren en UNA transacción (`AgendaRepository.reschedule`): si el cupo
  > destino está ocupado, si el paciente ya tiene cita solapada o si la ventana
  > de reserva de la sede lo rechaza, la transacción entera se deshace y el
  > original sigue ocupando calendario. Compuesta con dos llamadas, la primera
  > ya habría confirmado cuando la segunda se rechaza, y el paciente se
  > quedaría sin ninguna cita — que es exactamente lo que este requisito
  > prohíbe. La prueba que lo demuestra reserva el destino primero y comprueba
  > que el original **sigue reservable como calendario ocupado**, no que se
  > lanzó un error.

- **AG-115** — CUANDO se reprograme una cita, el sistema DEBERÁ admitir que la
  entrada nueva sea de otro profesional o de otro tipo de atención, y DEBERÁ
  aplicarle las mismas comprobaciones que a una reserva.
  > Preguntado por el usuario el 14-08-2026 —«¿el reprogramar se puede cambiar
  > de médico, especialidad?»— sobre una implementación que sólo admitía hora,
  > canal y motivo.
  >
  > **Prohibirlo no impide el caso: le quita el rastro.** Recepción que se
  > equivocó de médico anula y vuelve a reservar, y entonces se pierde
  > exactamente lo que AG-051 acaba de construir — la referencia entre las dos
  > entradas—, y la métrica de inasistencia cuenta una anulación que nunca lo
  > fue. Es el argumento de D-005 con el sobrecupo y el de D-019 con los
  > feriados: lo que el sistema no admite se hace fuera de él.
  >
  > **Mecánicamente no cuesta nada**: AG-050 ya libera la original y CREA una
  > entrada nueva, así que el profesional y el tipo son campos de una fila que
  > nace, no una mutación de la que existía. Lo que NO cambia es el **paciente**:
  > una cita de otra persona no es una reprogramación, es otra cita, y admitirlo
  > convertiría un error de tecleo en una cita atribuida a quien no la pidió.

## 7. Lista de espera

- **AG-060** — CUANDO no haya cupo disponible en el rango solicitado, el sistema
  DEBERÁ permitir inscribir al paciente en lista de espera con sede, rango de
  fechas preferido y, opcionalmente, profesional y tipo de servicio.
  > **El esquema que faltaba existe desde el 19-08-2026**
  > (`waitlist_service_type_follows_agenda`). El TIPO DE SERVICIO no se admitía
  > al cerrar E5 y por eso la mitad de AG-061 que compara los dos tipos no se
  > podía comprobar de extremo a extremo: `waitlist_entry.service_type_concept_id`
  > apuntaba a `catalog_concept` desde `clinical_core`, mientras
  > `agenda_entry.service_type_id` pasó a `service_type` con C4
  > (`20260812222827_configuration_specialties_and_durations`, SP-028). Con dos
  > tablas distintas lo guardado en la inscripción NUNCA podría coincidir con el
  > tipo de la cita que libera el cupo, y el campo sólo habría servido para
  > rechazar por clave foránea todo identificador legítimo.
  >
  > **La columna se movió a `service_type_id` con su clave foránea a
  > `service_type`** —una migración, no una tanda de código: la tabla estaba
  > vacía y no hubo dato que trasladar—. `ON DELETE RESTRICT` en los dos lados,
  > como SP-025: un tipo que alguien espera no se borra. Las dos mitades de
  > AG-061 se comprueban ahora de extremo a extremo en
  > `agenda-waitlist-http.spec.ts`, y la clave foránea en
  > `agenda-waitlist.spec.ts`.
  >
  > La ANTELACIÓN de la inscripción tampoco tiene tope: cuánto tiempo puede
  > alguien seguir esperando es política de la clínica, no del código. Lo que
  > impide que una entrada espere para siempre es AG-065, que exige fecha máxima
  > y la base ya la hace obligatoria.
- **AG-061** — CUANDO se libere un cupo que ocupaba calendario, el sistema
  DEBERÁ proponer los candidatos de la lista de espera compatibles con ese cupo,
  ordenados por prioridad ascendente y, a igual prioridad, por antigüedad de
  inscripción. Compatible significa: misma sede, y el cupo cae dentro de
  `preferred_from`–`preferred_to`, y —si la entrada los fija— mismo profesional y
  mismo tipo de servicio. **SI la hora de inicio del cupo liberado ya pasó,
  ENTONCES el sistema NO DEBERÁ proponer ningún candidato y DEBERÁ rechazar la
  consulta con `RELEASED_SLOT_IN_THE_PAST`.**
  > **UN CUPO QUE YA PASÓ NO ES UN CUPO, desde el 19-08-2026.** Lo contó quien
  > lo sufrió: «yo llamo y contesta, pero ya llamé hoy en la tarde y la cita era
  > en la mañana; cuando le digo aprobar el cupo me sale error». Una cita anulada
  > por la mañana seguía ofreciéndose por la tarde —nada cambia en la fila cuando
  > su hora pasa, sólo se mueve el reloj—, así que la cola proponía, alguien
  > llamaba **a una persona de verdad**, aceptaba, y la reserva chocaba con
  > AG-031. **El daño no era el error final**: era la llamada gastada y el
  > INTENTO consumido de los que la entrada tiene antes de caducar (AG-066),
  > sobre un rastro que es append-only y no se puede deshacer.
  >
  > **EL BORDE ES EL INSTANTE Y ES ESTRICTO**, exactamente como `checkBookingWindow`
  > lee AG-031: lo que empieza dentro de cinco minutos se propone, lo que empezó
  > hace un minuto no, y **lo que empieza justo ahora sí se propone** —porque es
  > la reserva de ventanilla que la reserva misma acepta (D-001 dejó la
  > antelación mínima en cero)—. Si las dos reglas leyeran el borde distinto, la
  > cola escondería un cupo que el sistema sí deja tomar, o volvería a llevar de
  > la mano hasta el muro. El instante, y no el día: 08:00 y 19:00 de hoy son la
  > misma fecha y a mediodía sólo uno de los dos se puede dar. El «ahora» se
  > resuelve **una sola vez por consulta** y su día en `America/Guayaquil`
  > (AG-001), y entra en el dominio como parámetro.
  >
  > **NO SE REPITE AL CONVERTIR NI AL REGISTRAR UN INTENTO.** Registrar un
  > intento no nombra ningún cupo —lleva entrada y resultado y nada más—, así que
  > el agujero no existe ahí: la llamada sólo se hace porque la cola propuso, y
  > es ahí donde se corta. Y `POST …/conversion` no reserva: enlaza una cita que
  > **ya existe**, y la única forma de que exista es la ruta de siempre, donde
  > AG-031 ya se aplicó con el `allow_past_booking` de la sede. Repetir la
  > comprobación al convertir sería una copia más débil de esa regla en el único
  > sitio donde NO debe valer —una sede que registra atenciones a posteriori
  > tiene una cita pasada legítima que enlazar—.
  >
  > **Y LA ANTIGÜEDAD SOBREVIVE A UNA FUSIÓN DE FICHAS, desde el 19-08-2026:
  > está en `PA-060` de `patients` y no aquí** (D-041, opción B). Una
  > inscripción no sólo se lee —se convierte en cita—, así que el alcance de
  > PA-055 no la alcanza: reservar para la ficha absorbida se rechaza (AG-027)
  > y `trg_waitlist_entry_conversion_consented` exige que la cita sea del mismo
  > `patient_id`. La fusión crea en la superviviente una inscripción
  > equivalente **con el `created_at` original**, y deshacerla la retira. El
  > requisito vive en `patients` porque lo que cambia es **lo que hace una
  > fusión**, no lo que hace la cola: nada de AG-060 a AG-067 se dispara con
  > una fusión, y quien quiera saber qué toca una fusión lo busca en la
  > sección 7 de `patients`, donde ya están el documento de identidad (PA-043)
  > y la lectura por el enlace (PA-055). Aquí sólo se dice que ocurre.
- **AG-062** — El sistema DEBERÁ admitir prioridad 1 para los grupos de atención
  prioritaria del artículo 35 de la Constitución: adultos mayores, niñas, niños y
  adolescentes, mujeres embarazadas, personas con discapacidad, personas privadas
  de libertad y quienes adolezcan de enfermedades catastróficas o de alta
  complejidad. NO DEBERÁ tratarse como preferencia opcional.
  > **El esquema que faltaba existe desde el 16-08-2026** (entrega P3 de
  > `patients`: PA-033 a PA-042, D-026, D-027). Este requisito estuvo declarado
  > como bloqueo desde el 14-08-2026 —«E5 no se abre hasta que el módulo de
  > paciente los tenga»— y ya no lo está: la ficha registra los grupos como
  > filas fechadas con vigencia, origen y autor.
  >
  > **Qué lee la agenda, y qué NO.** Lee la **prioridad ya calculada**, que
  > viaja como el campo `priority` de toda respuesta que lleva un paciente y
  > basta con `patient:read`: `1` es prioritario por el artículo 35 y `2`
  > corriente, sin decir por qué. El MOTIVO tiene su propio permiso
  > (`patient:priority`, D-029) y su propia fila de bitácora, y **no viaja en
  > ningún listado** (PA-042, AG-073). Ordenar la lista de espera por ese número
  > es todo lo que AG-061 necesita.
  >
  > **Y son diez grupos, no seis** (D-027): el artículo 35 tiene dos frases, y
  > la segunda —personas en situación de riesgo, víctimas de violencia doméstica
  > y sexual, de maltrato infantil y de desastres— concede «la misma atención
  > prioritaria». Los diez cuentan para el orden; los cuatro de la segunda frase
  > exigen una llave aparte para LEERSE, que la agenda no necesita porque nunca
  > ve el motivo.
  >
  > Sigue en pie lo que decidió D-003: **no se implementa sólo por edad**. Media
  > prioridad aplicada es peor que ninguna, porque parece que funciona.
- **AG-063** — CUANDO una entrada de lista de espera se convierta en cita, el
  sistema DEBERÁ marcarla `SCHEDULED` y DEBERÁ enlazarla con la cita creada.
- **AG-064** — El sistema DEBERÁ registrar cada intento de contacto con su
  instante, y NO DEBERÁ reasignar automáticamente el cupo sin confirmación.
  > **El esquema que faltaba existe desde el 19-08-2026**
  > (`agenda_waitlist_contact_trail`). Este requisito estuvo declarado como
  > bloqueo desde el 12-08-2026 —`waitlist_entry` guardaba `contact_attempts`,
  > un contador, y `last_contacted_at`, sólo el último, así que al tercer
  > intento no se podía responder cuándo fueron los dos primeros ni quién
  > llamó— y ya no lo está: `waitlist_contact_attempt` registra **cada intento
  > con su instante, su autor y su resultado**, y es append-only por lo mismo
  > que `agenda_status_history` (D-022) — un rastro que se puede reescribir
  > después de dar el cupo a otra persona no prueba el reparto, lo decora.
  >
  > **Se construyó en lugar de rebajarse.** D-006 anotó lo contrario cuando E5
  > no tenía fecha; rebajar el requisito es cambiar lo que el sistema promete y
  > eso lo decide el usuario, construir lo que ya está especificado no. El texto
  > EARS de arriba no se ha tocado.
  >
  > **El resultado —no contestó, aceptó, rechazó— no es adorno del registro**:
  > es lo que hace aplicable la segunda mitad del requisito. Sin él, «se le
  > llamó tres veces» no distingue la entrada que caduca por incomparecencia
  > (AG-066) de la que se cierra porque la paciente dijo que no, y
  > `trg_waitlist_entry_conversion_consented` no tendría cómo comprobar lo
  > único que la base puede comprobar de «no reasignar sin confirmación»: que
  > una conversión sin ninguna aceptación registrada se rechaza.
  >
  > **El contador y el último instante se derivan y sus columnas se fueron.**
  > Dos verdades sobre el mismo hecho sólo pueden discrepar, y la que puede
  > quedarse corta —un intento registrado sin sumar el contador— es la caché.
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
  desde dónde: la IP y el agente del dispositivo, y en la misma fila la cita
  desde la que se abrió (`context_type = 'agenda_entry'`, `context_id`).
  SI la cita nombrada no existe, no es de ese paciente o está en una sede sin
  `agenda:read` para quien llama, ENTONCES el sistema DEBERÁ rechazar la
  apertura con `ACCESS_CONTEXT_NOT_FOUND` sin registrar el acceso ni revelar
  cuál de las tres causas fue.
  > Afinado el 30-09-2026 al construir F-01, con decisión del autor sobre la
  > lectura de «desde dónde». REQ-110 dice «desde qué IP» y `GET /patients/:id`
  > ya la guardaba; lo que faltaba es que la fila **diga que se llegó desde la
  > agenda**, porque «¿quién abrió esta ficha sin tener cita con ella?» es la
  > pregunta de una investigación por acceso indebido y sin el contexto no se
  > puede contestar. Patrón de FHIR `AuditEvent.entity` e IHE BALP: una sola
  > fila que nombra el recurso leído y aquel desde el que se llegó — dos filas
  > relacionadas por la hora se separan en cuanto hay dos pestañas abiertas.
  >
  > **La ruta es la de siempre**, `GET /patients/{id}?agendaEntryId=…`: otra
  > ruta que devolviera la ficha sería una segunda puerta a los mismos datos.
  > **El contexto se comprueba, no se cree**: una fila de bitácora es
  > evidencia, y un parámetro que el cliente pone sin verificar la convertiría
  > en lo que el cliente quisiera decir. Por eso una cita ajena se rechaza en
  > lugar de anotarse, y el rechazo es uno solo para las tres causas: separar
  > «no existe» de «es de otro paciente» respondería «esta cita es de otra
  > persona» a quien prueba identificadores (AG-071).
  >
  > **Lo que cubre y lo que no, a 30-09-2026.** Cubre la ficha abierta desde el
  > detalle de una cita. La lista de espera también lleva a la ficha, y sin
  > contexto; hoy no se alcanza desde la pantalla (`WAITLIST_UI_ENABLED` está
  > apagado desde el 19-08-2026). Al reactivarla, `waitlist_entry` entra como
  > segundo contexto, con la misma comprobación de paciente y sede. Qué cita
  > vale como contexto —una anulada, una de hace un año— y qué cuenta como
  > «una apertura» cuando la pantalla vuelve a pedir la ficha son decisiones
  > del autor: D-059 y D-060 en `DECISIONES-PENDIENTES.md`.
  >
  > **Una fila por petición, no por gesto** (D-060, opción A, 30-09-2026).
  > Cada `GET /patients/{id}?agendaEntryId=…` que devuelve la ficha intenta
  > dejar su fila `READ` con el contexto, también cuando la interfaz vuelve a
  > pedirla sola. Qué peticiones hay y cuáles no, y el caso en que la fila
  > falta aunque la ficha se sirvió, están en la nota de PA-022, que es la
  > misma ruta. Quien investiga lee varias filas seguidas del mismo usuario,
  > ficha y cita como una sesión de lectura. La fila por apertura explícita
  > (opción B) se replantea al construir la consulta de la bitácora (REQ-110).
- **AG-074** — El sistema NO DEBERÁ incluir nombre, documento ni motivo de
  consulta del paciente en ningún registro de log.

## 9. Métricas

- **AG-080** — El sistema DEBERÁ calcular la tasa de inasistencia por
  profesional, por sede y por canal de reserva sobre un rango de fechas.
  > **El rango son dos FECHAS ecuatorianas inclusivas**, no dos instantes:
  > «del 1 al 30 de septiembre» es lo que pregunta una clínica, y con instantes
  > la respuesta dependería de la hora a la que se preguntó. Se resuelven a
  > `[00:00, 24:00)` en `America/Guayaquil` (AG-001), con los mismos dos topes
  > que la disponibilidad — rango invertido y más de 366 días se rechazan por
  > campo.
  >
  > **Los tres desgloses viajan JUNTOS en una respuesta**, con el total. Son
  > tres cortes del mismo conjunto, no tres cuentas: un cliente que preguntara
  > tres veces pintaría tres paneles calculados sobre tres «ahora» distintos, y
  > no sumarían. La tasa se sirve con su NUMERADOR Y SU DENOMINADOR siempre —
  > «50 %» sobre dos citas y sobre cuatrocientas es el mismo número y no el
  > mismo hecho— y es `null`, nunca `0`, cuando no hubo ninguna cita: cero por
  > ciento diría «no faltó nadie» un día que la clínica no abrió.
- **AG-081** — El cálculo de inasistencia DEBERÁ excluir las citas anuladas y
  DEBERÁ contar solo las que alcanzaron su hora de inicio.
  > **El denominador es literalmente eso y ni un filtro más:** las citas
  > (`kind = APPOINTMENT`) cuyo `starts_at` cae en el rango y ya pasó, salvo las
  > `CANCELLED`. El numerador son las `NO_SHOW`. «Ya pasó» se implementa
  > cerrando la ventana en el instante actual, y la respuesta lo declara en
  > `countedUntil`: un periodo pedido hasta fin de mes el día 15 se contó sobre
  > medio mes, y etiquetar la cifra con las fechas que tecleó quien preguntó
  > sería nombrar un periodo sobre el que no se calculó.
  >
  > **Anular incluye el original de una reprogramación**, que AG-050 deja
  > `CANCELLED`: sin esta exclusión «recepción movió la hora» se reportaría como
  > «el paciente no vino».
  >
  > **La cita que llegó a su hora y nadie cerró SIGUE en el denominador**, que
  > es lo que dice el requisito y no lo que conviene. Tiene una consecuencia
  > incómoda: una clínica que deje de marcar inasistencias ve mejorar su propia
  > cifra. Por eso la respuesta publica `pending` —cuántas del denominador no
  > tienen desenlace registrado— en vez de esconderlas. Si la tasa debe medirse
  > solo sobre citas con desenlace es una decisión de negocio: **D-025**.
  >
  > **Los bloqueos no cuentan**, y no es política sino forma de la fila: un
  > `BLOCK` no tiene paciente ni canal (`agenda_entry_patient_coherence`,
  > `agenda_entry_booking_channel_coherence`), así que no hay celda donde
  > caiga. Nadie falta a un quirófano.

- **AG-140** — El cálculo de inasistencia NO DEBERÁ contar como `NO_SHOW` las
  citas en `LEFT_WITHOUT_BEING_SEEN`, DEBERÁ conservarlas en el denominador,
  DEBERÁ excluir del denominador las citas en `ENTERED_IN_ERROR`, y DEBERÁ
  publicar el recuento de `LEFT_WITHOUT_BEING_SEEN` junto a la tasa con los
  mismos tres desgloses de AG-080.
  > **Los dos estados nuevos entran en la métrica de formas opuestas, y ésa es
  > la razón de que sean dos estados y no uno.** Quien se fue sin ser atendido
  > **sí tenía cita y sí llegó a su hora**: sacarlo del denominador rebajaría el
  > total sobre el que se mide y mejoraría la tasa de la clínica por el simple
  > hecho de tener gente cansada de esperar. Se queda dentro, fuera del
  > numerador, y con recuento propio — que es lo que el usuario pidió: **una
  > métrica para poder reducirla**. Una cita `ENTERED_IN_ERROR` no ocurrió; deja
  > el conjunto entero, porque contar en el denominador una cita que nunca
  > existió mide la clínica sobre pacientes imaginarios.
  >
  > **Y `ENTERED_IN_ERROR` tampoco cuenta como anulación**, que es el otro
  > número que hoy sale mal: AG-081 excluye las `CANCELLED` del denominador y no
  > distingue por qué se anularon, así que una tarde de errores de tecleo se lee
  > hoy como una tarde en que la clínica canceló a sus pacientes.
  >
  > **Los tres desgloses viajan juntos** por lo mismo que en AG-080: son cortes
  > del mismo conjunto, y pedirlos por separado los calcularía sobre tres
  > «ahora» distintos.
- **AG-141** — El sistema DEBERÁ calcular la llegada tardía por sede, por
  profesional y por rango de fechas, DEBERÁ servirla con el retraso mediano, el
  recuento de llegadas por encima del umbral de la sede y su denominador, y NO
  DEBERÁ derivarla de ningún dato tecleado.
  > **Es la mitad que convierte AG-118 en algo accionable.** Un retraso por fila
  > sirve en el mostrador; lo que permite cambiar la política de la clínica es
  > saber que los martes por la tarde el retraso mediano es de veinticinco
  > minutos con un profesional concreto.
  >
  > **La mediana y no la media**, por la misma razón por la que AG-080 sirve
  > numerador y denominador: un paciente que llegó tres horas antes de su hora
  > —o tres horas tarde y se le atendió— desplaza una media y no mueve una
  > mediana. Y el denominador viaja siempre: «el 40 % llegó tarde» sobre cinco
  > citas y sobre cuatrocientas es el mismo número y no el mismo hecho.
  >
  > Sale de dos `timestamptz` de la fila (AG-118) y del umbral vigente de la
  > sede (AG-142). No hay ningún dato nuevo que capturar, que es lo que la hace
  > cierta sin depender de que nadie se acuerde de nada.

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
  por defecto a nivel de clínica: antelación mínima y máxima de reserva, **el
  turno de la agenda**, si se permite reservar en el pasado, si el sobrecupo
  está habilitado, el permiso que lo autoriza, el número máximo de sobrecupos
  por profesional y día, los días de retención de citas anuladas, y el número
  máximo de intentos de contacto de la lista de espera.
  > **El turno de la agenda entró el 14-08-2026 con D-021** y es el único de la
  > lista que lee también la DISPONIBILIDAD, no sólo la reserva: la rejilla es
  > lo que la disponibilidad ES (AG-003). Se resuelve por la misma cadena de
  > AG-095 que los demás, con defecto de código de **10 minutos**.
- **AG-095** — SI un parámetro no está definido para la sede, ENTONCES el sistema
  DEBERÁ usar el valor de la clínica, y si tampoco existe, el valor por defecto
  del código.

  Valores de arranque fijados por el usuario el 12 de agosto de 2026 (D-001):

  | Parámetro                        | Defecto       | Por qué                                                               |
  | -------------------------------- | ------------- | --------------------------------------------------------------------- |
  | Antelación mínima de reserva     | **0 min**     | Recepción agenda al paciente que está en el mostrador                 |
  | Antelación máxima                | **180 días**  | Cubre control anual; más allá la agenda del profesional aún no existe |
  | Turno de la agenda (D-021)       | **10 min**    | El único de la banda estándar del que son múltiplos 10, 20 y 30       |
  | Sobrecupos por profesional y día | **2**         | Permite la urgencia real sin que el sobrecupo sea la vía normal       |
  | Retención de anuladas            | **no borrar** | Ver AG-102: no hay purgado                                            |

  > **Dónde vive el tercer escalón, fijado por la implementación de E7.** Los
  > valores por defecto del código para la reserva los declara el **dominio de
  > `agenda`** (`booking-policy.ts`), no `shared/` ni `configuration`. Son la
  > misma cifra que la de D-001 y no la misma afirmación: `configuration`
  > declara con qué **nace** una sede y qué puede guardar un administrador;
  > la agenda, con qué **opera** cuando no hay nada que leer. Una constante
  > compartida ataría dos módulos por un valor que cada uno interpreta distinto,
  > y ningún módulo importa de otro. Que las dos copias no se separen en
  > silencio lo garantiza una prueba de integración que reserva contra una sede
  > sin fila de parámetros y compara el resultado con los defectos que escribió
  > la migración.
  >
  > **El segundo escalón no tiene tabla y no falta.** No existe una fila «de la
  > clínica»: el disparador de
  > `20260813040610_configuration_holidays_and_site_parameters` escribe los
  > valores de la clínica en la fila de cada sede en cuanto la sede existe, así
  > que hoy los dos escalones inferiores coinciden. Cuando exista un nivel de
  > clínica, entra en medio sin tocar a ningún llamador.

- **AG-099** — El sistema DEBERÁ conceder los permisos `settings:read` y
  `settings:manage` al rol administrador en la semilla, y DEBERÁ permitir
  reasignarlos a otros roles desde la aplicación sin desplegar código.
  > D-002. `role_permission` es una tabla y los permisos se resuelven por
  > petición, no dentro del token, para que revocar surta efecto en segundos.
  > Lo que **no** es configurable es qué códigos de permiso existen: eso vive en
  > `permission.catalogue.ts` porque es la enumeración contra la que se valida
  > cada ruta.
  >
  > **Decía `settings:write` y el código declara `settings:manage`** (corregido
  > el 14-08-2026 al implementar E7). No es un cambio de requisito: el permiso
  > es el mismo y el catálogo razona el nombre —las demás parejas de
  > administración son `read`/`manage` (`config:*`, `site:*`, `staff:*`,
  > `catalog:*`), y un verbo distinto en una unión cerrada es una errata
  > esperando a compilar—. Se corrige aquí porque un identificador de código se
  > cita literal, y una spec que nombra un permiso inexistente manda a quien la
  > lee a buscar algo que no está.
- **AG-142** — El sistema DEBERÁ tomar de la configuración de la sede, por la
  cadena de AG-095, el umbral de llegada tardía en minutos y el permiso que
  autoriza admitir a atención una cita cuya llegada lo superó, y NO DEBERÁ
  fijarlos en el código.
  > **La política de la llegada tardía es de la clínica y cambia por sede.** «A
  > partir de cuántos minutos se reubica» y «quién puede saltárselo» son las dos
  > preguntas que el usuario planteó, y ninguna la contesta un agente: son las
  > mismas dos formas que ya tiene el sobrecupo —un número y un permiso, AG-039,
  > AG-100, AG-101— y se administran por el mismo sitio.
  >
  > **El umbral existe desde el 20-08-2026** (migración
  > `20260820052524_clinical_flow_states`):
  > `site_parameter.late_arrival_grace_minutes`, `SMALLINT NOT NULL DEFAULT 15`,
  > con `site_parameter_grace_is_not_negative`. El cero queda admitido, que es
  > lo que permite a una sede desactivar la política sin migración. El
  > identificador se cita literal y este requisito usa ése, no otro.
  >
  > **Falta esquema.** El permiso que lo salta no tiene columna:
  > `late_arrival_override_permission`, hermana de la que la sede ya usa para
  > autorizar el sobrecupo (AG-094, AG-101). Sin ella AG-120 no tiene contra qué
  > comprobar y su rechazo quedaría con el permiso quemado en el código, que es
  > lo que REQ-145 prohíbe.
  >
  > > **[NECESITA ACLARACIÓN]** — **qué permiso** salta el umbral, y si los 15
  > > minutos que escribió la migración son los que la clínica quiere. Un umbral
  > > demasiado corto empuja a recepción a reprogramar a medio mundo y a
  > > saltárselo siempre, con lo que el control deja de existir; uno demasiado
  > > largo no aplica ninguna política. Es decisión de negocio, y el valor de
  > > arranque no la sustituye: lo que hace un defecto es que el sistema arranque,
  > > no que alguien lo haya elegido. **No bloquea E8**: los 15 minutos permiten
  > > construir y probar AG-119 y AG-120 hoy.
- **AG-096** — El sistema DEBERÁ validar todo parámetro al guardarlo y DEBERÁ
  rechazar el guardado con un error por campo; NO DEBERÁ aceptar un valor
  inválido para descubrirlo al reservar.
- **AG-097** — El sistema DEBERÁ registrar quién cambió cada parámetro, cuándo y
  desde qué valor.
  > **Esquema resuelto el 14-08-2026 — `D-017`, opción A revisada.**
  > `access_audit` lleva `before` y `after` (`jsonb`), y `ConfigurationAuditTrail`
  > los escribe en cada mutación de parámetros y de feriados (CF-066). Una sola
  > tabla y un solo mecanismo para todos los módulos: una tabla de versiones por
  > módulo respondería la misma pregunta en un sitio distinto cada vez.
  >
  > **Lo que hace segura esa columna es una lista blanca en la base**, no una
  > convención: `access_audit_payload_only_for_declared_resources` exige que las
  > dos columnas sean nulas salvo que `resource_type` figure en la lista, y hoy
  > la lista es exactamente `'configuration'`. La historia clínica NO está en
  > ella, y añadirla es una decisión sobre datos personales, no un retoque de
  > esquema: esta tabla es append-only y no se purga, así que un dato de
  > paciente que aterrice aquí no se podría corregir ni borrar nunca. Una prueba
  > de integración manda un `INSERT` con `resource_type` clínico y valor
  > anterior, y comprueba que PostgreSQL lo rechaza.
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
| **La inmutabilidad del historial de estados**              | Es la respuesta a «¿por qué salió anulada esta cita?». Un parámetro que la desactive convierte la bitácora en decorado. Vive en dos disparadores de PostgreSQL (`UPDATE`/`DELETE` y `TRUNCATE`) y en el `RESTRICT` de la clave foránea, no en la costumbre del módulo — D-022, ver AG-005                                                                                                                                              |
| **La zona horaria `America/Guayaquil`**                    | Parametrizarla parece flexible y es una trampa: el sistema es de una sola clínica ecuatoriana, y un huso mal configurado cambia `age_days` de un neonato, que es como el RDACAA lo clasifica. Se revisará si algún día hay sedes fuera del país                     |
| **Que toda ruta declare permiso**                          | Cerrado por defecto no admite excepción configurable, o no está cerrado                                                                                                                                                                                             |

> **Esquema resuelto el 13-08-2026.** `holiday` y `site_parameter` existen
> desde la migración `20260813040610_configuration_holidays_and_site_parameters`
> y las administra `configuration` (CF-060 a CF-066). Lo que falta de AG-015,
> AG-016, AG-028, AG-035 y AG-090 a AG-098 ya no es esquema: es que la agenda
> LEA lo que la configuración guarda. El bloqueo se anota aquí como resuelto y
> no se borra porque `pnpm estado` los cuenta leyendo este archivo, y un
> bloqueo que desaparece sin dejar rastro se vuelve a declarar la próxima vez.

---

## Códigos de error nuevos

Entran en `shared/domain/errors/error-catalogue.ts` (regla de ADR-008 §1):

| Código                                 | Estado | Requisito      |
| -------------------------------------- | ------ | -------------- |
| `INVALID_AGENDA_TRANSITION`            | 409    | AG-040         |
| `OUTSIDE_SCHEDULE_RULE`                | 422    | AG-028         |
| `AGENDA_ENTRY_HAS_ENCOUNTER`           | 409    | AG-045, AG-148 |
| `ATTENTION_STILL_IN_PROGRESS`          | 409    | AG-153         |
| `OVERBOOKING_PRACTITIONER_UNAVAILABLE` | 409    | AG-151         |
| `BLOCK_OVERLAPS_APPOINTMENTS`          | 409    | AG-038, AG-152 |
| `BOOKING_IN_THE_PAST`                  | 422    | AG-031         |
| `BOOKING_TOO_SOON`                     | 422    | AG-032         |
| `BOOKING_TOO_FAR`                      | 422    | AG-033         |
| `INVALID_BOOKING_CHANNEL`              | 422    | AG-034         |
| `INVALID_SLOT_DURATION`                | 422    | AG-012         |
| `OVERBOOKING_NOT_ALLOWED`              | 422    | AG-039         |
| `OVERBOOKING_REASON_REQUIRED`          | 422    | AG-035         |
| `OVERBOOKING_LIMIT_REACHED`            | 409    | AG-100         |
| `OVERBOOKING_NOT_AUTHORISED`           | 403    | AG-101         |
| `SELF_AUTHORISATION_DENIED`            | 403    | AG-103         |
| `SLOT_NOT_ALIGNED`                     | 422    | AG-104         |
| `ROOM_NOT_IN_SITE`                     | 422    | AG-105         |
| `BOOKING_RETRY_EXHAUSTED`              | 503    | AG-026         |
| `NO_SHOW_BEFORE_START`                 | 422    | AG-043         |
| `CANCELLATION_REASON_REQUIRED`         | 422    | AG-044         |
| `AGENDA_ENTRY_NOT_FOUND`               | 404    | AG-071         |
| `ACCESS_CONTEXT_NOT_FOUND`             | 404    | AG-073         |
| `WAITLIST_ENTRY_NOT_FOUND`             | 404    | AG-071         |
| `WAITLIST_ENTRY_CLOSED`                | 409    | AG-067         |
| `WAITLIST_ACCEPTANCE_REQUIRED`         | 422    | AG-064         |
| `WAITLIST_PATIENT_MISMATCH`            | 422    | AG-063         |
| `WAITLIST_SLOT_ALREADY_CLAIMED`        | 409    | AG-063         |
| `SLOT_NOT_RELEASED`                    | 422    | AG-061         |
| `RELEASED_SLOT_IN_THE_PAST`            | 422    | AG-061         |
| `ENTERED_IN_ERROR_REASON_REQUIRED`     | 422    | AG-117         |
| `LATE_ARRIVAL_NOT_AUTHORISED`          | 403    | AG-120         |
| `EMERGENCY_QUALIFICATION_REQUIRED`     | 422    | AG-128         |
| `COVERAGE_SKIP_REASON_REQUIRED`        | 422    | AG-131         |

> **Los cuatro de E8, y por qué ninguno reutiliza a un vecino.**
> `ENTERED_IN_ERROR_REASON_REQUIRED` no es `CANCELLATION_REASON_REQUIRED`: son
> dos actos distintos (AG-117) y un cliente que ramificara por el código de
> anulación diría al usuario que está anulando una cita cuando lo que hace es
> retirar una que nunca existió. `LATE_ARRIVAL_NOT_AUTHORISED` es 403 y sigue
> exactamente la forma de `OVERBOOKING_NOT_AUTHORISED`: un permiso que la sede
> configura y que quien llama no tiene. `EMERGENCY_QUALIFICATION_REQUIRED` y
> `COVERAGE_SKIP_REASON_REQUIRED` son 422 por campo, como
> `OVERBOOKING_REASON_REQUIRED`: lo que falta es un dato del formulario y quien
> está en el mostrador tiene que saber cuál.
>
> **No hay código para el intento de teclear un estado de paciente derivado**
> (AG-122), y es deliberado: lo que el requisito prohíbe es que exista la ruta.
> Un código de error diría que la ruta existe y a veces contesta que no.

> `BOOKING_RETRY_EXHAUSTED` lo fijó la implementación de E1: AG-026 nombra el
> estado (503) y la cabecera (`Retry-After`) pero no el código, y sin uno el
> cliente no puede distinguir «reintente» de cualquier otro 503. Sale de la
> categoría reintentable, así que la respuesta lleva `Retry-After`; **no** es un
> conflicto de cupo, que es justo lo que el requisito prohíbe presentar.

> **`RELEASED_SLOT_IN_THE_PAST` es propio y no `BOOKING_IN_THE_PAST`**, aunque
> el hecho sea el mismo —una hora que pasó no se puede ocupar—, porque la
> situación no lo es. Aquí **no se reserva nada**: es un `GET` que nombra una
> entrada liberada, sin `startsAt` que corregir, así que el error por campo de
> AG-031 mandaría a recepción a arreglar una casilla que esta pantalla no
> tiene, y un cliente que ramifica por ese código para «corrija la hora»
> saltaría en una consulta. Y la **condición** es distinta:
> `BOOKING_IN_THE_PAST` obedece a `allow_past_booking`, el parámetro con el que
> una sede REGISTRA una atención ya ocurrida, y un registro retroactivo no pasa
> nunca por la lista de espera —proponer es llamar a alguien para que venga—,
> así que este rechazo no depende de ningún parámetro. Es 422 como su vecino
> `SLOT_NOT_RELEASED`, con el que comparte ruta y salida: los dos dicen «esa
> entrada no sirve como cupo a repartir», y un 409 sugeriría refrescar y
> reintentar, que es justo lo contrario de lo que hay que hacer con una hora
> que no vuelve.

> **Los seis de E5 los fijó la implementación**, por la misma regla que
> `BOOKING_RETRY_EXHAUSTED`: AG-060 a AG-067 mandan los rechazos y no nombran
> códigos, y sin uno el cliente no distingue «la inscripción ya está cerrada»
> de cualquier otro 409. Cuatro de ellos traducen lo que rechaza la BASE —los
> dos disparadores de la migración y el índice único parcial—, y esa traducción
> vive en `prisma-waitlist.repository.ts` y no en `agenda.constraints.ts`
> porque **los disparadores llegan por SQLSTATE y sin nombre de constraint**:
> PL/pgSQL no emite la cláusula «violates check constraint "…"» que
> `database-problem.ts` lee, así que los tres rechazos distintos llegarían como
> un `CHECK_FAILED` genérico. Se distinguen por la frase que levanta cada uno,
> exactamente como `patients` resolvió los tres rechazos de
> `trg_patient_merge_not_chained`. `waitlist_entry_one_per_converted_entry`
> tampoco puede ir en el registro: Prisma resuelve la violación de unicidad
> ella misma (P2002) y devuelve la COLUMNA, no el nombre del índice.

> `NO_SHOW_BEFORE_START` y `AGENDA_ENTRY_NOT_FOUND` los fijó la implementación
> de E2, por la misma regla que `BOOKING_RETRY_EXHAUSTED`: AG-043 manda el
> rechazo sin nombrar código, y sin uno el cliente no distingue «aún es
> temprano para marcarla» de cualquier otro 422. El 404 responde igual para la
> entrada que no existe y para la de otra sede — distinguirlas confirmaría
> citas ajenas a quien prueba identificadores, el mismo razonamiento de
> AG-105.

> `OVERBOOKING_REASON_REQUIRED` lo fijó la implementación de E4, por la misma
> regla y por el mismo motivo que `CANCELLATION_REASON_REQUIRED`: AG-035 dice
> «DEBERÁ exigir un motivo» y no nombra código, y un DEBERÁ que sólo hace
> cumplir el DTO no es una garantía —la exigencia vive en el servicio, donde
> ningún llamador la rodea, y la base la repite en
> `agenda_entry_overbooking_coherence`—. Es 422 y por campo: lo que falta es un
> dato del formulario, y quien está en el mostrador tiene que saber cuál.

> `CANCELLATION_REASON_REQUIRED` salió de la revisión adversarial de E2 (P2-3):
> el DTO ya exigía el motivo por HTTP, pero E3 anulará la cita original desde
> DENTRO del servicio, y un DEBERÁ que solo la capa de transporte hace cumplir
> no es una garantía. La regla vive ahora en el servicio, donde ningún llamador
> la rodea.

Estos **no** entran, porque los produce el mapeo de errores de PostgreSQL en
`shared/http/database-problem.ts`, que tiene su propia tabla:

| Código                     | Estado | Constraint                               | Requisito |
| -------------------------- | ------ | ---------------------------------------- | --------- |
| `PRACTITIONER_SLOT_TAKEN`  | 409    | `agenda_entry_no_practitioner_overlap`   | AG-023    |
| `ROOM_SLOT_TAKEN`          | 409    | `agenda_entry_no_room_overlap`           | AG-024    |
| `PATIENT_DOUBLE_BOOKED`    | 409    | `agenda_entry_no_patient_overlap`        | AG-030    |
| `INVALID_STATUS_FOR_KIND`  | 422    | `agenda_entry_kind_status_coherence`     | AG-046    |
| `BOOKING_CHANNEL_REQUIRED` | 422    | `agenda_entry_booking_channel_coherence` | AG-029    |
| `INVALID_PREFERRED_RANGE`  | 422    | `waitlist_entry_preferred_range_valid`   | AG-060    |
| `WAITLIST_CONVERSION_INCOMPLETE` | 422 | `waitlist_entry_conversion_complete`  | AG-063    |

`PATIENT_DOUBLE_BOOKED` estaba arriba hasta que AG-030 pasó a ser un `EXCLUDE`.
Se mueve por la regla de esta misma sección: un código que nace de un constraint
no lo declara el catálogo de dominio, o habría dos sitios donde cambiarlo y solo
uno se acordaría.

## Rutas

Todas bajo `/api/v1`. **Toda ruta declara su permiso y su alcance de sede**
(AG-070, AG-071); `param:siteId` es el único que el guard puede comprobar por sí
solo, porque los guards corren antes que los pipes y en ese momento el cuerpo
aún no está validado.

| Método   | Ruta                                                          | Permiso          | Alcance         | Requisitos                       |
| -------- | ------------------------------------------------------------- | ---------------- | --------------- | -------------------------------- |
| `GET`    | `/agenda/sites`                                                | `agenda:read`    | `query`         | AG-107                           |
| `GET`    | `/agenda/metrics/no-show`                                      | `agenda:read`    | `query`         | AG-080, AG-081                   |
| `GET`    | `/agenda/sites/{siteId}/practitioners`                         | `agenda:read`    | `param:siteId`  | AG-108, AG-111                   |
| `GET`    | `/agenda/sites/{siteId}/specialties/{specialtyId}/service-types`| `agenda:read`   | `param:siteId`  | AG-112                           |
| `GET`    | `/agenda/sites/{siteId}/entries`                               | `agenda:read`    | `param:siteId`  | AG-017, AG-018                   |
| `GET`    | `/agenda/sites/{siteId}/availability`                          | `agenda:read`    | `param:siteId`  | AG-003, AG-010 a AG-016, AG-093  |
| `GET`    | `/agenda/sites/{siteId}/duration`                              | `agenda:read`    | `param:siteId`  | SP-023, SP-028                   |
| `POST`   | `/agenda/sites/{siteId}/entries`                               | `agenda:write`   | `param:siteId`  | AG-020 a AG-035, AG-110          |
| `POST`   | `/agenda/sites/{siteId}/entries/{entryId}/status`               | `agenda:write`   | `param:siteId`  | AG-040 a AG-046, AG-116, AG-117, AG-120 |
| `POST`   | `/agenda/sites/{siteId}/entries/{entryId}/check-in`             | `agenda:write`   | `param:siteId`  | AG-041, AG-118, AG-119, AG-128 a AG-132 |
| `GET`    | `/agenda/metrics/late-arrival`                                  | `agenda:read`    | `query`         | AG-141                           |
| `GET`    | `/agenda/sites/{siteId}/board`                                  | `agenda:read`    | `param:siteId`  | AG-121, AG-123 a AG-135, AG-138, AG-139 |
| `GET`    | `/agenda/sites/{siteId}/board/public`                           | `agenda:board:public` | `param:siteId` | AG-136, AG-137, AG-139         |
| `POST`   | `/agenda/sites/{siteId}/entries/{entryId}/reschedule`           | `agenda:write`   | `param:siteId`  | AG-050 a AG-052, AG-115          |
| `POST`   | `/agenda/sites/{siteId}/blocks`                                | `agenda:write`   | `param:siteId`  | AG-037, AG-038                   |
| `DELETE` | `/agenda/sites/{siteId}/blocks/{entryId}`                       | `agenda:write`   | `param:siteId`  | AG-114                           |
| `GET`    | `/agenda/sites/{siteId}/waitlist`                              | `agenda:read`    | `param:siteId`  | AG-062, AG-065 a AG-067          |
| `POST`   | `/agenda/sites/{siteId}/waitlist`                              | `agenda:write`   | `param:siteId`  | AG-060                           |
| `GET`    | `/agenda/sites/{siteId}/waitlist/candidates/{releasedEntryId}`  | `agenda:read`    | `param:siteId`  | AG-061, AG-062, AG-065 a AG-067  |
| `POST`   | `/agenda/sites/{siteId}/waitlist/{entryId}/contact-attempts`    | `agenda:write`   | `param:siteId`  | AG-064, AG-066                   |
| `POST`   | `/agenda/sites/{siteId}/waitlist/{entryId}/conversion`          | `agenda:write`   | `param:siteId`  | AG-063, AG-064                   |

**El registro de llegada sale de `/status` y tiene ruta propia**, al revés de lo
que hizo E2. No es simetría con `blocks`: `CHECKED_IN` dejó de ser una transición
como las demás en cuanto lleva consigo la calificación de emergencia que la ley
obliga a exigir (AG-128), el motivo de la cobertura omitida (AG-131) y una
advertencia en la respuesta (AG-119). Meterlo en la ruta genérica de transiciones
obligaría a que su DTO llevara campos que ninguna otra transición usa y a que la
exigencia del art. 10 fuera condicional al valor de un campo — que es exactamente
la forma en que una garantía deja de serlo. `/status` sigue admitiendo el resto,
`CHECKED_IN` incluido en su forma actual hasta que E8 cierre.

**El tablero público es la única ruta del módulo que no lleva `agenda:read`**, y
es AG-136 en la tabla: la pantalla de la sala de espera se autentica con un rol
que sólo tiene `agenda:board:public`, así que no puede pedir la proyección de
personal aunque alguien le cambie la URL. Un `?public=true` sobre la ruta de
siempre habría sido una línea menos de código y un interruptor que se queda mal
puesto.

**La lista de espera usa `agenda:read` / `agenda:write` y no un permiso propio.**
Inscribir a quien se quedó sin cupo es el mismo acto que reservarlo, lo hace la
misma persona en la misma conversación, e inventar `waitlist:write` sería un
permiso que ningún rol lleva y una pantalla a la que nadie llega — el mismo
argumento que ya cerró `POST blocks`.

**No hay ruta que BORRE una inscripción ni que la REABRA**, y esa ausencia es
AG-067 en la tabla de rutas: una entrada cerrada volvería a la cola con su
antigüedad original, por delante de todos los que se inscribieron después.
`trg_waitlist_entry_closure_final` lo garantiza también en la base. Quien sigue
esperando se inscribe de nuevo, y la entrada nueva cuenta desde hoy.

**`POST …/conversion` enlaza una cita YA RESERVADA por la ruta de siempre.**
AG-063 dice qué le pasa a la ENTRADA y no cómo nace la cita; reservarla aquí
sería un segundo camino a través de AG-020 a AG-034 —la ventana de la sede, el
encaje en la rejilla, la ficha fusionada, los tres `EXCLUDE`— que ya tiene
exactamente una implementación.

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
| AG-115                                          | Unitario con doble de repositorio + integración contra PostgreSQL real: la entrada nueva nace con el profesional pedido, el original queda liberado, y un destino ocupado no libera nada (AG-052) |
| AG-070 a AG-074                                 | Seguridad dirigida                                         |
| AG-023, AG-024, AG-027, AG-028, AG-030, AG-040  | Contrato HTTP (código, estado, mensaje)                    |
| AG-031 a AG-034, AG-039, AG-100, AG-101, AG-103 | Contrato HTTP + unitario de dominio                        |
| AG-035, AG-036, AG-101, AG-103                  | Integración contra PostgreSQL real: la separación de personas y la constancia las garantiza `agenda_entry_overbooking_coherence` |
| AG-037, AG-038                                  | Integración contra PostgreSQL real: AG-037 ES el `EXCLUDE`, y AG-038 enumera filas |
| AG-114                                          | Unitario de dominio + integración contra PostgreSQL real: liberar libera de verdad cuando el mismo intervalo se vuelve a reservar, y la fila de historial existe |
| AG-001, AG-015, AG-017, AG-100                  | Unitario con huso alterado, como en `encounter_freeze_age` |
| AG-018, AG-046, AG-066, AG-067                  | Integración contra PostgreSQL real                         |
| AG-060, AG-063, AG-064, AG-065                  | Integración contra PostgreSQL real + contrato HTTP: el rastro es append-only y los dos disparadores llegan por SQLSTATE, así que sólo la base demuestra que existen y sólo el contrato demuestra que se traducen |
| AG-061, AG-062                                  | Unitario de dominio (el orden y la compatibilidad) + integración: la prioridad se deriva de los periodos ALMACENADOS, incluidos los de las fichas absorbidas (PA-055), y eso no lo demuestra ningún doble |
| AG-012, AG-104, AG-105                          | Unitario de dominio + contrato HTTP                        |
| AG-094 (turno de la agenda, D-021)              | Unitario de dominio + integración: la rejilla derivada es la de la sede |
| AG-106                                          | Unitario de dominio + integración con dos reglas solapadas |
| AG-096, AG-097, AG-098, AG-102                  | Integración + contrato HTTP por campo                      |
| AG-110                                          | Unitario de dominio + integración contra PostgreSQL real   |
| AG-111, AG-112                                  | Contrato HTTP con una sesión de `RECEPCION` de verdad: el defecto era de permiso, y un doble con los grants puestos a mano no lo habría visto |
| AG-116, AG-117                                  | Unitario de dominio (la máquina de estados) + integración contra PostgreSQL real: el valor nuevo del enum, el `CHECK` de AG-046 y el cupo que queda liberado de verdad |
| AG-118, AG-141                                  | Unitario con huso alterado, como en `encounter_freeze_age`: una llegada a las 21:00 no puede cambiar de día |
| AG-119, AG-120                                  | Contrato HTTP + unitario de dominio, más un caso con la calificación de emergencia afirmativa que comprueba que el umbral **no** se aplica |
| AG-121 a AG-127                                 | Unitario de dominio (la derivación) + integración contra PostgreSQL real: el rastro es append-only y AG-122 se comprueba con la prueba de rutas de AG-070, que falla si aparece una que fije un estado derivado |
| AG-128, AG-129, AG-131, AG-132                  | Integración contra PostgreSQL real + contrato HTTP: la constancia la garantizan un `CHECK` y un disparador, y la exigencia se comprueba mandando un registro de llegada sin calificación |
| AG-130                                          | Seguridad dirigida: la calificación se hace con el permiso del registro de llegada y con ningún otro |
| AG-133 a AG-135, AG-138                         | Contrato HTTP + unitario de dominio: el orden por hora, el tiempo calculado, y que dos roles distintos reciban conjuntos de campos distintos |
| AG-136, AG-137                                  | Seguridad dirigida + contrato HTTP: una sesión con `agenda:board:public` y nada más no alcanza la proyección de personal, y la fila que recibe no lleva ninguno de los campos prohibidos |
| AG-139, AG-140                                  | Integración contra PostgreSQL real: una consulta del tablero deja **una** fila de bitácora y no una por cita (SC-004), y la tasa no se mueve cuando una cita pasa a `LEFT_WITHOUT_BEING_SEEN` |
| AG-142                                          | Integración: cambiar el umbral de una sede cambia la advertencia siguiente y no toca las llegadas ya registradas (AG-098) |
| AG-146 a AG-149                                 | Integración contra PostgreSQL real con control positivo: la cita y la atención se mueven en la misma transacción y la fila de historial existe; una prueba reproduce la captura del autor                        |
| AG-150                                          | Contrato HTTP + prueba de interfaz: el menú de una cita con atención viva no ofrece lo que AG-045 rechaza                                                                                                        |
| AG-151                                          | Integración contra PostgreSQL real: los cuatro casos rechazados y, como control positivo, el sobrecupo encima de una cita de la misma sede admitido                                                              |

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

**Decisiones del agente que E8 y E9 hacen cumplir**, registradas en
`../clinica-docs/DECISIONES-TOMADAS-POR-EL-AGENTE.md`:

| #       | Decisión                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------- |
| D-A-002 | La calificación de emergencia al llegar **se construye siempre**, y la cobertura es saltable    |
| D-A-008 | El estado del paciente es consecuencia de documentar, no una casilla: sólo «llegó» se teclea    |
| D-A-009 | «Se fue sin ser atendido» es estado propio; la llegada tardía **no** es un estado, es una resta |

**Abierta desde el 20-08-2026**, y las dos son de negocio o legales: el valor de
arranque del umbral de llegada tardía y qué permiso lo salta (AG-142), y con qué
se identifica al paciente en la pantalla que mira la sala de espera —turno, o
nombre e inicial— una vez verificado qué exige la **LOPDP**, que es lo vinculante
en Ecuador y no la guía estadounidense de la que sale el razonamiento (AG-137).
**Ninguna de las dos bloquea E8 ni E9**: la primera tiene forma de parámetro y la
segunda es una de dos proyecciones que hay que construir igual.

**Abierta desde el 19-08-2026: D-040**, al construir el esquema de E5. Son dos
números que la clínica tiene que elegir y que ningún agente decide: cuántos
intentos de contacto agotan una entrada (AG-066, AG-094 — la columna existe y
nace en 3) y qué le pasa a la entrada cuando el paciente contesta y RECHAZA el
cupo, que es una pregunta que sólo se puede formular desde que el rastro
distingue «no contestó» de «dijo que no». **No bloquea E5**: los dos tienen
valor de arranque y son cambiables sin migración.

Lo que sigue son las consecuencias ya decididas, que sí siguen siendo trabajo:

1. **Dos tandas de migración** (D-006). Tanda 1, sin dependencias y prerrequisito
   de E1 y E7: tabla `holiday` y parámetros por sede (§10) · `EXCLUDE` por
   paciente (AG-030) · `CHECK` de coherencia `kind`/`status` (AG-046) · canal de
   reserva como enum (AG-034). Tanda 2, cuando D-005 esté resuelta: campo de
   autorización de sobrecupo (AG-035) y autorreferencia de reprogramación
   (AG-051). **La autorreferencia se adelantó con E3** —no dependía de D-005—
   y entró el 14-08-2026 en `agenda_reschedule_link`; de la tanda 2 queda el
   campo de autorización del sobrecupo, que sí depende de esa decisión.
2. ~~**El historial de intentos de contacto (AG-064) se rebaja, no se migra.**~~
   **Superado el 19-08-2026, al abrir E5** (`agenda_waitlist_contact_trail`).
   D-006 decidió conservar el contador y el último instante «hasta que al usar
   la lista de espera de verdad haga falta el historial completo»; ese momento
   es ahora, y el motivo estaba escrito desde el principio en el propio AG-064.
   El contador y el último instante ya no existen como columnas: se derivan de
   `waitlist_contact_attempt`. Ver el recuadro de AG-064.
3. **Dos códigos de permiso nuevos** en `permission.catalogue.ts`:
   `settings:read` y `settings:manage` (AG-099). Es cambio de código porque el
   catálogo es la enumeración contra la que se valida cada ruta; a quién se
   conceden es configurable.
