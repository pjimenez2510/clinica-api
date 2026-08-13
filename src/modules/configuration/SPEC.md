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

Feriados, parámetros operativos por sede, política de retención y textos de
consentimiento — su **administración**: crear, editar, desactivar, con garantías
en la base y bitácora.

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
**Cubre:** CF-060 a CF-066.

**Solo servidor:** CF-063, CF-066. El primero es una afirmación sobre la
SUPERFICIE de la API —qué no se expone— y se prueba en negativo contra el
contrato; el segundo es una escritura en la bitácora. Una pantalla no puede
enseñar lo que no existe ni leer un registro que no le pertenece.

---

## Requisitos

### Feriados y parámetros por sede (REQ-145, D-001)

- **CF-060** — El sistema DEBERÁ mantener feriados con fecha, nombre y alcance
  (una sede o todas), editables con el permiso de administración.
- **CF-061** — El sistema DEBERÁ impedir dos feriados con la misma fecha y el
  mismo alcance, con la garantía en la base.
- **CF-062** — El sistema DEBERÁ mantener por sede: antelación mínima y máxima
  de reserva, tope de sobrecupos por profesional y día, y política de retención
  de anuladas, con los valores de D-001 como defecto al crear la sede.
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

---

## Códigos de error

| Código                      | HTTP | Cuándo                                                     |
| --------------------------- | ---- | ---------------------------------------------------------- |
| `HOLIDAY_DUPLICATE`         | 409  | Feriado repetido en fecha y alcance (CF-061)               |
| `HOLIDAY_NOT_FOUND`         | 404  | El feriado indicado no existe                              |
| `PARAM_OUT_OF_RANGE`        | 422  | Parámetro fuera de rango, nombrándolo (CF-065)             |
| `SITE_PARAMETERS_NOT_FOUND` | 404  | La sede indicada no tiene fila de parámetros (CF-062)      |

`SITE_NOT_FOUND` **no** se emite desde aquí aunque sea lo que un lector
esperaría: ese código es de `organization`, dueño de la sede, y dos clases
respondiendo el mismo código son dos situaciones que el cliente no puede
distinguir —hay una prueba del catálogo que lo impide—. Lo que este módulo
puede afirmar con honestidad es que la sede no tiene parámetros.

## Notas de esquema

Tablas de este módulo: `holiday` y `site_parameter`, creadas por
`20260813040610_configuration_holidays_and_site_parameters`.

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
