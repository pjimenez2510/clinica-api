/**
 * Every business error code the API can return, in one place.
 *
 * WHY A FROZEN LIST. The README promises that `code` is "stable and never
 * translated: the contract consumed by clients, logs and alerts". Until this
 * existed, those codes were spread across ten files in three layers, nothing
 * prevented two classes declaring the same one — and two of them already did —
 * and there was nowhere to read what the API could answer. A public contract
 * that cannot be enumerated is not a contract.
 *
 * The list is maintained by hand ON PURPOSE. `error-catalogue.spec.ts` reads
 * the source and fails if the two disagree, so renaming a code becomes a line
 * in a diff that somebody reviews instead of a silent change that breaks an
 * integrator's alert at 3am.
 *
 * NOT included: codes produced by the HTTP layer from a status
 * (`NOT_FOUND`, `PAYLOAD_TOO_LARGE`, …) or by the database mapping
 * (`PRACTITIONER_SLOT_TAKEN`, …). Those have their own tables, which are
 * themselves the enumeration.
 */
export const DOMAIN_ERROR_CODES = [
  // AG-073. La ficha se pidió DESDE una cita que no la respalda: no existe, es
  // de otro paciente o de una sede sin `agenda:read`. 404 y un solo mensaje
  // para las tres, como `AGENDA_ENTRY_NOT_FOUND`. Se rechaza en vez de anotar
  // sin contexto: el contexto de una fila de bitácora es evidencia.
  'ACCESS_CONTEXT_NOT_FOUND',
  'ACCOUNT_INACTIVE',
  // Agenda, E2. Los cuatro son la máquina de estados de la cita (SPEC §5) y
  // responden cosas distintas a propósito: la transición no está en la tabla
  // (409, el estado actual la rechaza), la cita ya tiene atención registrada
  // (409, AG-045), la inasistencia se pidió antes de la hora de inicio (422,
  // AG-043 — código fijado por la implementación, la spec no lo nombra), y la
  // entrada no existe o es de otra sede (404, un solo mensaje para ambas:
  // distinguirlas confirmaría citas ajenas a quien adivina identificadores).
  'AGENDA_ENTRY_HAS_ENCOUNTER',
  // AG-153 (D-099 §3): «Marcar atendida» con la atención aún en curso.
  'ATTENTION_STILL_IN_PROGRESS',
  'AGENDA_ENTRY_NOT_FOUND',
  'INVALID_AGENDA_TRANSITION',
  'NO_SHOW_BEFORE_START',
  // Agenda, E8 (AG-116, AG-117, AG-122, AG-125, AG-127, AG-128). Los tres
  // desenlaces que la máquina de estados no tenía, y son tres códigos y no uno
  // porque lo que hay que hacer difiere:
  //
  //   * `ENTERED_IN_ERROR_REASON_REQUIRED` (422, por campo) — retractar una
  //     cita que nunca debió existir exige motivo. NO comparte código con
  //     `CANCELLATION_REASON_REQUIRED`: separar los dos actos es justo para lo
  //     que existe el estado, y un cliente que ramificara por el código común
  //     pediría «el motivo de la anulación» de una cita que nadie anula.
  //   * `EMERGENCY_ASSESSMENT_REQUIRED` (422, por campo) — la Ley 77 art. 10
  //     obliga a calificar el estado de emergencia AL ARRIBO, y su art. 13 lo
  //     respalda con prisión. Un valor por defecto no prueba que alguien
  //     calificara: prueba que nadie lo tocó.
  //   * `SUBJECT_STATUS_NOT_DERIVABLE` (409) — el eje del paciente no puede
  //     moverse en esa cita: aún no ha llegado (AG-127), ya salió (AG-125) o
  //     es un bloqueo (AG-021). Uno solo para los tres porque en los tres lo
  //     que hay que hacer es lo mismo: nada.
  'EMERGENCY_ASSESSMENT_REQUIRED',
  'ENTERED_IN_ERROR_REASON_REQUIRED',
  'SUBJECT_STATUS_NOT_DERIVABLE',
  // Agenda, AG-026: PostgreSQL abortó la reserva por serialización y se
  // agotaron los reintentos. NO es un conflicto de cupo: un `40001` no dice
  // nada del horario, así que responder «ese cupo está ocupado» movería la
  // cita de un paciente sin motivo. Sale como 503 con `Retry-After`.
  'BOOKING_RETRY_EXHAUSTED',
  // Agenda, E7 (AG-031 a AG-033): la ventana de reserva de la sede. Los tres
  // son 422 y son tres códigos y no uno porque lo que hay que corregir es
  // distinto en cada caso: la hora ya pasó y no hay hora que valga sin cambiar
  // el día, falta esperar a que se cumpla la antelación mínima —y el error
  // dice desde cuándo—, o la fecha excede lo que la sede publica —y el error
  // dice hasta cuándo—. Un único `BOOKING_OUT_OF_WINDOW` obligaría al cliente
  // a leer el texto en español para saber cuál de las tres.
  'BOOKING_IN_THE_PAST',
  'BOOKING_TOO_FAR',
  'BOOKING_TOO_SOON',
  // Agenda. Los tres son 422 y dicen cosas distintas a propósito: el canal es
  // un valor que el cliente escribió mal, la duración es correcta pero no
  // encaja en los cupos del profesional, y el intervalo cae fuera de toda
  // regla vigente. Un solo código para los tres obligaría a leer el texto para
  // saber qué corregir.
  'INVALID_BOOKING_CHANNEL',
  // Agenda, E4 (AG-035 a AG-039, AG-100, AG-101, AG-103): el sobrecupo y los
  // bloqueos, que son las dos vías DOCUMENTADAS de romper la rejilla (D-005).
  //
  // Son cinco códigos y no uno porque lo que hay que hacer es distinto en cada
  // caso, y quien lo lee está en el mostrador con el paciente delante:
  //
  //   * `OVERBOOKING_NOT_ALLOWED` (422) — esta sede no admite sobrecupos. No
  //     hay nada que corregir en el formulario: se cambia un parámetro de sede
  //     o no se hace.
  //   * `OVERBOOKING_REASON_REQUIRED` (422) — falta el motivo. Es un campo del
  //     formulario, y por eso viaja por campo (AG-035).
  //   * `OVERBOOKING_LIMIT_REACHED` (409) — el profesional ya agotó el tope
  //     del DÍA (D-001: dos). Es 409 y no 422 porque lo enviado es correcto:
  //     lo que lo impide es el estado de la agenda, y mañana el mismo cuerpo
  //     se aceptaría.
  //   * `OVERBOOKING_NOT_AUTHORISED` (403) — quien se indicó como autorizador
  //     no tiene el permiso que la sede exige (AG-101).
  //   * `SELF_AUTHORISATION_DENIED` (403) — quien reserva se puso a sí mismo
  //     como autorizador (AG-103). Distinto del anterior a propósito: ahí
  //     falta un permiso, aquí sobra la misma persona en los dos papeles, y la
  //     salida es pedírselo a otra — el mensaje lo dice.
  //
  // `BLOCK_OVERLAPS_APPOINTMENTS` (409) es del bloqueo: hay citas dentro del
  // intervalo, y el error las ENUMERA (AG-038) con identificador y horas, sin
  // nombre ni motivo (AG-074, SC-006).
  'BLOCK_OVERLAPS_APPOINTMENTS',
  'OVERBOOKING_LIMIT_REACHED',
  'OVERBOOKING_NOT_ALLOWED',
  'OVERBOOKING_NOT_AUTHORISED',
  'OVERBOOKING_PRACTITIONER_UNAVAILABLE',
  'OVERBOOKING_REASON_REQUIRED',
  'SELF_AUTHORISATION_DENIED',
  // Agenda, E5 (AG-060 a AG-067): la lista de espera, que reparte un recurso
  // escaso —el cupo que otro paciente acaba de liberar— y por eso tiene que
  // poder explicar a quién se le ofreció y por qué.
  //
  //   * `WAITLIST_ENTRY_NOT_FOUND` (404) — no existe, o es de otra sede. Un
  //     solo mensaje para las dos, como `AGENDA_ENTRY_NOT_FOUND`: separarlas
  //     confirmaría quién espera en sedes ajenas a quien prueba identificadores.
  //   * `WAITLIST_ENTRY_CLOSED` (409) — ya está `SCHEDULED`, `EXPIRED` o
  //     `CANCELLED` (AG-067). Es 409 y no 422 porque lo enviado es correcto y
  //     lo que lo impide es el estado; la salida es inscribir de nuevo, y la
  //     entrada nueva empieza a contar antigüedad desde hoy.
  //   * `WAITLIST_ACCEPTANCE_REQUIRED` (422) — se intentó convertir sin que
  //     conste una aceptación. Es la segunda mitad de AG-064 y la garantiza
  //     `trg_waitlist_entry_conversion_consented`: el código sólo convierte su
  //     `CHECK_FAILED` en una frase sobre la que se puede actuar.
  //   * `WAITLIST_PATIENT_MISMATCH` (422) — la cita enlazada es de otra ficha.
  //     Sin identificador ni nombre en el mensaje (AG-074): quien está en el
  //     mostrador puede no tener acceso a esa otra cita.
  //   * `SLOT_NOT_RELEASED` (422) — se pidieron candidatos sobre una entrada
  //     que sigue ocupando calendario. Es la precondición literal de AG-061,
  //     hecha cumplir en vez de supuesta.
  //   * `RELEASED_SLOT_IN_THE_PAST` (422) — el cupo se liberó, pero su hora ya
  //     pasó. NO es `BOOKING_IN_THE_PAST`: aquí no se reserva nada —es un
  //     `GET` sin `startsAt` que corregir—, y aquel obedece a
  //     `allow_past_booking`, que existe para REGISTRAR una atención ya
  //     ocurrida; proponer candidatos es llamar a alguien para que venga, y
  //     ningún parámetro hace asistible una hora que pasó. Ofrecerla gastaba
  //     una llamada real y uno de los intentos de la entrada (AG-066), que es
  //     append-only.
  //   * `WAITLIST_SLOT_ALREADY_CLAIMED` (409) — otra entrada se llevó esa cita
  //     primero. Es la carrera que E5 existe para arbitrar: dos recepcionistas
  //     repartiendo el mismo cupo liberado. Lo impide
  //     `waitlist_entry_one_per_converted_entry`, un índice único PARCIAL que
  //     Prisma resuelve él mismo (P2002) devolviendo la COLUMNA y no el nombre
  //     del índice, así que el adaptador lo traduce por ahí.
  'RELEASED_SLOT_IN_THE_PAST',
  'SLOT_NOT_RELEASED',
  'WAITLIST_ACCEPTANCE_REQUIRED',
  'WAITLIST_ENTRY_CLOSED',
  'WAITLIST_ENTRY_NOT_FOUND',
  'WAITLIST_PATIENT_MISMATCH',
  'WAITLIST_SLOT_ALREADY_CLAIMED',
  'INVALID_CEDULA',
  'INVALID_CREDENTIALS',
  'INVALID_MFA_CODE',
  'INVALID_REFRESH_TOKEN',
  // OR-008. El RUC no supera la validación del SRI. Vive en el value object
  // `Ruc` de `shared/domain` y no en `organization`, porque `billing` valida
  // el mismo número para imprimirlo en cada comprobante (REQ-085) y un módulo
  // no importa a otro. Es 422: el dato enviado es incorrecto, no falta.
  'INVALID_RUC',
  'INVALID_SLOT_DURATION',
  'INVALID_TOKEN',
  'INVALID_TOTP_CODE',
  'MFA_ALREADY_ENROLLED',
  // AU-037. Confirmar un cambio de segundo factor que ya no está a medias: o
  // nadie lo empezó, o se empezó otro y el secreto pendiente es distinto. Los
  // dos casos se responden igual porque para quien está delante son el mismo
  // hecho y tienen la misma salida: volver a empezar.
  'MFA_CHANGE_NOT_STARTED',
  'MFA_NOT_ENROLLED',
  'MFA_REQUIRED',
  'MISSING_REFRESH_TOKEN',
  // Catálogos clínicos. Las tres respuestas negativas son distintas a
  // propósito: «no existe» es un error de tecleo, «no vigente» es una historia
  // antigua perfectamente válida, y «no seleccionable» es un capítulo que hay
  // que concretar. Un 404 para las tres haría que la de en medio pareciera
  // corrupción de datos.
  'CANCELLATION_REASON_REQUIRED',
  'CATALOG_CONCEPT_NOT_FOUND',
  'CATALOG_CONCEPT_NOT_IN_FORCE',
  'CATALOG_CONCEPT_NOT_SELECTABLE',
  'MISSING_TOKEN',
  // Agenda: el intervalo no lo cubre ninguna regla de horario vigente. La vía
  // documentada para saltárselo es el sobrecupo, que deja constancia por cita.
  'OUTSIDE_SCHEDULE_RULE',
  // Registro de pacientes. `PATIENT_MERGED` no es un 404: la historia existió y
  // documentos ya impresos siguen citando su número, así que el cliente
  // necesita saber a dónde se movió.
  'PATIENT_IDENTIFIER_TAKEN',
  'PATIENT_MERGED',
  'PATIENT_NOT_FOUND',
  // Fusión de duplicados (P4: PA-043 a PA-049, REQ-010).
  //
  // Son cinco y no uno porque lo que hay que hacer es distinto en cada caso, y
  // quien lo lee está en admisión con dos fichas de la misma persona delante:
  //
  //   * `MERGE_REASON_REQUIRED` (422) — falta el motivo, al fusionar o al
  //     deshacer. Viaja POR CAMPO. Se exige EN EL SERVICIO y no sólo en el
  //     DTO, por lo mismo que `CANCELLATION_REASON_REQUIRED`: un `DEBERÁ` que
  //     sólo hace cumplir la capa de transporte deja de cumplirse el día que
  //     otro caso de uso llame por dentro (PA-044, PA-047).
  //   * `MERGE_INTO_SELF` (422) — origen y destino son la misma ficha
  //     (PA-046). Una ficha fusionada consigo misma rechazaría toda operación
  //     remitiendo a sí misma: nadie podría abrirla ni deshacerla.
  //   * `PATIENT_ALREADY_MERGED` (409) — la fusión encadenaría (PA-046): el
  //     DESTINO ya está fusionado, o el ORIGEN ya absorbió otras fichas. Es
  //     409 y no 422 porque lo enviado es correcto y lo que lo impide es el
  //     estado del registro. Lo arbitra `trg_patient_merge_not_chained`, que
  //     además bloquea la ficha destino para que dos fusiones simultáneas no
  //     construyan entre las dos una cadena que ningún constraint vería.
  //   * `MERGE_UNDO_CONFLICT` (409) — al deshacer, el documento que la ficha
  //     absorbida recupera ya lo tiene otra ficha activa (PA-048). NO PUEDE
  //     SALIR DEL MAPA DE CONSTRAINTS: PostgreSQL rechaza por
  //     `patient_identifier_active_unique`, el MISMO índice que un alta
  //     duplicada, y el mapa no puede distinguir las dos operaciones. Sólo
  //     quien pidió el deshacer sabe que lo era, así que la traducción la hace
  //     el servicio. El mensaje NOMBRA el conflicto —qué clase de documento y
  //     qué historia lo tiene ahora— y nunca el valor del documento ni el
  //     nombre de nadie (PA-025, REQ-116).
  //   * `MERGE_NOT_FOUND` (404) — se pidió deshacer sobre una ficha que no
  //     está fusionada, o cuya fusión ya se deshizo. NO es `PATIENT_NOT_FOUND`:
  //     el paciente existe y responder «no se encontró el paciente» mandaría a
  //     admisión a buscar una ficha que tiene delante. Es el hermano de
  //     `AGENDA_ENTRY_NOT_FOUND`: lo que no existe es el SUCESO, no la persona.
  'MERGE_INTO_SELF',
  'MERGE_NOT_FOUND',
  'MERGE_REASON_REQUIRED',
  'MERGE_UNDO_CONFLICT',
  'PATIENT_ALREADY_MERGED',
  // PA-027, 17-08-2026. La ficha declara nacionalidad o pueblo indígena sin
  // autoidentificarse como «Indígena». Es 422 y viaja POR CAMPO señalando
  // `nationalityConceptId`, que es el que el formulario del RDACAA activa sólo
  // en ese caso. NO es un `CATALOG_CONCEPT_*`: el concepto enviado existe, es
  // del catálogo correcto y está vigente — lo que no encaja es con el OTRO
  // campo de la ficha, y lo que hay que hacer es distinto (cambiar la etnia o
  // vaciar la nacionalidad). Y no puede ser un `CHECK`: qué fila de `ETHNICITY`
  // es «Indígena» está en otra tabla.
  'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
  // PA-056, PA-057, PA-059, 19-08-2026 (D-039). Las tres condiciones que el
  // instructivo oficial del RDACAA 2.0 escribe sobre las columnas 7, 12 y 14, y
  // que este sistema no comprobaba. Son 422 y viajan POR CAMPO, señalando en
  // cada caso el campo CONDICIONADO —el que el formulario activa— y no el que
  // lo activa, porque es su valor el que tiene que ceder:
  //
  //   * `PEOPLE_REQUIRES_KICHWA_NATIONALITY` → `peopleConceptId`. El pueblo de
  //     la columna 14 «aplica únicamente para la nacionalidad indígena
  //     "Kichwa"». Es el hermano de `NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY`
  //     un escalón más abajo de la misma cadena.
  //   * `ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY` → `ethnicityConceptId`. La
  //     columna 12 «aplica para nacionalidad Ecuatoriana». Es el escalón de
  //     ARRIBA de esa misma cadena, y el único de los tres que se teclea por
  //     accidente: el país y la etnia están en dos pantallas del mismo
  //     formulario.
  //   * `SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE` → `sexualOrientationConceptId`.
  //     La columna 7 «aplica a usuarios a partir de los 10 años de edad», y la
  //     edad se DERIVA de la fecha de nacimiento en `America/Guayaquil`.
  //
  // NINGUNO es un `CATALOG_CONCEPT_*`: el concepto enviado existe, es del
  // catálogo correcto y está vigente — lo que no encaja es con OTRO campo de la
  // ficha, y lo que hay que hacer es distinto. Y ninguno puede ser un `CHECK`:
  // los dos primeros dependen de qué fila de otro catálogo es «Kichwa» o
  // «Ecuador», y el tercero de una edad que se mueve sola con el calendario.
  'ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY',
  'PEOPLE_REQUIRES_KICHWA_NATIONALITY',
  'SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE',
  // Grupos prioritarios del paciente (P3: PA-033..PA-042, D-026, D-027).
  //
  // Son cinco y no uno porque lo que hay que hacer es distinto en cada caso, y
  // quien lo lee está delante del paciente:
  //
  //   * `PRIORITY_GROUP_NOT_RECORDABLE` (422) — se intentó guardar «adulto
  //     mayor» o «niña, niño o adolescente», que salen de la fecha de
  //     nacimiento y NO se guardan (PA-035). Guardarlos sería un dato que
  //     caduca cada cumpleaños.
  //   * `PRIORITY_GROUP_PERIOD_INVALID` (422) — el periodo no se sostiene:
  //     termina antes de empezar, o es un embarazo sin fecha probable de parto
  //     ni fecha de fin (PA-036). Sin fin, el embarazo ordenaría la lista de
  //     espera para siempre, que es exactamente la columna booleana que este
  //     diseño existe para evitar.
  //   * `PRIORITY_GROUP_EVIDENCE_REQUIRED` (422) — se marcó «acreditado» sin
  //     decir con qué documento (PA-038).
  //   * `PRIORITY_GROUP_RESTRICTED` (403) — los cuatro grupos de la SEGUNDA
  //     frase del art. 35 (D-027) exigen `patient:priority:protected` para
  //     REGISTRARSE. Al LEER no se rechaza: se omiten, porque un 403 sobre una
  //     lectura confirmaría que esa fila existe, y eso es el oráculo que
  //     PA-024 evita para el registro entero.
  //   * `PRIORITY_GROUP_NOT_FOUND` (404) — la fila no existe, es de otro
  //     paciente o es una que quien pregunta no puede ver. Las tres responden
  //     igual, por lo mismo que `PATIENT_NOT_FOUND`.
  'PRIORITY_GROUP_EVIDENCE_REQUIRED',
  'PRIORITY_GROUP_NOT_FOUND',
  'PRIORITY_GROUP_NOT_RECORDABLE',
  'PRIORITY_GROUP_PERIOD_INVALID',
  'PRIORITY_GROUP_RESTRICTED',
  'PERMISSION_DENIED',
  // Configuración, C3 (CF-060..CF-066). `HOLIDAY_DUPLICATE` lo produce la base
  // —`holiday_date_scope_unique`, un índice `UNIQUE NULLS NOT DISTINCT` que
  // cubre los dos alcances de CF-060— y el adaptador lo traduce al código que
  // la spec fija. `PARAM_OUT_OF_RANGE` es 422 y NOMBRA el rango, que es la
  // mitad de CF-065 que sirve de algo. `SITE_PARAMETERS_NOT_FOUND` existe
  // porque `SITE_NOT_FOUND` ya es de `organization`, dueño de la sede, y dos
  // clases con el mismo código son dos situaciones que el cliente no puede
  // distinguir; además es lo único que este módulo puede afirmar con
  // honestidad, porque no es el dueño de la sede.
  'HOLIDAY_DUPLICATE',
  'HOLIDAY_NOT_FOUND',
  'PARAM_OUT_OF_RANGE',
  'SITE_PARAMETERS_NOT_FOUND',
  // D-021, 14-08-2026. La duración configurada no es múltiplo del átomo de la
  // agenda. Lo responden TRES módulos —`specialties` por la duración base
  // (SP-021), `staff` por la excepción del médico (SP-022) y `configuration`
  // por el átomo mismo cuando se cambia (CF-062)— y por eso la clase vive en
  // `shared/domain/errors`, como `SERVICE_TYPE_NOT_FOUND`. NO es
  // `PARAM_OUT_OF_RANGE`: 25 minutos sobre una rejilla de 10 está dentro del
  // rango 5..240 y aun así no se puede reservar, así que un cliente que
  // ramificara por el mismo código tendría que leer el texto en español para
  // saber qué corregir.
  'DURATION_NOT_SLOT_MULTIPLE',
  // Organización, O1 y O2 (ADR-011). Los duplicados y los «en uso» son 409 y
  // los produce la base —índices únicos y FK RESTRICT—: el adaptador los
  // traduce por nombre de constraint al código que la spec fija. «En uso»
  // ofrece desactivar en lugar de borrar, que es la otra mitad de OR-006 y
  // OR-022. `ESTABLISHMENT_NOT_FOUND` no es corrupción de datos: una
  // instalación recién montada no tiene establecimiento hasta que alguien
  // rellena el formulario, y OR-001 prohíbe operar hasta entonces.
  'EMISSION_POINT_DUPLICATE',
  'SRI_ESTABLISHMENT_CODE_DUPLICATE',
  'EMISSION_POINT_NOT_FOUND',
  'ESTABLISHMENT_NOT_FOUND',
  'MSP_UNICODE_DUPLICATE',
  // SRI (sri/SPEC.md §8). El comprobante electrónico y el certificado del
  // emisor. Uno solo para «no existe» y «fuera de alcance» (SRI-065); uno solo
  // para «no es .p12» y «clave equivocada» (SRI-081), que distinguidos son un
  // oráculo para quien adivina la clave de un fichero robado.
  'SRI_CERTIFICATE_EXPIRED',
  'SRI_CERTIFICATE_INVALID',
  'SRI_CERTIFICATE_STORE_NOT_CONFIGURED',
  'SRI_CERTIFICATE_TOO_LARGE',
  'SRI_VOUCHER_NOT_FOUND',
  'SRI_VOUCHER_NOT_RETRIABLE',
  'SITE_IN_USE',
  // OR-032. La sede nace con su establecimiento: sin él, no hay sede.
  'SITE_ESTABLISHMENT_REQUIRED',
  'SITE_NOT_FOUND',
  'SITE_ROOM_DUPLICATE',
  'SITE_ROOM_IN_USE',
  'SITE_ROOM_NOT_FOUND',
  // Especialidades, C1. Los duplicados y los «en uso» son 409 y los produce la
  // base (índices únicos funcionales y FK RESTRICT): el adaptador los traduce
  // por nombre de constraint al código que la spec fija (SP-003, SP-006,
  // SP-025, SP-026). «En uso» ofrece desactivar en lugar de borrar, que es la
  // otra mitad del requisito. Los dos de asignación son del servicio: SP-005
  // exige exactamente una especialidad principal, y SP-004 prohíbe asignar
  // una especialidad desactivada a un profesional que no la tenía.
  // Profesionales, S1 y S2 (ADR-011). `PRACTITIONER_NOT_FOUND`,
  // `PRIMARY_SPECIALTY_REQUIRED` y `SPECIALTY_INACTIVE` ya existían emitidos
  // desde `specialties`: al saldarse la deuda el 13-08-2026 cambiaron de
  // emisor, no de cadena — el `code` es contrato público y renombrarlo rompe
  // clientes. Los nuevos: el ACESS vencido impide FIRMAR y nunca agendar
  // (D-009, ST-004), y el ausente se distingue del vencido a propósito porque
  // lo que hay que hacer es distinto —registrarlo frente a renovarlo—; el
  // profesional con historial no se borra, se desactiva (ST-010); y una regla
  // o una reserva en una sede donde no atiende se rechaza (ST-007).
  //
  // `SCHEDULE_RULE_OVERLAP` NO está aquí: lo produce el EXCLUDE
  // `schedule_rule_no_overlap` y se registra en `staff.constraints.ts`, que es
  // su enumeración, igual que `PRACTITIONER_SLOT_TAKEN`.
  'ACESS_EXPIRED',
  'ACESS_MISSING',
  'INVALID_SCHEDULE_RULE',
  'PRACTITIONER_IN_USE',
  'PRACTITIONER_NOT_FOUND',
  'PRACTITIONER_NOT_IN_SITE',
  'PRACTITIONER_NOT_SCHEDULABLE',
  'PRIMARY_SPECIALTY_REQUIRED',
  'SCHEDULE_RULE_NOT_FOUND',
  'SERVICE_TYPE_DUPLICATE',
  'SERVICE_TYPE_IN_USE',
  'SERVICE_TYPE_NOT_FOUND',
  'SPECIALTY_DUPLICATE',
  'SPECIALTY_INACTIVE',
  'SPECIALTY_IN_USE',
  'SPECIALTY_NOT_FOUND',
  // Auth, A2 (AU-020..AU-034): la administración de cuentas, roles y permisos.
  // A diferencia de los códigos de SESIÓN, que son deliberadamente vagos para
  // no enumerar al personal ante un anónimo, estos responden a quien ya tiene
  // `user:manage` y está mirando la lista: ser específico aquí no relaja
  // AU-002, es otro modelo de amenaza.
  //
  // `CANNOT_DEMOTE_SELF` es el que protege la instalación (AU-024) y cubre las
  // tres formas de dejarla sin administrador: desactivarse a uno mismo,
  // quitarse el propio `user:manage`, y borrar o desactivar el último rol que
  // lo concede. Es 422 y no 403 a propósito: quien llama está perfectamente
  // autorizado; lo que pide es un estado al que el sistema no debe poder
  // llegar. `SYSTEM_ROLE_PROTECTED` y `UNKNOWN_PERMISSION` son 422 por lo
  // mismo. `ROLE_IN_USE` es 409 y ofrece desactivar, igual que `SITE_IN_USE`.
  //
  // `CANNOT_GRANT_TO_SELF` no es una regla nueva: `user_role_grant_no_self_grant`
  // está en la base desde la migración de roles, con su porqué al lado —«la
  // pregunta de auditoría "quién dio a esta persona acceso a las historias" no
  // puede responderse "ella misma"»—. Construir las pantallas es lo que le ha
  // dado por fin una forma de alcanzarse, y el código es lo que convierte un
  // `CHECK_FAILED` en una frase sobre la que una clínica puede actuar.
  'CANNOT_DEMOTE_SELF',
  'CANNOT_GRANT_TO_SELF',
  // Auth, A4 (AU-035, D-014). Reiniciar el propio segundo factor. Es 422 por
  // lo mismo que los dos de arriba: quien llama está autorizado, y lo que pide
  // es un estado al que no debe poder llegarse por esta puerta.
  //
  // No es simetría con AU-024. La ruta exige una sesión completa, y una sesión
  // completa significa que el segundo factor YA funcionó: nunca podría ser un
  // camino de recuperación, sólo una forma de que quien tenga una sesión viva
  // de esa cuenta —un portátil desbloqueado— le retire el factor y a partir de
  // ahí entre con la contraseña sola. Y dejaría al autor y al sujeto siendo la
  // misma persona, que es justo lo que hace inútil la entrada de bitácora que
  // AU-035 exige.
  'CANNOT_RESET_OWN_MFA',
  // Auth, primera credencial (AU-021 y AU-026..AU-029, D-013 resuelta el
  // 13-08-2026).
  //
  // `INVALID_CREDENTIAL_TOKEN` es UNO SOLO para tres situaciones —enlace
  // desconocido, ya usado y caducado— y eso es el requisito, no una
  // simplificación: el endpoint es PÚBLICO por necesidad —quien no puede
  // iniciar sesión es justo quien tiene que alcanzarlo— y distinguirlas lo
  // convierte en un oráculo sobre el propio secreto. Es 422 y no 404 porque un
  // 404 diría «este token no existe», que es exactamente lo que no puede
  // decirse.
  //
  // Los dos del correo son fallos de un servicio externo y se distinguen por
  // lo que hay que hacer: `MAIL_NOT_CONFIGURED` (502, no reintentable) es
  // configuración que falta y nombra la variable; `MAIL_DELIVERY_FAILED` (503
  // con `Retry-After`) es un servidor que no aceptó el mensaje y puede
  // aceptarlo dentro de un minuto. Ninguno de los dos hace fracasar el alta de
  // la cuenta (AU-029): la respuesta lleva `invitationSent: false` y el error
  // queda en el registro.
  'INVALID_CREDENTIAL_TOKEN',
  'MAIL_DELIVERY_FAILED',
  'MAIL_NOT_CONFIGURED',
  'EMAIL_ALREADY_REGISTERED',
  'ROLE_CODE_DUPLICATE',
  'ROLE_IN_USE',
  'ROLE_NOT_FOUND',
  'SYSTEM_ROLE_PROTECTED',
  'UNKNOWN_PERMISSION',
  // El hermano de `UNKNOWN_PERMISSION`, y lo contrario: el código SÍ declara el
  // permiso y es la tabla `permission` de ESTA instalación la que aún no lo
  // tiene. Ocurre entre desplegar una versión que declara uno nuevo y correr
  // `pnpm db:seed:auth`, y hasta ahora salía por la puerta genérica de la base
  // —`RELATED_RECORD_MISSING`, «Datos inválidos»— sobre un formulario donde
  // nada era inválido. Es 409 y no 422 porque lo que impide la operación es el
  // estado de la instalación, no lo que se envió.
  'PERMISSION_NOT_INSTALLED',
  'USER_NOT_FOUND',
  'PRINCIPAL_UNAVAILABLE',
  'REFRESH_TOKEN_REUSE_DETECTED',
  // Agenda, AG-071: el consultorio pedido es de otra sede. Nada en el esquema
  // ata `agenda_entry.room_id` a `agenda_entry.site_id` —la única garantía es
  // la clave foránea contra `site_room(id)`—, así que por el cuerpo de la
  // petición se ocupaba un recurso físico de una sede sobre la que quien
  // reserva no tiene alcance, y la entrada no aparecía nunca en la agenda de
  // esa sede, que filtra por `site_id`. Es 422 y no 403: el dato enviado es
  // incoherente, y responder «acceso denegado» diría de qué sede es el
  // consultorio a quien no puede saberlo.
  'ROOM_NOT_IN_SITE',
  'ROUTE_NOT_SECURED',
  // AU-036. El token de acceso pertenece a una sesión que ya se cerró: se
  // reinició el segundo factor, se cambió la contraseña o se desactivó la
  // cuenta. Es distinto de `INVALID_TOKEN` a propósito —ése es «esto no lo
  // firmamos nosotros», y su motivo se oculta porque separa caducado de
  // falsificado—, y no revela nada a quien ya tiene el token en la mano. Lo que
  // gana es que la interfaz mande a esa persona a iniciar sesión con la frase
  // que corresponde. Ver `SessionRevokedError`.
  'SESSION_REVOKED',
  // AU-040. La sesión llegó a su tope de vida contado desde el inicio de
  // sesión (D-063). No es `SESSION_REVOKED`: nadie la cerró, y la frase de
  // aquél —«cambiaron su contraseña»— sería mentira. Ver `SessionExpiredError`.
  'SESSION_EXPIRED',
  'SESSION_USER_MISSING',
  'SITE_SCOPE_DENIED',
  // Agenda: la hora de inicio no cae en el borde de un cupo de la regla. Es
  // distinto de `INVALID_SLOT_DURATION` a propósito: una cita de 08:10 a 08:30
  // dura exactamente un cupo y aun así parte la rejilla en dos huecos que ya
  // nadie puede reservar. Lo que hay que corregir es la hora de inicio, no la
  // de fin, y un solo código obligaría a leer el texto para saber cuál.
  'SLOT_NOT_ALIGNED',
  'WEAK_PASSWORD',

  // ═════════════════════════════════════════════════════════════════════════
  // Facturación, B1 y B2. Añadidos AL FINAL a propósito: este archivo lo tocan
  // varios módulos a la vez, y reordenar o intercalar convierte un añadido en
  // un diff que nadie puede revisar.
  // ═════════════════════════════════════════════════════════════════════════
  //
  // El catálogo de prestaciones (BI-010 a BI-015) y las tarifas del SRI
  // (BI-013, BI-020, BI-026). `BILLABLE_SERVICE_IN_USE` y `TAX_RATE_IN_USE`
  // son 409 y dicen la salida —desactivar, no borrar—: la prestación que
  // nombra una factura de hace ocho meses tiene que seguir existiendo para
  // que esa factura se pueda leer. `TAX_RATE_REQUIRED` es 422 y vive en el
  // servicio y no sólo en el DTO (D-A-006): el sistema NO deduce la tarifa de
  // ninguna característica de la prestación, porque el 0 % de la LRTI art.
  // 56.2 depende del PRESTADOR y excluye la estética, y una regla que lo
  // dedujera acertaría casi siempre y fallaría donde hay fiscalización.
  'BILLABLE_SERVICE_INACTIVE',
  'BILLABLE_SERVICE_IN_USE',
  'BILLABLE_SERVICE_NOT_FOUND',
  'TAX_RATE_IN_USE',
  'TAX_RATE_NOT_FOUND',
  'TAX_RATE_REQUIRED',
  // Pagadores (BI-030 a BI-034). Son filas y no un `enum` del código, así que
  // se pueden agotar: `LAST_ACTIVE_PAYER` (409) impide dejar la instalación
  // sin ninguno activo, que es una clínica que no puede abrir una sola cuenta.
  // `PAYER_RUC_REQUIRED` (422) es la ÚNICA ramificación por `kind` del módulo
  // y es distinta de `INVALID_RUC`, que ya existe y comprueba el dígito: aquí
  // el dato falta, allí está mal, y lo que hay que hacer no es lo mismo.
  'LAST_ACTIVE_PAYER',
  'PAYER_INACTIVE',
  'PAYER_IN_USE',
  'PAYER_NOT_FOUND',
  'PAYER_RUC_REQUIRED',
  // El tarifario (BI-040 a BI-047). `PRICE_NOT_FOUND` es 422 y NOMBRA LOS
  // TRES DATOS con los que se buscó —prestación, pagador y fecha de
  // servicio—: quien está en caja tiene que poder decir si falta el precio, si
  // el pagador no es el que toca o si la fecha se tecleó mal, y un error que
  // no los distingue manda a alguien a buscar en el sitio equivocado.
  // El solape de vigencias NO está aquí: lo produce `price_temporal_unique` y
  // sale por el mapeo de PostgreSQL, que tiene su propia tabla.
  'PRICE_LIST_NOT_FOUND',
  'PRICE_NEGATIVE_AMOUNT',
  'PRICE_NOT_FOUND',
  'PRICE_PERIOD_INVALID',
  // La cuenta y el cargo (BI-033, BI-057, BI-071, BI-072, BI-135).
  // `ACCOUNT_NOT_FOUND` no distingue «no existe» de «es de otra sede», por lo
  // mismo que `AGENDA_ENTRY_NOT_FOUND`: una cuenta confirma que un paciente
  // estuvo. `ACCOUNT_HAS_CHARGES` (409) es el cambio de pagador con cargos ya
  // congelados a la tarifa anterior, y `ACCOUNT_HAS_OPEN_CHARGES` (409)
  // ENUMERA los cargos que impiden cerrar, con identificadores y sin nombres
  // de prestación (BI-007).
  'ACCOUNT_CLOSED',
  'ACCOUNT_HAS_CHARGES',
  'ACCOUNT_HAS_OPEN_CHARGES',
  'ACCOUNT_NOT_FOUND',
  'INVALID_CHARGE_QUANTITY',
  // Del acto clínico al cargo (BI-150 a BI-158), que es el paso de la consulta
  // a la caja.
  //
  //   * `BILLING_ENCOUNTER_NOT_FOUND` (404) — la atención no existe o es de
  //     otra sede. **No es `ENCOUNTER_NOT_FOUND`**, que es del módulo clínico:
  //     dicen lo mismo y contestan a preguntas distintas, igual que
  //     `ORDER_ENCOUNTER_NOT_FOUND`.
  //   * `PAYER_REQUIRED_TO_OPEN_ACCOUNT` (422) — enviar a caja una atención sin
  //     cuenta necesita saber quién paga, porque `patient_account.payer_id` es
  //     NOT NULL y de él sale la lista que congela cada cargo (BI-121). NO es
  //     una puerta a la atención: nada clínico llama a esta ruta.
  //   * `CHARGE_NOT_FOUND` (404) — mismo silencio que `ACCOUNT_NOT_FOUND`.
  //   * `CHARGE_ITEM_ALREADY_INVOICED` (409) — BI-056, y el texto NOMBRA LA
  //     SALIDA: no hay botón de editar factura que buscar, hay nota de crédito.
  //   * `CHARGE_ALREADY_VOIDED` (409) — BI-059, un cargo anulado no se
  //     reactiva; se registra uno nuevo, con su fecha y su autor.
  //   * `ACT_ALREADY_CHARGED` (409) — lo levanta uno de los tres índices únicos
  //     parciales de `charge_item`, no una comprobación previa: es lo que hace
  //     cierto «pulsar dos veces no duplica» con dos cajeras a la vez.
  'ACT_ALREADY_CHARGED',
  'BILLING_ENCOUNTER_NOT_FOUND',
  'CHARGE_ALREADY_VOIDED',
  'CHARGE_ITEM_ALREADY_INVOICED',
  'CHARGE_NOT_FOUND',
  'PAYER_REQUIRED_TO_OPEN_ACCOUNT',
  // La factura (BI-080 a BI-090). Los cuatro primeros son del RECEPTOR, que
  // es la mitad que le cuesta dinero real al paciente:
  //
  //   * `INVOICE_RECEIVER_REQUIRED` (422) — falta un dato del receptor, y el
  //     error dice CUÁL.
  //   * `FINAL_CONSUMER_NOT_CONFIRMED` (422) — «Consumidor Final» es una
  //     excepción explícita y jamás el valor por defecto (D-A-007, BI-081):
  //     emitir así DESTRUYE la rebaja de gastos personales del paciente y
  //     desde 2026 esa factura ya no se puede ni anular. La confirmación es
  //     del SERVIDOR y no de un diálogo, porque una advertencia que sólo vive
  //     en la pantalla desaparece en cuanto alguien llama a la ruta desde un
  //     atajo de caja.
  //   * `INVOICE_RECEIVER_IS_PAYER` (422) — la factura de un reembolso va a
  //     nombre del paciente o del titular de la póliza, nunca de la
  //     aseguradora (BI-087, REQ-084). La spec no le puso código; reutilizar
  //     `INVOICE_RECEIVER_REQUIRED` diría que falta un campo que está lleno.
  //   * `INVOICE_NOT_FOUND` (404) — mismo silencio que `ACCOUNT_NOT_FOUND`.
  //
  // `INVOICE_IMMUTABLE` (409) es el disparador `trg_invoice_immutable`
  // traducido en el repositorio, no una regla escrita otra vez: NINGUNA ruta
  // de este módulo modifica una factura —esa ausencia ES BI-090—, así que
  // llegar aquí significa que alguien escribió por debajo de la aplicación. El
  // texto nombra la salida, la nota de crédito, porque no hay botón de editar
  // que buscar y no lo va a haber.
  'EMISSION_POINT_INACTIVE',
  'FINAL_CONSUMER_NOT_CONFIRMED',
  'INVOICE_HAS_NO_ITEMS',
  'INVOICE_SERVICE_CODE_TOO_LONG',
  'INVOICE_IMMUTABLE',
  'INVOICE_NOT_FOUND',
  'INVOICE_RECEIVER_IS_PAYER',
  'INVOICE_RECEIVER_REQUIRED',
  // ─── Encounter, H1/H2/H4 (EN-001 a EN-034, EN-060 a EN-068, EN-126 a
  // EN-147). La atención: abrirla, documentarla y cerrarla.
  //
  // Son muchos y no uno por familia porque lo que hay que hacer es distinto en
  // cada caso, y quien lo lee está con el paciente delante:
  //
  //   * `ENCOUNTER_NOT_FOUND` (404) — no existe, o es de una sede fuera del
  //     alcance. UN SOLO MENSAJE PARA LAS DOS, como `AGENDA_ENTRY_NOT_FOUND`:
  //     distinguirlas confirmaría atenciones ajenas a quien adivina
  //     identificadores.
  //   * `PATIENT_CHART_NOT_OPEN` (409) — la ficha no existe o la absorbió una
  //     fusión. Es el art. 4 del A.M. 00115-2021 —la historia se abre ANTES de
  //     atender— y lo que prohíbe es el atajo de crear la ficha desde la
  //     pantalla de atención, que es como nacen los duplicados que PA-043
  //     existe para arreglar. NO nombra el MRN superviviente, a diferencia de
  //     `PATIENT_MERGED`: aquí quien llama puede no tener la ficha en la mano.
  //   * `ENCOUNTER_APPOINTMENT_MISMATCH` (422) — la cita es de otro paciente.
  //     Lo garantiza `trg_encounter_matches_appointment`; el código es lo que
  //     convierte su rechazo en una frase. Es el peor error posible de este
  //     sistema: atender al paciente equivocado en el cupo de otro escribe el
  //     acto en la historia equivocada.
  //   * `APPOINTMENT_NOT_ATTENDABLE` (409) — la cita está anulada o marcada
  //     como inasistencia. ES EL REVERSO DE `AGENDA_ENTRY_HAS_ENCOUNTER` y con
  //     él se cierra AG-045: aquélla la emite `agenda` al anular, ésta la
  //     emite `encounter` al atender, y entre las dos exactamente una de las
  //     dos operaciones gana.
  //   * `ENCOUNTER_ALREADY_CLOSED` (409) — contenido clínico nuevo sobre una
  //     atención que ya no está viva. La salida es enmendar lo escrito o abrir
  //     otra atención (EN-006), y el mensaje lo dice.
  //   * `DISCHARGE_CONDITION_REQUIRED` (422) — dar el alta o cerrar sin decir
  //     cómo terminó. ES POR ESTE CÓDIGO POR LO QUE NO HAY CIERRE AUTOMÁTICO
  //     (EN-145): un proceso nocturno tendría que inventarse el hecho clínico.
  //   * `ENCOUNTER_STATE_TRANSITION_INVALID` (409) — la tabla de EN-132 no
  //     admite ese par. UNO SOLO PARA TODOS: reabrir una cerrada, saltarse el
  //     alta y suspender una ya dada de alta son el mismo hecho —«desde donde
  //     está, eso no»— y el mensaje dice en qué estado está y qué se puede
  //     hacer desde ahí.
  //   * `ENCOUNTER_CLOSER_NOT_AUTHOR` (403) y
  //     `SUBSTITUTE_CLOSURE_REASON_REQUIRED` (422) — D-A-010. El primero es
  //     «esto lo cierra quien la abrió»; el segundo es lo que cuesta la
  //     excepción cuando quien la abrió ya no está. Con `record:sign` el
  //     primero NO salta: se cierra dejando constancia.
  //   * `PRACTITIONER_PROFILE_REQUIRED` (403) — la cuenta no tiene ficha
  //     profesional y el acto va firmado por un profesional. `closed_by_id`,
  //     `author_id` y `signed_by_id` son claves foráneas a `practitioner`, así
  //     que sin este código el caso salía como `RELATED_RECORD_MISSING` sobre
  //     un formulario donde nada estaba mal.
  //   * `PRACTITIONER_NOT_LICENSED` (403) — el registro ACESS no está vigente
  //     el día de la firma (EN-029). Distinto de `ACESS_EXPIRED` de `staff` a
  //     propósito: aquél responde «no se puede dar de alta», éste «no puede
  //     firmar hoy», y las dos reglas viven donde está su razón de ser.
  //   * `BMI_IS_DERIVED` (422) — se envió el IMC. Se RECHAZA y no se ignora:
  //     `trg_encounter_vitals_bmi` lo sobrescribe, así que descartarlo en
  //     silencio dejaría a quien lo tecleó creyendo que su número es el que
  //     está en el expediente.
  //   * `VITALS_REQUIRED` (422) — falta la antropometría que el instructivo
  //     hace obligatoria en menores de 5 años, evaluada con la EDAD CONGELADA
  //     de la atención y no con la de hoy.
  //   * `CLINICAL_NOTE_NOT_FOUND` (404), `UNKNOWN_CLINICAL_FORM` (422) y
  //     `NOTE_CONTENT_INCOMPLETE` (422) — la nota no existe en esa atención,
  //     el formulario no está configurado, o falta una de las secciones que el
  //     art. 6 pone en el contenido mínimo de la HCU.
  //   * `NOTE_ALREADY_SIGNED` (409) — REQ-005. Lo garantiza
  //     `trg_clinical_note_immutable`, que levanta `insufficient_privilege`;
  //     el disparador es la garantía y este código es lo que evita que salga
  //     como un 403 diciéndole al médico que no tiene permisos cuando lo que
  //     pasa es que la nota está firmada.
  //   * `AMENDMENT_REASON_REQUIRED` (422) y `NOTE_NOT_AMENDABLE` (409) — la
  //     enmienda sin motivo, y la enmienda de un borrador, de una versión ya
  //     sustituida o de una retractada. El motivo se exige en el DTO, en el
  //     servicio y en la base, por lo mismo que `CANCELLATION_REASON_REQUIRED`.
  // EN-166, EN-167 (D-077, D-080, D-082). Anular e interrumpir una atención
  // exigen motivo escrito —e interrumpir, además, el origen—. 422 por campo:
  // es el formulario el que se corrige. Y 409 cuando hay un borrador de otra
  // persona que la interrupción dejaría sin firmar (D-085 §2); 409 si la
  // atención tiene actos vivos que retractar antes de anularla (D-099 §1), y
  // 409 si la cita no tiene registrada la llegada (D-099 §2).
  'ENCOUNTER_ANNULMENT_REASON_REQUIRED',
  'ENCOUNTER_HAS_LIVE_ACTS',
  'ENCOUNTER_HAS_OTHERS_DRAFTS',
  'APPOINTMENT_ARRIVAL_NOT_RECORDED',
  'ENCOUNTER_INTERRUPTION_REASON_REQUIRED',
  'AMENDMENT_REASON_REQUIRED',
  'APPOINTMENT_NOT_ATTENDABLE',
  'BMI_IS_DERIVED',
  'CLINICAL_NOTE_NOT_FOUND',
  'DISCHARGE_CONDITION_REQUIRED',
  'ENCOUNTER_ALREADY_CLOSED',
  'ENCOUNTER_APPOINTMENT_MISMATCH',
  'ENCOUNTER_CLOSER_NOT_AUTHOR',
  'ENCOUNTER_NOT_FOUND',
  'ENCOUNTER_STATE_TRANSITION_INVALID',
  'NOTE_ALREADY_SIGNED',
  'NOTE_CONTENT_INCOMPLETE',
  'NOTE_NOT_AMENDABLE',
  'PATIENT_CHART_NOT_OPEN',
  'PRACTITIONER_NOT_LICENSED',
  'PRACTITIONER_PROFILE_REQUIRED',
  'SUBSTITUTE_CLOSURE_REASON_REQUIRED',
  'UNKNOWN_CLINICAL_FORM',
  'VITALS_REQUIRED',
  // ── H3: el bloque K del RDACAA — diagnósticos y procedimientos ──────────
  //   * `CONCEPT_WRONG_CATALOGUE` (422) — el concepto existe y es de otro
  //     catálogo. La clave foránea apunta a `catalog_concept`, que guarda
  //     TODOS los catálogos, así que garantiza que la fila existe y nada sobre
  //     qué clase de cosa es: sin este código, una parroquia del DPA se
  //     archiva como diagnóstico y lo es para siempre.
  //   * `DIAGNOSIS_CONCEPT_NOT_IN_FORCE` (422) — EN-042, REQ-029. Lo garantiza
  //     `trg_diagnosis_concept_in_force`; el disparador levanta
  //     `integrity_constraint_violation` desde PL/pgSQL, así que PostgreSQL no
  //     emite cláusula «violates … constraint "…"» y el nombre NO viaja. El
  //     mapeo sólo puede responder `INTEGRITY_RULE_FAILED`, que no le dice al
  //     médico qué código elegir. Por eso el adaptador se adelanta con la misma
  //     pregunta dentro de la misma transacción, igual que `NOTE_ALREADY_SIGNED`.
  //   * `DIAGNOSIS_PRIMARY_TAKEN` (409) — EN-043. Lo arbitra el índice único
  //     parcial `encounter_diagnosis_one_primary`; el adaptador lee el rango en
  //     uso en la misma transacción para que el rechazo sea una frase. Dos
  //     principales hacen que el reporte cuente la misma consulta dos veces en
  //     dos causas de morbilidad distintas.
  'CONCEPT_WRONG_CATALOGUE',
  'DIAGNOSIS_CONCEPT_NOT_IN_FORCE',
  'DIAGNOSIS_PRIMARY_TAKEN',
  // ── H6: alergias visibles durante la consulta ──────────────────────────
  //   * `PATIENT_ALLERGY_NOT_FOUND` (404) — EN-082. La alergia no está en esa
  //     ficha ni en ninguna que esa ficha absorbiera. **Uno solo para «no
  //     existe» y para «es de otra ficha»**, la línea de `ENCOUNTER_NOT_FOUND`:
  //     distinguirlas confirmaría, de una en una, que cierto identificador es
  //     una alergia de la historia de otra persona.
  //   * `ALLERGY_ALREADY_REFUTED` (409) — EN-082. **No se trata como
  //     idempotente a propósito**: la segunda refutación reescribiría la fecha
  //     y el motivo de la primera, y saber quién descartó una alergia y por qué
  //     es «información clínica por derecho propio». Aceptarla en silencio es
  //     borrar el dato a cámara lenta, que es justo lo que el requisito impide.
  //   * `REFUTATION_REASON_REQUIRED` (422) — EN-082. Descartar sin escribir por
  //     qué. Se exige **en el servicio** además del DTO, por lo mismo que
  //     `AMENDMENT_REASON_REQUIRED`: el DTO guarda una sola puerta.
  //   * `CHART_HAS_ALLERGIES` (409) — EN-087. Se afirmó «sin alergias
  //     conocidas» sobre una ficha que tiene alergias sin descartar. Las dos
  //     cosas no pueden ser ciertas a la vez, y quien lee la primera deja de
  //     mirar la lista. La salida es refutarlas **una a una con su motivo**
  //     (EN-082), que es un juicio clínico por alergia y no el efecto colateral
  //     de marcar una casilla. Lo arbitra además
  //     `trg_patient_allergy_absence_empty_chart`: el servicio no puede ver las
  //     dos peticiones simultáneas que registran una alergia y afirman que no
  //     hay ninguna.
  'ALLERGY_ALREADY_REFUTED',
  'CHART_HAS_ALLERGIES',
  'PATIENT_ALLERGY_NOT_FOUND',
  'REFUTATION_REASON_REQUIRED',
  // ── H6: antecedentes (EN-085), con el régimen de las alergias ───────────
  //   * `PATIENT_HISTORY_NOT_FOUND` (404) — el mismo para «no existe» y «es
  //     de otra ficha», por lo mismo que `PATIENT_ALLERGY_NOT_FOUND`.
  //   * `HISTORY_ALREADY_REFUTED` (409) — no es idempotente: reescribiría
  //     quién lo descartó y por qué. Lo arbitra además
  //     `trg_patient_history_append_only`.
  'HISTORY_ALREADY_REFUTED',
  'PATIENT_HISTORY_NOT_FOUND',
  // ── Receta médica (módulo `prescription`, PR-001 a PR-094) ──────────────
  //
  // La norma que los funda es la **Resolución ACESS-2023-0030** (A.M.
  // 00031-2020), NO el A.M. 1124: el art. 1 de aquél lo limita a «las unidades
  // de salud del Ministerio de Salud Pública» y no alcanza a una clínica
  // privada. El regulador es la **ACESS**, no ARCSA.
  //
  // ⚠️ CINCO DE ESTOS CÓDIGOS DICEN ALGO PARECIDO A UNO DE `encounter` Y AUN
  // ASÍ SON PROPIOS, y conviene dejarlo escrito antes de que alguien los
  // «unifique»: ningún módulo importa de otro (CLAUDE.md §3), así que la clase
  // de `encounter` no es alcanzable desde aquí; y `error-catalogue.spec.ts`
  // falla si dos clases declaran el mismo `code`, porque el cliente ramifica
  // por el código y dos situaciones con un solo código son dos cosas que no
  // puede distinguir. En cada par, además, lo que hay que hacer difiere.
  //
  //   * `PRESCRIPTION_NOT_FOUND` (404) — la receta no existe o es de otra sede.
  //     Un solo mensaje para las dos: distinguirlas confirmaría recetas ajenas
  //     a quien adivina identificadores. Es también el art. 10 —«en ningún caso
  //     pueden ser utilizadas en otros establecimientos»— hecho negativa.
  //   * `PRESCRIPTION_ENCOUNTER_NOT_FOUND` (404) y
  //     `PRESCRIPTION_ENCOUNTER_NOT_OPEN` (409) — la atención sobre la que se
  //     receta. Frente a `ENCOUNTER_NOT_FOUND` y `ENCOUNTER_ALREADY_CLOSED`, lo
  //     que cambia es la salida: allí se enmienda una nota, aquí se abre otra
  //     atención, que es la regla del ministerio («tantas consultas como
  //     atenciones médicas recibidas»).
  //   * `PRESCRIPTION_NOT_EDITABLE` (409) — emitir o anular algo que ya no es
  //     un borrador. Uno solo para los tres pares rechazados: lo que hay que
  //     hacer es lo mismo, mirar en qué estado está.
  //   * `PRESCRIPTION_EMPTY` (422) y `PRESCRIPTION_ITEM_INCOMPLETE` (422) — el
  //     contenido mínimo del art. 5.c. Son dos códigos porque lo que hay que
  //     hacer difiere: añadir un medicamento, o rellenar una casilla. El
  //     segundo viaja POR CAMPO y POR LÍNEA, y **nunca nombra el medicamento**:
  //     un fármaco es un diagnóstico dicho de otra forma —la metformina dice
  //     diabetes y el efavirenz dice VIH—.
  //   * `OFF_FORMULARY_JUSTIFICATION_REQUIRED` (422) — recetar fuera del CNMB
  //     está permitido; no decir por qué, no. Lo exige además
  //     `prescription_item_off_formulary` en la base, y la aplicación sólo se
  //     adelanta para dar la frase.
  //   * `CONCEPT_NOT_PRESCRIBABLE` (422) — el concepto es de otro catálogo o no
  //     estaba vigente ese día. La clave foránea apunta a `catalog_concept`,
  //     que guarda TODOS los catálogos: sin este código una parroquia del DPA
  //     se receta como medicamento y lo es para siempre. Es el argumento de
  //     `CONCEPT_WRONG_CATALOGUE`, con código propio por lo dicho arriba.
  //   * `ALLERGY_CONTRAINDICATION` (409) — coincidencia EXACTA de principio
  //     activo con una alergia no refutada. **Es la única alerta que
  //     interrumpe**, y eso es el requisito: en un estudio de 158.023 avisos de
  //     alergia el 81 % se ignoró y, al auditarlos, más del 96 % de esas
  //     omisiones eran correctas, así que una alerta más entrena a cerrar sin
  //     leer. Y NO hay «emitir de todas formas»: no existe columna donde
  //     guardar el motivo, y un motivo que no se guarda es peor que no pedirlo.
  //     La salida es refutar la alergia (EN-082), que deja fila, autor y notas.
  //   * `PRESCRIBER_PROFILE_REQUIRED` (403) — la cuenta no tiene ficha
  //     profesional. `prescription.prescriber_id` es clave foránea a
  //     `practitioner` y no a `app_user`.
  //   * `PRESCRIBER_NOT_LICENSED` (403) — sin registro ACESS, o vencido en la
  //     fecha clínica de la emisión. **Es una regla MÁS ESTRICTA que
  //     `PRACTITIONER_NOT_LICENSED`**, no la misma: aquélla no refuta al
  //     profesional que no tiene registro anotado —si hace falta tenerlo es
  //     pregunta de `staff`— y aquí el art. 5.d.ii imprime el número DENTRO del
  //     documento, así que sin número no hay receta que emitir.
  //   * `PRESCRIBER_CONTACT_REQUIRED` (422) — la ficha profesional no tiene
  //     teléfono de contacto permanente (art. 5.e.vi, PR-040): la receta lo
  //     imprime junto a los signos de alarma y no se emite sin él.
  //   * `PRESCRIPTION_ESTABLISHMENT_INCOMPLETE` (422) — la sede no tiene
  //     parroquia, así que no hay ciudad de prescripción que imprimir (art.
  //     5.a.ii). 422 y no 500: no hay nada roto, falta un dato de la
  //     instalación, y el mensaje dice quién lo arregla y dónde.
  'ALLERGY_CONTRAINDICATION',
  'CONCEPT_NOT_PRESCRIBABLE',
  'CONTROLLED_SUBSTANCE_NOT_PRESCRIBABLE',
  'OFF_FORMULARY_JUSTIFICATION_REQUIRED',
  'PRESCRIBER_CONTACT_REQUIRED',
  'PRESCRIBER_NOT_LICENSED',
  'PRESCRIBER_PROFILE_REQUIRED',
  // PR-095. Art. 5.b.iii: la receta sin diagnóstico CIE no se emite.
  'PRESCRIPTION_DIAGNOSIS_REQUIRED',
  'PRESCRIPTION_EMPTY',
  'PRESCRIPTION_ENCOUNTER_NOT_FOUND',
  'PRESCRIPTION_ENCOUNTER_NOT_OPEN',
  'PRESCRIPTION_ESTABLISHMENT_INCOMPLETE',
  'PRESCRIPTION_ITEM_INCOMPLETE',
  'PRESCRIPTION_NOT_EDITABLE',
  'PRESCRIPTION_NOT_FOUND',
  // ── Certificado médico (módulo `certificates`, CER-001 a CER-016) ────────
  //
  // El formulario SNS-MSP/HCU-form.117/2021 del A.M. 00115-2021. Ninguno de
  // estos reutiliza un código de `encounter` ni de `prescription`, por lo
  // mismo que la receta: ningún módulo importa de otro y dos clases con un
  // mismo código son dos situaciones que el cliente no puede distinguir.
  //
  //   * `CERTIFICATE_ENCOUNTER_NOT_FOUND` (404) — CER-002. La atención no
  //     existe o es de otra sede; un solo mensaje para las dos.
  //   * `CERTIFICATE_ENCOUNTER_NOT_OPEN` (409) — CER-003. `COMPLETED`,
  //     `DISCONTINUED` o `ENTERED_IN_ERROR`: los tres estados de ORD-005.
  //   * `CERTIFIER_PROFILE_REQUIRED` (403) — CER-004. La cuenta no tiene ficha
  //     profesional activa; `issued_by_id` apunta a `practitioner`.
  //   * `CERTIFICATE_TYPE_NOT_SUPPORTED` (422) — CER-005. `FITNESS` y
  //     `DISABILITY_SUPPORT` no son un 117: el de discapacidad es el 116.
  //   * `CERTIFICATE_REST_PERIOD_INVALID` (422, por campo) — CER-006. Lo dice
  //     además `medical_certificate_rest_range` en la base.
  //   * `CERTIFICATE_DIAGNOSIS_REQUIRED` (422) — CER-008. Se pidió el
  //     diagnóstico y la atención no tiene ninguno: no se teclea.
  //   * `CERTIFICATE_NOT_FOUND` (404) — CER-010. No existe o es de otra sede.
  //   * `CERTIFICATE_ALREADY_REVOKED` (409) — CER-012. Anular dos veces
  //     reescribiría quién lo anuló y por qué.
  //   * `CERTIFICATE_BACKDATING_REASON_REQUIRED` (422) — CER-030. Reposo que
  //     empieza antes del día clínico de la atención sin motivo escrito.
  //   * `CERTIFICATE_REST_TOO_LONG` (422) — CER-031. Más de 30 días.
  //   * `CERTIFICATE_ESTABLISHMENT_INCOMPLETE` (422) — CER-036. La sede no
  //     tiene parroquia y no hay lugar de emisión. Propio, no el de la receta.
  //   * `CERTIFICATE_ISSUER_REASON_REQUIRED` (422) — CER-039 (D-105 §1). Emite
  //     quien no atendió y no dice por qué.
  //   * `CERTIFICATE_REST_START_TOO_LATE` (422) — CER-041 (D-105 §3). El
  //     reposo empieza después del día siguiente a la emisión.
  //   * `CERTIFICATE_REST_START_TOO_EARLY` (422) — CER-044 (D-106 §1). Aun
  //     con motivo, más de tres días antes de la atención.
  //   * `CERTIFICATE_REST_ISSUED_TOO_LATE` (422) — CER-045 (D-106 §4). Un
  //     reposo pasados ocho días de la atención.
  //   * `CERTIFICATE_REVOKE_FORBIDDEN` (403) — CER-040 (D-105 §2). Anula quien
  //     no lo emitió y no tiene `certificate:revoke-any` en su sede.
  //   * `CERTIFICATE_MATERNITY_DATES_TOO_OLD` (422) — CER-046 (D-109 §1).
  //     Ingreso o parto más de 84 días antes de la atención.
  //   * `CERTIFICATE_MATERNITY_LEAVE_EXCEEDED` (422) — CER-047 (D-109 §2). El
  //     reposo pasa del parto + 84 días, o se emite después.
  //   * `CERTIFICATE_REST_OVERLAPS` (409) — CER-048 (D-109 §2). La maternidad
  //     se solapa con otro reposo no anulado de la paciente.
  //   * `CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED` (422) — CER-049 (D-109 §3).
  //     La atención no tiene diagnóstico obstétrico.
  'CERTIFICATE_ALREADY_REVOKED',
  'CERTIFICATE_BACKDATING_REASON_REQUIRED',
  'CERTIFICATE_DIAGNOSIS_REQUIRED',
  'CERTIFICATE_ESTABLISHMENT_INCOMPLETE',
  'CERTIFICATE_ISSUER_REASON_REQUIRED',
  'CERTIFICATE_MATERNITY_DATES_TOO_OLD',
  'CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED',
  'CERTIFICATE_MATERNITY_LEAVE_EXCEEDED',
  'CERTIFICATE_REST_OVERLAPS',
  'CERTIFICATE_REST_ISSUED_TOO_LATE',
  'CERTIFICATE_REST_START_TOO_EARLY',
  'CERTIFICATE_REST_START_TOO_LATE',
  'CERTIFICATE_REST_TOO_LONG',
  'CERTIFICATE_REVOKE_FORBIDDEN',
  'CERTIFICATE_ENCOUNTER_NOT_FOUND',
  'CERTIFICATE_ENCOUNTER_NOT_OPEN',
  'CERTIFICATE_NOT_FOUND',
  'CERTIFICATE_REST_PERIOD_INVALID',
  'CERTIFICATE_TYPE_NOT_SUPPORTED',
  'CERTIFIER_PROFILE_REQUIRED',
  // ─── Orders, E1 a E6 (ORD-003 a ORD-009, ORD-032 a ORD-053, ORD-081).
  // Pedir un examen y recibir su resultado.
  //
  //   * `ORDER_NOT_FOUND` (404) y `REPORT_NOT_FOUND` (404) — no existen, o son
  //     de una sede fuera del alcance. **Un solo mensaje para las dos**, la
  //     línea de `ENCOUNTER_NOT_FOUND`: distinguirlas confirmaría órdenes
  //     ajenas a quien prueba identificadores de uno en uno.
  //   * `ORDER_ENCOUNTER_NOT_FOUND` (404) — la atención sobre la que se pide no
  //     existe o está fuera del alcance. **No es `ENCOUNTER_NOT_FOUND`**, que
  //     es de `encounter`: ningún módulo importa de otro, y dos clases con el
  //     mismo `code` rompen este catálogo. La FRASE sí es la misma, porque lo
  //     que hay que hacer es lo mismo.
  //   * `EXAM_NOT_ORDERABLE` (422) — ORD-003. El examen no existe o está
  //     deshabilitado, y **rechaza la orden ENTERA**: un pedido de cinco
  //     exámenes que guarda cuatro es un pedido en el que nadie se fija en cuál
  //     falta, y el que falta es el que nadie reclama.
  //   * `ORDER_ENCOUNTER_NOT_OPEN` (409) — ORD-005. La atención ya no admite
  //     contenido clínico. Distinto de `ENCOUNTER_ALREADY_CLOSED` por lo mismo
  //     que el anterior.
  //   * `ORDER_ITEM_NOT_PENDING` (409) — ORD-008. Anular una línea cuyo
  //     resultado ya llegó sacaría de la cola una observación que sí existe.
  //   * `REPORT_ALREADY_CORRECTED` (409) — ORD-052. Lo arbitra el `UNIQUE`
  //     sobre `diagnostic_report.supersedes_id`; el código convierte esa
  //     colisión en una frase. Una cadena que se bifurca no tiene «versión
  //     vigente», y dos médicos verían dos resultados finales del mismo tubo.
  //   * `REPORT_NOT_CORRECTABLE` (409) — ORD-053. Un informe parcial no se
  //     corrige, se completa; uno anulado ya no afirma nada.
  //   * `RESULT_ANALYTE_UNKNOWN` (422) — ORD-042. La determinación no está en
  //     el catálogo. Rechaza el informe entero, por lo mismo que
  //     `EXAM_NOT_ORDERABLE` rechaza la orden entera.
  //   * `RESULT_VALUE_TYPE_MISMATCH` (422) — ORD-032.
  //     `observation_result_one_value` garantiza que **una** columna está
  //     poblada; lo que la base no puede saber es **cuál debería estarlo**,
  //     porque eso es propiedad del analito y vive en otra tabla. Una
  //     hemoglobina tecleada en `value_text` cumple todos los constraints y
  //     sigue siendo una cadena con aspecto de resultado: ninguna gráfica la
  //     dibuja y ningún umbral la compara.
  //   * `RESULT_VALUE_NOT_ALLOWED` (422) — ORD-033. Sin la lista cerrada, cada
  //     transcriptor escribe `POS`, `+`, `Positivo` y `positivo`, y la regla
  //     clínica que los compare no encuentra ninguno.
  //   * `RESULT_FLAG_IS_DERIVED` (422) — ORD-035. **Se rechaza, no se ignora**,
  //     exactamente como `BMI_IS_DERIVED`: descartarla en silencio dejaría a
  //     quien la tecleó creyendo que su marca es la del expediente, y aquí esa
  //     marca decide si alguien llama al paciente esta noche. La bandera se
  //     calcula con los rangos `CRITICAL` propios, porque muchos laboratorios
  //     mandan solo «alto/bajo» y otros nada (A.M. 00002393 art. 39).
  //   * `RESULT_CHART_UNMATCHED` (404) — ORD-080, ORD-081. Ninguna ficha
  //     vigente lleva esa cédula, **y no se crea ninguna**: crear un paciente
  //     desde un resultado es la causa principal de fichas duplicadas.
  'EXAM_NOT_ORDERABLE',
  'ORDER_ENCOUNTER_NOT_FOUND',
  'ORDER_ENCOUNTER_NOT_OPEN',
  'ORDER_ITEM_NOT_PENDING',
  'ORDER_NOT_FOUND',
  'REPORT_ALREADY_CORRECTED',
  'REPORT_NOT_CORRECTABLE',
  'REPORT_NOT_FOUND',
  'RESULT_ANALYTE_UNKNOWN',
  'RESULT_CHART_UNMATCHED',
  'RESULT_FLAG_IS_DERIVED',
  'RESULT_VALUE_NOT_ALLOWED',
  'RESULT_VALUE_TYPE_MISMATCH',
  // ─── Orders, E7 (ORD-043). Sacar un resultado huérfano de la cola.
  //
  // `GET /orders/results/unmatched` listaba los resultados que no responden a
  // ninguna línea pedida y no había forma de sacarlos de ahí. Una cola que sólo
  // crece deja de mirarse, y una cola que nadie mira no es una red de
  // seguridad: es una lista.
  //
  //   * `RESULT_NOT_FOUND` (404) — ORD-043. El resultado no existe o es de una
  //     sede fuera del alcance. **Uno solo para las dos**, la línea de
  //     `ORDER_NOT_FOUND`: `observation_result.id` es un `bigint`
  //     autoincremental, el identificador más fácil de recorrer del sistema.
  //   * `RESULT_ALREADY_MATCHED` (409) — ORD-043. Ya responde a una línea. Dos
  //     personas trabajando la misma cola es lo normal: una gana, y a la otra
  //     hay que decírselo en vez de volver a apuntar una fila que alguien ya
  //     resolvió. **Y no hay vuelta atrás** mientras no haya columnas para
  //     registrar quién deshizo el emparejamiento y por qué (⚠️ falta esquema).
  //   * `ORDER_ITEM_NOT_MATCHABLE` (422) — ORD-043. La línea no es de la orden
  //     en la que llegó el resultado, o está anulada. **Uno solo para las dos**
  //     porque lo que hay que hacer es idéntico: elegir otra línea de esta
  //     orden. Emparejar contra la línea de OTRA orden cerraría una línea con
  //     la sangre de otra persona, y **no hay `CHECK` que lo impida**: esta
  //     negativa, dentro de la transacción que escribe, es toda la garantía.
  'ORDER_ITEM_NOT_MATCHABLE',
  'RESULT_ALREADY_MATCHED',
  'RESULT_NOT_FOUND',
  // ─── Documents, H1 a H4 (DOC-012, DOC-014, DOC-037, DOC-050 a DOC-053).
  // El documento imprimible y el artefacto que queda.
  //
  // D-A-014. Hasta este módulo los documentos se «imprimían» desde el navegador
  // con `@media print`, que no produce NINGÚN artefacto: nada que guardar,
  // firmar, adjuntar al SRI, reimprimir idéntico ni enseñar a un inspector. La
  // Ley 67 art. 8(b) obliga a conservar «con el formato en el que se haya
  // generado», y la ACESS-2023-0030 art. 9 exige que la receta tenga «una copia
  // de respaldo para su archivo».
  //
  //   * `DOCUMENT_RENDER_NOT_FOUND` (404) — el documento archivado no existe, es
  //     de una sede fuera del alcance, o es de una clase que esta ruta no sirve.
  //     **Uno solo para las tres**, la línea de `PRESCRIPTION_NOT_FOUND`:
  //     distinguirlas confirmaría documentos ajenos a quien prueba
  //     identificadores de uno en uno. La tercera importa más de lo que parece:
  //     el RIDE se sirve con `billing:read` y la receta con `record:read`, y un
  //     identificador no dice de qué clase es lo que nombra.
  //   * `DOCUMENT_SUBJECT_NOT_FOUND` (404) — la receta, la orden, el certificado
  //     o la factura que se quiere imprimir no existe o está fuera del alcance.
  //     **No comparte código** con `PRESCRIPTION_NOT_FOUND` ni con
  //     `ORDER_NOT_FOUND`: ningún módulo importa de otro y dos clases no pueden
  //     declarar el mismo `code`. La frase sí se parece, porque lo que hay que
  //     hacer es lo mismo.
  //   * `DOCUMENT_SUBJECT_NOT_ISSUABLE` (409) — DOC-014. El origen todavía puede
  //     cambiar: un borrador de receta, una factura sin emitir. **No niega la
  //     previsualización**, que sigue devolviendo los mismos bytes; lo que niega
  //     es ARCHIVARLOS. Archivar un borrador produce dos ficheros que dicen
  //     cosas distintas y ninguno que sea «la receta».
  //   * `DOCUMENT_TEMPLATE_NOT_PUBLISHED` (422) — DOC-037. No hay ninguna
  //     versión de plantilla publicada para esa clase. 422 y no 500: no hay nada
  //     roto, falta un dato de la instalación, y el mensaje dice quién lo
  //     arregla y dónde. **Y no se inventa una por defecto**: una plantilla que
  //     sólo existe en el código es la versión que ninguna fila registra, así
  //     que el `sha256` de lo que produjera no sería reconstruible.
  //   * `DOCUMENT_TEMPLATE_SLOT_INVALID` (422) — DOC-035, DOC-036. Una ranura
  //     fuera de su forma: el color que no es `#rrggbb`, el séptimo campo de
  //     cabecera. El tope ES la ranura hecha regla; sin él, «unos pocos campos
  //     clave-valor» se convierte en la plantilla editable que D-A-015 rechaza.
  //   * `DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED` (422) — DOC-050, DOC-051. Ni SVG, ni
  //     GIF, ni WebP. **El SVG se rechaza a propósito y para siempre**: SÍ
  //     ejecuta scripts cuando se navega directamente a él, y hay CVE reales de
  //     robo de credenciales por esa vía. El formato se decide por los BYTES
  //     MÁGICOS, nunca por el `Content-Type`.
  //   * `DOCUMENT_IMAGE_TOO_LARGE` (422) — DOC-052, DOC-053. Por bytes **o** por
  //     píxeles, y el mensaje dice cuál. Son dos defensas distintas: un tope de
  //     bytes no ve una bomba de descompresión, donde 40 KB declaran
  //     30 000 × 30 000 píxeles.
  //   * `DOCUMENT_IMAGE_UNREADABLE` (422) — el fichero dice ser PNG o JPEG y no
  //     se puede decodificar. **No es el formato prohibido**: allí el formato
  //     era correcto y se rechaza, aquí se admite y el contenido está roto.
  //     Unirlos le diría a quien subió un PNG truncado que no se admite PNG.
  //   * `DOCUMENT_RENDER_FAILED` (503) — la composición del PDF falló. Es lo
  //     único de este módulo que es un fallo nuestro, y no lleva ningún detalle
  //     al llamador: una traza de un motor de PDF no le dice nada a una
  //     recepcionista y puede sacar el valor de un campo con ella.
  //   * `DOCUMENT_IMAGE_NOT_FOUND` (404) — DOC-061: no hay logo, sello o firma
  //     puestos. La pantalla dice «todavía no hay», no pinta una imagen rota.
  'DOCUMENT_IMAGE_FORMAT_NOT_ALLOWED',
  'DOCUMENT_IMAGE_NOT_FOUND',
  'DOCUMENT_IMAGE_TOO_LARGE',
  'DOCUMENT_IMAGE_UNREADABLE',
  'DOCUMENT_RENDER_FAILED',
  'DOCUMENT_RENDER_NOT_FOUND',
  'DOCUMENT_SUBJECT_NOT_FOUND',
  'DOCUMENT_SUBJECT_NOT_ISSUABLE',
  'DOCUMENT_TEMPLATE_NOT_PUBLISHED',
  'DOCUMENT_TEMPLATE_SLOT_INVALID',
  //   * `DOCUMENT_VERIFICATION_NOT_FOUND` (404) — DOC-096: ningún documento con
  //     ese código, o un código sin forma de código. **El mismo cuerpo para
  //     todos**: distinguirlos dejaría mapear qué códigos existen.
  'DOCUMENT_VERIFICATION_NOT_FOUND',
  // Protección de datos (`privacy`, PD-001..PD-043).
  //   * `DATA_SUBJECT_NOT_FOUND` (404) — la ficha no existe. Propio y no
  //     `PATIENT_NOT_FOUND`, que es de `patients`: un código lo declara una sola
  //     clase y ningún módulo importa a otro. Mismo mensaje, mismo porqué.
  //   * `CONSENT_TEXT_OUTDATED` (409) — se consiente una versión que dejó de ser
  //     la vigente: lo registrado debe ser lo que se mostró (PD-012).
  //   * `CONSENT_TEXT_VERSION_CONFLICT` (409) — dos publicaciones a la vez; la
  //     base deja pasar una (PD-005).
  //   * `DATA_REQUEST_ALREADY_ANSWERED` (409) — una respuesta es una sola
  //     (PD-033); la base tampoco admite otra (PD-038).
  'CONSENT_TEXT_INVALID',
  'CONSENT_TEXT_NOT_PUBLISHED',
  'CONSENT_TEXT_OUTDATED',
  'CONSENT_TEXT_VERSION_CONFLICT',
  'DATA_EXPORT_NOT_APPLICABLE',
  'DATA_REQUEST_ALREADY_ANSWERED',
  'DATA_REQUEST_NOT_FOUND',
  'DATA_REQUEST_RECEIVED_IN_FUTURE',
  'DATA_SUBJECT_NOT_FOUND',
] as const;

/**
 * The catalogue as a type. Nothing binds `DomainError.code` to it: what keeps
 * the classes and this list in step is `error-catalogue.spec.ts`.
 */
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
