# SPEC — Módulo `identity-lookup`

**Estado:** borrador · **Fecha:** 10 de octubre de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

Proponer los nombres de una persona a partir de su cédula, para que recepción
no los teclee —ni los teclee mal— con el paciente delante. Nace de D-079 («la
cédula primero») y de **D-206**, aceptada por el autor el 10-10-2026: un módulo
dentro de la API, detrás de un puerto con un adaptador por fuente, que **nunca
bloquea** el alta y **nunca** elude un captcha.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee**:

- el puerto `IdentityLookup.findByCedula()` y sus adaptadores: el **catastro
  de RUC del SRI importado a una tabla local** y el **proveedor con contrato**
  (Didit hoy; DIGERCIC sería otro adaptador del mismo puerto);
- la tabla del catastro importado (`sri_ruc_registry_entry`) y sus versiones
  (`sri_ruc_registry_import`), y el script que la importa;
- la caché de lo que devuelve el proveedor (`identity_lookup_cache`);
- el interruptor que enciende las fuentes externas (`identity_lookup_setting`).

**Fuera de alcance:**

- **La propia base** —la cédula que ya es de un paciente—: es PA-072 en
  `patients`, y la pantalla la consulta **antes** que este módulo. No se
  duplica aquí.
- **La ficha.** Este módulo propone; quien registra es `patients`, con la
  misma alta de siempre (PA-001). Nada de lo propuesto se guarda en la ficha
  sin pasar por esa alta.
- **Prohibido, y no sólo fuera de alcance** (D-206, «Decisión»): resolver o
  eludir un captcha, enviar una cabecera que lo dé por resuelto, llamar a
  `sri-registro-civil-servicio-internet`, hacer scraping de un portal y
  construir el endpoint interno `ConsultaRuc/obtenerPorNumerosRuc`. Ningún
  adaptador de este módulo habla con el SRI ni con el Registro Civil: el
  catastro llega como **archivo descargado** por una persona.
- La consulta en lote. Una consulta es de una cédula, de un paciente presente.

**Depende de:** `auth` (permiso y quién pregunta) y de la bitácora compartida
(`shared/audit`). Ningún módulo depende de éste: la pantalla de alta lo llama.

## Por qué se guardan datos de terceros (LOPDP)

Lo que este módulo guarda son datos de personas que **todavía no son
pacientes**, y por eso cada tabla lleva su motivo:

| Tabla                    | Qué guarda                                                         | Por qué                                                                                                                                                                                                                                            | Cuánto                             |
| ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `sri_ruc_registry_entry` | cédula y el nombre tal como lo publica el catastro                 | Es un dato abierto que el SRI publica para descargar; tenerlo local evita cualquier consulta a un tercero por cada paciente. Sólo personas naturales y **sólo** cédula y nombre: actividad, dirección y estado tributario se descartan al importar | Hasta la siguiente importación     |
| `identity_lookup_cache`  | nombres, apellidos y fecha de nacimiento que devolvió el proveedor | Para no pagar ni repetir la consulta del mismo paciente en su primera semana (alta, cita, llegada)                                                                                                                                                 | **30 días**, y la vencida se borra |
| `access_audit`           | quién consultó, cuándo, qué fuente, y un HMAC de la cédula         | Responder «¿quién me buscó y dónde?» (derecho de acceso) sin guardar la cédula en claro                                                                                                                                                            | Como toda la bitácora              |

La base legal es la de D-206 §3 —relación asistencial con el paciente
presente, art. 7 LOPDP— y **la confirma el asesor legal** antes de encender
nada: por eso las fuentes externas nacen apagadas (IL-002). La SPDP aclaró en
2026 que un dato de fuente pública no se usa libremente (oficio
SPDP-IRD-2026-0242-O): el catastro también va detrás del interruptor.

## Vocabulario

| Término                 | Significado exacto en este módulo                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Propuesta**           | Nombres, apellidos y, si la fuente la trae, fecha de nacimiento, con la fuente y el instante. Nunca se guarda en la ficha por sí sola |
| **Fuente externa**      | Una que no es la propia base: el catastro importado y el proveedor                                                                    |
| **Catastro**            | El catastro de RUC del SRI, descargado en CSV por provincia e importado a `sri_ruc_registry_entry`                                    |
| **Nombre del catastro** | El campo único «APELLIDOS NOMBRES» (`RAZON_SOCIAL`) de una persona natural, tal como viene                                            |
| **Orden por revisar**   | La marca de una propuesta cuyo reparto entre apellidos y nombres es una convención y no un dato de la fuente (D-209)                  |
| **Proveedor**           | Un servicio con contrato que responde por cédula desde el Registro Civil (Didit, DIGERCIC)                                            |
| **Interruptor**         | `identity_lookup_setting.external_sources_enabled`: uno para toda la clínica, apagado de fábrica                                      |
| **Digesto**             | HMAC-SHA256 de la cédula con `IDENTITY_LOOKUP_DIGEST_KEY`: identifica a la persona en la bitácora y la caché sin escribir su número   |

