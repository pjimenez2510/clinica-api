# SPEC — Módulo `configuration`

**Estado:** borrador para revisión · **Fecha:** 12 de agosto de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

Parámetros de operación: los números y las fechas que cambian el comportamiento
del sistema y que **nadie referencia desde una fila**. Nace de la instrucción
del usuario (12-08-2026): «quiero tener siempre la flexibilidad de poder cambiar
… todo eso… en otra clínica lo manejan diferente». Decisiones que lo gobiernan:
D-001, D-002.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Feriados, parámetros operativos por sede y política de retención — su
**administración**: crear, editar, desactivar, con garantías en la base y
bitácora.

> **Los textos de consentimiento ya no son de aquí** (30-09-2026). Cada
> consentimiento de un paciente referencia la versión del texto que firmó, y por
> la regla de ADR-011 lo que una fila referencia no es un parámetro: los posee
> `privacy` (PD-001 a PD-006).

Reducido a esto, el nombre por fin describe lo que contiene (ADR-011). Un
parámetro es un valor que cambia el comportamiento y que ninguna fila apunta;
en cuanto un dato es referenciado por el expediente, la factura o el reporte al
Estado, deja de ser parámetro y pertenece a su módulo dueño.

**Fuera de alcance, y ya no vive aquí (ADR-011, 12-08-2026):**

| Lo que se fue                                          | A dónde         |
| ------------------------------------------------------ | --------------- |
| Especialidades, tipos de atención y duraciones         | `specialties`   |
| Horarios de los profesionales                          | `staff`         |
| Sedes, consultorios y establecimiento                  | `organization`  |

> **Los identificadores `CF-001` a `CF-028` y `CF-040` a `CF-046` están
> retirados en este documento.** Se renumeraron a `SP-###` y `ST-###` al mudarse
> con su material; ADR-011 autoriza la excepción y explica por qué era posible
> hacerlo entonces y no dos entregas después. `CF-060` a `CF-066` **conservan su
> numeración exacta**: nunca salieron de aquí. Un número retirado no se reutiliza.

**Tampoco:** cómo la agenda **obedece** un feriado al reservar — eso vive en el
SPEC de `agenda` (AG-031 a AG-033, AG-090 a AG-098, AG-102). Ni los permisos
(módulo `auth`), ni los catálogos clínicos CIE-10/CNMB (módulo `catalogs`).

> **Varios requisitos de `agenda` se ADMINISTRAN desde aquí, y no se reescriben
> aquí** (14-08-2026, al implementar E7 y E4). Hay una sola especificación para
> todo el sistema: quien manda un feriado como laborable para una sede
> (**AG-092**), abre la reserva en el pasado (**AG-031**, **AG-094**) o decide
> si la sede admite sobrecupos y qué permiso los autoriza (**AG-039**,
> **AG-101**, **AG-094**) usa la superficie de
> este módulo, porque este módulo es el dueño del catálogo de feriados y de la
> fila de parámetros. Duplicarlos como `CF-###` sería tener dos textos que
> describen lo mismo, y dos textos discrepan en semanas. Las pruebas de esa
> superficie citan los `AG-###` originales.

**Depende de:** `auth` (permiso de administración, D-002) y de `organization`,
porque un parámetro y un feriado se declaran **por sede**.

## Vocabulario

| Término              | Significado exacto en este módulo                                                        |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Feriado**          | Fecha no laborable con nombre y alcance: una sede o todas                                 |
| **Parámetro de sede**| Valor operativo editable por sede: antelaciones, tope de sobrecupos, retención (D-001)   |
| **Alcance**          | De un feriado: `una sede` o `todas`. Es lo que lo hace único junto con la fecha           |
| **Retención**        | Cuánto tiempo se conservan las citas anuladas antes de purgarlas, si es que se purgan     |

---

## Entregas priorizadas

### C3 — Feriados y parámetros por sede _(P2)_

Feriados editables y los parámetros de D-001 por sede, con sus defectos.

**Por qué es P2:** la agenda arranca con los valores por defecto de D-001; lo
que esta entrega añade es poder cambiarlos sin desplegar.
**Prueba independiente:** cambiar la antelación máxima de una sede y comprobar
que rige para reservas nuevas y no revalida ni anula lo ya reservado.
**Cubre:** CF-060 a CF-067.

**Solo servidor:** CF-063, CF-066 y CF-067. El primero es una afirmación sobre
la SUPERFICIE de la API —qué no se expone— y se prueba en negativo contra el
contrato; el segundo es una escritura en la bitácora. Una pantalla no puede
enseñar lo que no existe ni leer un registro que no le pertenece. El tercero es
alcance por sede sobre una escritura, y quien lo burla no usa la pantalla.

