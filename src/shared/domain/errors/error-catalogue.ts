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
  'ACCOUNT_INACTIVE',
  // Agenda, E2. Los cuatro son la máquina de estados de la cita (SPEC §5) y
  // responden cosas distintas a propósito: la transición no está en la tabla
  // (409, el estado actual la rechaza), la cita ya tiene atención registrada
  // (409, AG-045), la inasistencia se pidió antes de la hora de inicio (422,
  // AG-043 — código fijado por la implementación, la spec no lo nombra), y la
  // entrada no existe o es de otra sede (404, un solo mensaje para ambas:
  // distinguirlas confirmaría citas ajenas a quien adivina identificadores).
  'AGENDA_ENTRY_HAS_ENCOUNTER',
  'AGENDA_ENTRY_NOT_FOUND',
  'INVALID_AGENDA_TRANSITION',
  'NO_SHOW_BEFORE_START',
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
  'OVERBOOKING_REASON_REQUIRED',
  'SELF_AUTHORISATION_DENIED',
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
  'EMISSION_POINT_NOT_FOUND',
  'ESTABLISHMENT_NOT_FOUND',
  'MSP_UNICODE_DUPLICATE',
  'SITE_IN_USE',
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
  'SESSION_USER_MISSING',
  'SITE_SCOPE_DENIED',
  // Agenda: la hora de inicio no cae en el borde de un cupo de la regla. Es
  // distinto de `INVALID_SLOT_DURATION` a propósito: una cita de 08:10 a 08:30
  // dura exactamente un cupo y aun así parte la rejilla en dos huecos que ya
  // nadie puede reservar. Lo que hay que corregir es la hora de inicio, no la
  // de fin, y un solo código obligaría a leer el texto para saber cuál.
  'SLOT_NOT_ALIGNED',
  'WEAK_PASSWORD',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