---

## Entregas priorizadas

### E1 — Proponer los nombres por la cédula _(P1, 10-10-2026)_

D-206: en el alta, tras una cédula válida que no tiene ficha, los nombres
aparecen propuestos desde el catastro o el proveedor, marcados y editables. El
interruptor se enciende en Parámetros cuando el asesor legal lo confirme.

**Por qué es P1:** cada nombre tecleado a mano con el paciente delante es un
error posible en una ficha que sale en recetas, certificados y el RDACAA, y un
duplicado posible cuando el mismo paciente vuelve escrito de otra forma.
**Prueba independiente:** importar el CSV de muestra, encender el interruptor y
pedir la propuesta de una cédula suya: llegan los cuatro nombres con la marca
de orden y queda una fila en la bitácora sin la cédula; con el interruptor
apagado no se consulta nada.
**Cubre:** IL-001 a IL-012.
**Solo servidor:** IL-006, IL-007, IL-008, IL-009. La bitácora, la caché, el
adaptador sin credenciales y la importación no se ven en una pantalla.
**Solo interfaz:** IL-012. Qué campos se rellenan, cuáles no se pisan y la
marca los decide el navegador; el servidor devuelve la misma propuesta.

## Criterios de éxito

- **SC-086** — Con el interruptor apagado, el número de consultas a una fuente
  externa es **cero**, sea cual sea el número de altas.
- **SC-087** — Ninguna fila de la bitácora, línea de log ni mensaje de error
  del módulo contiene una cédula en claro ni un nombre propuesto.
- **SC-088** — Pedir una propuesta nunca tarda más de **3,5 s** en responder,
  aunque el proveedor no conteste.

## Supuestos

- El catastro se descarga a mano del sitio del SRI (D-206) y lo importa una
  persona con `pnpm db:import:sri-ruc`. El diccionario oficial de columnas
  (SRI_RUC_DD) **no se leyó** al construir —esta rama no entra al sitio del
  SRI—, así que el importador lee por **cabeceras** y no por posición, y quien
  importe el primer archivo real lo contrasta con ese diccionario.
- Una persona natural con RUC tiene por RUC su cédula seguida de `001`.
- El nombre del catastro sigue el orden de la cédula ecuatoriana: apellidos y
  luego nombres. Es una convención, no una garantía (IL-005).

---

## Requisitos

### 1. La consulta (D-206 §1 y §2)

- **IL-001** — CUANDO alguien con `patient:write` pida la propuesta de una
  cédula ecuatoriana válida **y** el interruptor esté encendido, el sistema
  DEBERÁ consultar las fuentes externas **en este orden** —el catastro
  importado y, si está configurado, el proveedor— y DEBERÁ devolver la de la
  **primera** que tenga dato: primer y segundo apellido, primer y segundo
  nombre, el nombre tal como lo escribió la fuente, la fecha de nacimiento si
  la fuente la trae, la fuente y el instante de la consulta. SI ninguna tiene
  dato, ENTONCES DEBERÁ responder que no hay propuesta, con el mismo `200`.
  > La propia base va antes, y no aquí: es PA-072 en la pantalla. Un `404`
  > para «sin dato» haría de una ausencia normal un error que el navegador
  > anunciaría en rojo; aquí no tener propuesta es lo corriente.
- **IL-002** — MIENTRAS el interruptor esté **apagado** —que es como nace, y
  como queda si su fila no existe—, **o** falte `IDENTITY_LOOKUP_DIGEST_KEY`,
  el sistema NO DEBERÁ consultar ninguna fuente externa y DEBERÁ responder que
  no hay propuesta, sin escribir en la bitácora.
  > D-206 §3: se encienden cuando el asesor legal confirme. Una fila ausente
  > se lee como apagado: lo que no se declaró no se enciende (REQ-118).