---

## Requisitos

### Feriados y parámetros por sede (REQ-145, D-001)

- **CF-060** — El sistema DEBERÁ mantener feriados con fecha, nombre y alcance
  (una sede o todas), editables con el permiso de administración.
- **CF-061** — El sistema DEBERÁ impedir dos feriados con la misma fecha y el
  mismo alcance, con la garantía en la base.
- **CF-062** — El sistema DEBERÁ mantener por sede: antelación mínima y máxima
  de reserva, tope de sobrecupos por profesional y día, **turno de la agenda**
  y política de retención de anuladas, con los valores de D-001 como defecto al
  crear la sede.
  > **El turno de la agenda (`slot_atom_minutes`) entró el 14-08-2026 con
  > D-021.** Es el **átomo** de la agenda: el incremento en que la sede trocea
  > su jornada. Todos los cupos que la agenda ofrece duran eso, y **toda
  > duración configurable —la base de un especialidad·tipo (SP-021) y la
  > excepción de un médico (SP-022)— tiene que ser múltiplo suyo**. Antes vivía
  > en `practitioner_schedule_rule.slot_minutes`, un número libre por regla que
  > tenía que casar con otro número libre por tipo de atención sin que nada los
  > obligara: la base ya tenía rejillas de 20 y 30 con tipos de 10, 20 y 30, y
  > un tipo de 20 sobre cupos de 30 era **imposible de reservar** sin que
  > ninguna pantalla lo cruzara.
  >
  > **Valor de arranque 10 minutos**, rango 5..60 **de cinco en cinco**. El paso
  > de 5 no es ceremonia: `service_type_duration_range` y
  > `duration_exception_range` exigen múltiplos de 5 y un `CHECK` no puede
  > consultar `site_parameter`, así que restringir el átomo a múltiplos de 5
  > convierte esa regla local en **consecuencia** de la regla fina en vez de un
  > resto que la contradice.
  >
  > **Cambiar el átomo se valida contra lo ya guardado**, y es la otra mitad de
  > la garantía: hacer múltiplos a las duraciones cierra la puerta por la que
  > entran las duraciones, no la puerta por la que entra el átomo. Mover una
  > sede a turnos de 20 con tipos de 30 configurados se rechaza con
  > `PARAM_OUT_OF_RANGE` **nombrando las duraciones que estorban**. Se consultan
  > `service_type` y `duration_exception`, tablas de otros módulos, por un
  > puerto propio — igual que `agenda` lee `service_type`.
- **CF-063** — El sistema NO DEBERÁ exponer como parámetro aquello cuya garantía
  se perdería al configurarlo: no-solapamiento, inmutabilidad del historial,
  cierre por defecto (REQ-146).
- **CF-064** — CUANDO cambie un parámetro, el cambio DEBERÁ regir solo para
  operaciones posteriores; el sistema NO DEBERÁ revalidar ni anular lo ya
  reservado.
- **CF-065** — SI un parámetro llega fuera de su rango declarado, ENTONCES el
  sistema DEBERÁ rechazarlo con `PARAM_OUT_OF_RANGE` nombrando el rango.
- **CF-066** — Toda mutación de feriados y parámetros DEBERÁ quedar en la
  bitácora con autor, instante y valor anterior.
  > **El valor anterior existe desde el 14-08-2026 — `D-017`, opción A
  > revisada.** `access_audit` lleva `before` y `after` (`jsonb`) y este módulo
  > los escribe con la vista de dominio —fecha, nombre y alcance de un feriado;
  > las cuatro cifras y las dos banderas de una sede—, nunca con la fila del ORM.
  > Se leen **dentro de la misma transacción que escribe**, con `FOR UPDATE`: un
  > «desde qué valor» leído antes de la llamada ya está caducado, y dos
  > administradores guardando a la vez registrarían cada uno un valor que el
  > otro ya había reemplazado.
  >
  > **Qué protege que esto no sea una puerta abierta:**
  > `access_audit_payload_only_for_declared_resources` obliga a que las dos
  > columnas sean nulas salvo para los tipos de recurso declarados, hoy sólo
  > `'configuration'`. La historia clínica no está en la lista a propósito —la
  > bitácora de accesos no puede convertirse en una copia permanente e imborrable
  > de lo que vigila— y ampliarla es una decisión sobre datos personales.
  > AG-097 pide lo mismo que este requisito y queda cubierto por lo mismo.