- **IL-003** — **SI** una fuente falla, o tarda más de **3 segundos**,
  **ENTONCES** el sistema DEBERÁ pasar a la siguiente o responder que no hay
  propuesta, y NO DEBERÁ responder con error ni repetir la consulta.
  > Nunca bloquea (D-206 §2): si no hay propuesta, se escribe a mano como
  > siempre. El fallo queda en el log sin cédula ni nombre (REQ-116).
- **IL-004** — **SI** el número pedido no es una cédula ecuatoriana válida
  (`Cedula`, PA-011), **ENTONCES** el sistema DEBERÁ rechazarlo con `422`
  señalando el campo `cedula`, y NO DEBERÁ consultar ninguna fuente.
- **IL-005** — CUANDO la propuesta venga del **catastro**, el sistema DEBERÁ
  devolver el nombre tal como viene y, además, repartido según el orden de la
  cédula ecuatoriana —primero los apellidos, luego los nombres, con las
  partículas («DE», «DEL», «DE LA», «DE LOS», «SAN», «Y») unidas a la palabra
  que sigue—, con mayúscula inicial y las partículas en minúscula salvo al
  empezar el campo («De la Torre», «Rosa»), y DEBERÁ marcarla con **orden por
  revisar**; CUANDO venga de una
  fuente que separa apellidos y nombres, NO DEBERÁ marcarla.
  > D-209 sigue pendiente: no se adivina sin decirlo. El catastro trae un solo
  > campo, y «DE LA TORRE ALBA MARIA JOSE» no se reparte sin una regla; la
  > regla se aplica y la pantalla lo dice (IL-012).

### 2. La bitácora y la caché (D-206 §2)

- **IL-006** — CUANDO se consulte una fuente externa, el sistema DEBERÁ dejar
  en `access_audit` una entrada con quién, cuándo, la fuente
  (`identity_lookup:sri_ruc_registry` o `identity_lookup:provider`) y el
  **digesto** de la cédula, haya o no dato, y NO DEBERÁ escribir la cédula en
  claro ni el nombre devuelto en la bitácora ni en el log.
  > Una respuesta de la caché también es una consulta, y queda con la fuente
  > `identity_lookup:provider`: el dato es del proveedor.
- **IL-007** — CUANDO el proveedor devuelva un dato, el sistema DEBERÁ
  guardarlo en la caché **30 días** con el reloj de la aplicación y DEBERÁ
  responder desde ella sin volver a llamarle; y NO DEBERÁ devolver una entrada
  vencida, que DEBERÁ borrar al encontrarla y al escribir otra. La base DEBERÁ
  rechazar una entrada que venza antes de guardarse o más de 90 días después.
  > 30 y no 90: el extremo bajo del rango de D-206, porque cuanto menos dura
  > un dato de tercero, menos hay que justificar. El techo de 90 días es el
  > de D-206, y lo guarda la base.

### 3. Las fuentes (D-206 §1)

- **IL-008** — El adaptador del proveedor NO DEBERÁ existir sin
  `IDENTITY_PROVIDER_API_KEY` y `IDENTITY_PROVIDER_URL`; y **SI** la URL no es
  local **y** `IDENTITY_PROVIDER_ALLOW_REMOTE` no es `true`, **ENTONCES** la
  aplicación NO DEBERÁ arrancar.
  > La misma guarda que el SRI (`SRI_ALLOW_REMOTE`): un `.env` copiado no
  > llama a un servicio de pago ni manda cédulas fuera por descuido.
- **IL-009** — CUANDO se importe un archivo del catastro, el sistema DEBERÁ
  guardar sólo las **personas naturales** —RUC de trece dígitos que es una
  cédula válida seguida de `001`— con su cédula y su nombre, una vez por
  cédula, y DEBERÁ registrar la versión importada con el SHA-256 del archivo,
  su nombre y cuántas filas guardó; **SI** ese mismo archivo ya se importó,
  **ENTONCES** NO DEBERÁ cambiar nada. La base DEBERÁ rechazar una cédula que
  no tenga diez dígitos, un nombre vacío y dos versiones con el mismo SHA-256.
  > Idempotente para que repetirlo no cueste nada. Un archivo de otra
  > provincia es otra versión y suma sus filas; una cédula que reaparece se
  > actualiza con el nombre del archivo más reciente.

### 4. El interruptor y quién consulta (D-206 §3)