- **CF-067** — CUANDO se cree, edite o borre un feriado, el sistema NO DEBERÁ
  admitir un alcance fuera del alcance de quien llama —ni el que se fija ni el
  que el feriado ya tenía—; y MIENTRAS el feriado sea **de todas las sedes**
  (`siteId` nulo), sólo DEBERÁ admitirlo de quien tenga `settings:manage`
  concedido a nivel de clínica. SI no se cumple, ENTONCES DEBERÁ rechazarlo con
  `SITE_SCOPE_DENIED` sin escribir nada y sin nombrar ninguna sede.
  > **D-023, cerrado el 15-08-2026.** Mismo agujero y misma causa que ST-047 y
  > ST-048 en `staff`: las rutas declaran `global`, el alcance del feriado viaja
  > **en el cuerpo**, y el guard sólo sabe leer `param:` y `query` porque corre
  > antes de los pipes. Familia de **AG-105**. La declaración pasa a `'query'`,
  > que es lo que significa «hay dimensión de sede y la estrecha el handler», y
  > `route-authorisation.spec.ts` no podía verlo: comprueba que la declaración
  > exista, no que sea la correcta.
  >
  > **POR QUÉ UN FERIADO NACIONAL EXIGE ALCANCE DE CLÍNICA.** Un feriado con
  > `site_id IS NULL` no es «un feriado sin sede»: es el feriado que **todas**
  > obedecen. La agenda lo lee al reservar y cierra el día (AG-015, AG-090), así
  > que crear uno, renombrarlo o moverle la fecha **cierra o abre la agenda de
  > cada sede de la clínica**, incluidas las que se abran después. Eso es un
  > acto de alcance global, y el único alcance que lo contiene es tener el
  > permiso concedido a nivel de clínica (`user_role_grant.site_id IS NULL`).
  > Quien administra Norte no cierra la agenda de Sur ni por acción directa ni
  > declarando nacional un feriado suyo.
  >
  > Borrar un nacional es la misma potencia con el signo cambiado: **abre** el
  > día en todas las sedes. Por eso las tres escrituras se comprueban igual,
  > incluida `DELETE`, que D-023 no enumeraba porque su alcance no viaja en el
  > cuerpo sino en la fila — se lee y se comprueba.
  >
  > **Los dos extremos, como ST-047.** Editar mueve el alcance, y las dos
  > puntas del movimiento cambian una agenda: pasar un feriado de nacional a
  > Norte **reabre** el día en todas las demás, y pasar el de Norte a nacional
  > lo cierra en todas. Ninguna de las dos la decide quien sólo administra una
  > sede.
  >
  > **Lo que NO cambia.** El listado (`GET /holidays`) sigue siendo `global` y
  > sin estrechar, y es deliberado: las filas con `site_id IS NULL` no
  > pertenecen a ninguna sede y toda sede las obedece, así que filtrarlas por
  > el alcance de quien llama escondería justo los feriados que le aplican.
  > Leer el calendario no cierra la agenda de nadie. Las rutas de AG-092
  > (`worked-by/{siteId}`) tampoco cambian: su sede está en la URL y el guard ya
  > las resuelve con `param:siteId`.

---

## Códigos de error

| Código                      | HTTP | Cuándo                                                     |
| --------------------------- | ---- | ---------------------------------------------------------- |
| `HOLIDAY_DUPLICATE`         | 409  | Feriado repetido en fecha y alcance (CF-061)               |
| `HOLIDAY_NOT_FOUND`         | 404  | El feriado indicado no existe                              |
| `SITE_SCOPE_DENIED`         | 403  | Tocar un feriado de otra sede, o uno de todas sin alcance de clínica (CF-067, ADR-007) |
| `PARAM_OUT_OF_RANGE`        | 422  | Parámetro fuera de rango, nombrándolo (CF-065)             |
| `SITE_PARAMETERS_NOT_FOUND` | 404  | La sede indicada no tiene fila de parámetros (CF-062)      |

`SITE_NOT_FOUND` **no** se emite desde aquí aunque sea lo que un lector
esperaría: ese código es de `organization`, dueño de la sede, y dos clases
respondiendo el mismo código son dos situaciones que el cliente no puede
distinguir —hay una prueba del catálogo que lo impide—. Lo que este módulo
puede afirmar con honestidad es que la sede no tiene parámetros.

## Notas de esquema

Tablas de este módulo: `holiday` y `site_parameter`, creadas por
`20260813040610_configuration_holidays_and_site_parameters`, más
`holiday_site_exception` y la columna `site_parameter.allow_past_booking`, que
añadió `20260814131942_agenda_site_operating_rules` para AG-092 y AG-031.