- **IL-010** — Con `settings:read` se DEBERÁ poder leer el interruptor y el
  estado de las fuentes —la última versión del catastro con su fecha y sus
  filas, si hay proveedor configurado y si falta la clave del digesto—; y con
  `settings:manage` se DEBERÁ poder encenderlo o apagarlo, dejando en la
  bitácora de `configuration` quién, cuándo, desde qué valor y a cuál. La base
  DEBERÁ admitir una sola fila de ajuste.
  > Uno para toda la clínica y no por sede: la ficha es de toda la clínica y
  > el alta desde Pacientes no tiene sede activa.
- **IL-011** — La consulta DEBERÁ exigir `patient:write` —quien registra—, DEBERÁ
  recibir **una** cédula por petición y NO DEBERÁ admitir más de **20 por
  minuto** desde el mismo origen.
  > «Ninguna consulta en lote» (D-206): una por paciente presente. Veinte por
  > minuto es holgado para un mostrador y corta un recorrido automático.

### 5. En el alta (Solo interfaz)

- **IL-012** — CUANDO en el alta se teclee una cédula válida que **no** tenga
  ficha (PA-072) y haya propuesta, el formulario DEBERÁ rellenar los apellidos
  y nombres **vacíos** —y la fecha de nacimiento, si viene y está vacía— con
  una marca «Propuesto desde <fuente>; revíselo», y «revise el orden» si la
  propuesta lo lleva; NO DEBERÁ pisar lo que ya se tecleó; DEBERÁ dejar los
  campos editables y ofrecer quitar lo propuesto; y CUANDO cambie la cédula,
  DEBERÁ retirar lo propuesto que nadie tocó. Sin propuesta, nada cambia.
  > El nombre propuesto nunca se guarda sin que recepción lo vea: se guarda
  > con «Registrar», como cualquier otro campo.

## Códigos de error

Ninguno nuevo. La cédula inválida responde `VALIDATION_FAILED` con el campo
`cedula` (IL-004), como cualquier cuerpo mal formado; un fallo de fuente no es
un error para el cliente (IL-003).

## Notas de esquema

Migración `20261021000000_identity_lookup`:

- `identity_lookup_setting` — fila única (`id boolean PRIMARY KEY CHECK (id)`).
- `sri_ruc_registry_import` — `file_sha256` único, `file_name`, `rows_imported`,
  `imported_at`.
- `sri_ruc_registry_entry` — `cedula char(10)` clave, `registry_name`,
  `import_id`.
- `identity_lookup_cache` — `cedula_digest char(64)` clave, nombres, fecha,
  `fetched_at`, `expires_at` con `CHECK` de 0 < vencimiento ≤ 90 días.

Ninguna entra en `record_version`: no son historia clínica.

## Rutas

| Método | Ruta                         | Permiso           | Requisitos              |
| ------ | ---------------------------- | ----------------- | ----------------------- |
| `POST` | `/identity-lookup/proposals` | `patient:write`   | IL-001 a IL-007, IL-011 |
| `GET`  | `/identity-lookup/settings`  | `settings:read`   | IL-010                  |
| `PUT`  | `/identity-lookup/settings`  | `settings:manage` | IL-010                  |

`POST` y la cédula en el **cuerpo**, no en la ruta: una ruta acaba en los logs
de acceso de cualquier proxy, y la cédula de un tercero no tiene que estar ahí.

## Trazabilidad

| Requisito                              | Nivel de prueba                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| IL-001, IL-002, IL-003, IL-006, IL-007 | Unitario del servicio con dobles y reloj inyectado + integración HTTP contra PostgreSQL (`identity-lookup-http`) |
| IL-004, IL-011                         | Integración HTTP: el 422 con el campo y el 403 sin `patient:write`                                               |
| IL-005                                 | Unitario de dominio (`registry-name.spec.ts`)                                                                    |
| IL-007, IL-009, IL-010 (base)          | Integración contra PostgreSQL (`identity-lookup-schema`), con control positivo                                   |
| IL-008                                 | Unitario del adaptador contra un servidor HTTP local + `env.schema.spec.ts`                                      |
| IL-009                                 | Unitario del lector del CSV + integración de la importación                                                      |
| IL-010                                 | Integración HTTP con la bitácora de `configuration`                                                              |
| IL-012                                 | Componente en el arnés de la web (`NewPatientForm.spec.ts`) y recorrido F-01                                     |

## Preguntas abiertas

- Ninguna bloquea. El reparto del nombre sigue siendo D-209; la base legal,
  el asesor (D-206 §3); el endpoint de RUC, el «sí» del autor (D-206).