- **`holiday_site_exception` es una fila por sede que trabaja el feriado**
  (AG-092), no una bandera en `holiday`: «laborable para quién» son N sedes por
  feriado. Se administra desde `PUT`/`DELETE
  /configuration/holidays/{id}/worked-by/{siteId}`, con `settings:manage` y
  alcance sobre esa sede, y el feriado la lleva consigo al listarse. Marcar dos
  veces no es conflicto: la clave primaria ES el par. La sede inexistente la
  rechaza la clave foránea y se responde `SITE_NOT_FOUND`, que es el código de
  `organization` traducido desde PostgreSQL, no una clase de error de aquí.
- **`allow_past_booking` es un parámetro de sede más** (AG-031, AG-094): un
  booleano, así que no tiene rango y CF-065 no lo toca. Nace en `false` porque
  abrir el pasado es una decisión de la sede.
- **`overbooking_enabled` y `overbooking_permission`** (AG-039, AG-101, AG-094)
  entraron el 14-08-2026 con `agenda_overbooking_authorisation`, que es la
  entrega E4 de `agenda` — la que los LEE. Es lo que D-018 decidió: cada
  parámetro entra con su entrega, no antes.
  - El interruptor nace en **`true`**, al revés que `allow_past_booking` y a
    propósito (D-005): el sobrecupo es la vía documentada de romper la rejilla,
    y una sede que lo tuviera cerrado de fábrica resolvería las urgencias fuera
    del registro. Lo que lo limita es `overbooking_cap`, que ya existía.
  - **El permiso es el único CÓDIGO DE PERMISO que este esquema guarda como
    dato**, y por eso se cierra por tres lados: `UNKNOWN_PERMISSION` (422) si
    `permission.catalogue.ts` no lo declara —qué permisos existen es código—,
    `PERMISSION_NOT_INSTALLED` (409) si esta instalación aún no lo ha sembrado,
    y una clave foránea contra `permission (code)` para lo que llegue por otro
    camino. Sin eso, una errata como `agenda:overbok` se guarda sin protesta y
    la sede se queda sin poder autorizar ningún sobrecupo **sin que nada lo
    diga**. Los dos códigos son los de AU-033 y viven en
    `shared/domain/errors/permission.errors.ts` desde esta entrega: dos clases
    respondiendo un mismo `code` son dos situaciones que el cliente no puede
    distinguir.
  - **CF-063 no los excluye**, y el segundo merece decirse porque parece que
    debería: elegir QUIÉN autoriza una excepción no configura la excepción. El
    `EXCLUDE` sigue en pie, la constancia del sobrecupo es un `CHECK`, y la
    separación entre quien reserva y quien autoriza (AG-103) no es parámetro.
- **`slot_atom_minutes` también** (D-021, CF-062), y sí tiene rango:
  `site_parameter_slot_atom_minutes_range` exige 5..60 en múltiplos de 5. Nació
  en la misma migración que la tabla —no hay producción y una migración se
  corrige donde nació, no se apila encima (ADR-010, `database-phase.mjs`)—.
  Que **CF-063 no lo excluya** es deliberado: configurarlo no pierde ninguna
  garantía; al revés, es lo que hace que AG-012 y AG-104 no puedan fallar por
  configuración.

- **CF-061 es `UNIQUE NULLS NOT DISTINCT (date, site_id)`**, no un `UNIQUE`
  corriente: en PostgreSQL dos `NULL` nunca son iguales, así que un índice
  normal dejaría sin restringir justo la fila «feriado de todas las sedes», que
  es la que obedecen todas. La sintaxis existe desde PostgreSQL 15 y esta
  instalación es la 18, así que un solo índice cubre los dos alcances; la
  alternativa clásica —dos índices parciales— haría lo mismo con dos nombres de
  constraint viajando al cliente. **Prisma no sabe expresarlo**, así que vive en
  la migración, como los `EXCLUDE`.
- **Los defectos de D-001 los escribe la base**, con el disparador
  `trg_site_parameter_defaults` sobre `site`. `organization` es el dueño de la
  sede y no debe conocer las tablas de este módulo (ADR-011), y una sede creada
  por una importación tiene que quedar igual de parametrizada.
- `holiday.site_id` y `site_parameter.site_id` borran **en cascada**, contra la
  regla general de `ON DELETE RESTRICT` de este esquema. Ninguna de las dos
  filas es evidencia de nada ni la referencia nadie, y con RESTRICT ninguna sede
  podría borrarse jamás (OR-006), porque el disparador les crea la fila de
  parámetros a todas.
- La retención es el tipo enumerado `cancelled_retention_policy` con **un solo
  valor**, `NEVER` (D-001, D-004). Es enumeración y no booleano para que añadir
  un purgado futuro sea `ALTER TYPE … ADD VALUE` y una columna, no reescribir la
  columna y todas las filas.
