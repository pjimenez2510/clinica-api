# SPEC — Módulo `organization`

**Estado:** borrador para revisión · **Fecha:** 12 de agosto de 2026
**Fase:** 1 — Núcleo operativo · **Formato:** EARS, según ADR-010

Dónde se atiende: el establecimiento de salud, sus sedes y sus consultorios.
Nace de ADR-011, que constató que `Site` lo referencian agenda, facturación y el
reporte al Estado, y **no tenía módulo dueño**. Decisiones que lo gobiernan:
D-002.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

Este módulo **posee** el establecimiento con su tipología y su código único del
MSP, las **sedes**, los **consultorios** (`SiteRoom`), y los datos fiscales que
la facturación necesita: **RUC** y **puntos de emisión** del SRI.

Los datos del SRI se guardan aquí **solo como dato**: la numeración de
comprobantes, la firma electrónica y el diálogo con el SRI son de `billing`.
Este módulo responde «cuál es el RUC y qué puntos de emisión existen», no
«cuál es el siguiente secuencial».

**Fuera de alcance:** la lógica tributaria y los secuenciales de facturación
(módulo `billing`, REQ-085), los profesionales que atienden en cada sede
(módulo `staff`), los parámetros operativos por sede —antelaciones, topes,
retención— (módulo `configuration`), y el alcance por sede de un permiso
(módulo `auth`, que ya lo resuelve con `user_role_grant.site_id`).

**Depende de:** `auth` (permiso de administración, D-002) y `catalogs` para la
parroquia del DPA del INEC.

## Vocabulario

| Término               | Significado exacto en este módulo                                                     |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Establecimiento**   | La entidad de salud ante el MSP: tipología, código único, RUC. Puede tener varias sedes |
| **Tipología**         | Clasificación del MSP del establecimiento (A.M. 00000079): lo que determina qué reporta |
| **Código único MSP**  | Identificador del establecimiento que el RDACAA exige en **cada** atención (REQ-020)   |
| **Sede**              | Ubicación física donde se atiende. Es el eje del alcance de permisos y de la agenda     |
| **Consultorio**       | Espacio dentro de una sede (`SiteRoom`). Dos profesionales no pueden ocupar el mismo    |
| **Punto de emisión**  | Código de tres dígitos del SRI desde el que se emiten comprobantes                      |

---

## Entregas priorizadas

### O1 — Establecimiento y sedes _(P1)_

Alta y edición del establecimiento con su tipología y código MSP, y de sus
sedes con parroquia, dirección y RUC.

**Por qué es P1:** REQ-020 exige el código del establecimiento en cada atención,
y `encounter` no puede cerrarse sin él.
**Prueba independiente:** crear dos sedes del mismo establecimiento y comprobar
que el código único del MSP no admite repetido.
**Cubre:** OR-001 a OR-008.

### O2 — Consultorios y puntos de emisión _(P2)_

Consultorios por sede, y los puntos de emisión del SRI que la facturación
consumirá.

**Cubre:** OR-020 a OR-026.

---

## Requisitos

### Establecimiento y sedes (REQ-042, REQ-020)

- **OR-001** — El sistema DEBERÁ registrar la **tipología** del establecimiento
  y su **código único del MSP**, y NO DEBERÁ permitir operar sin ambos.
- **OR-002** — El sistema DEBERÁ impedir dos establecimientos o sedes con el
  mismo código único del MSP, con la garantía en la base.
- **OR-003** — El sistema DEBERÁ exponer el código único del MSP a quien deba
  consignarlo en cada atención (REQ-020).
- **OR-004** — El sistema DEBERÁ mantener una o varias **sedes** por
  establecimiento, cada una con nombre, dirección, teléfono y **parroquia** del
  DPA del INEC.
- **OR-005** — CUANDO un usuario con el permiso de administración cree o edite
  un establecimiento o una sede, el sistema DEBERÁ registrarlo en la bitácora
  con autor, instante y valor anterior.
- **OR-006** — SI se intenta borrar una sede referenciada por una cita, una
  atención, un profesional o una concesión de rol, ENTONCES el sistema DEBERÁ
  rechazarlo con `SITE_IN_USE` y ofrecer desactivarla.
- **OR-007** — MIENTRAS una sede esté desactivada, el sistema NO DEBERÁ
  ofrecerla para nuevas citas ni asignaciones, y DEBERÁ conservar intactas las
  referencias existentes.
- **OR-008** — El sistema DEBERÁ almacenar el **RUC** del establecimiento y de
  cada sede que facture, validando que tenga trece dígitos y termine en un
  código de establecimiento del SRI.

### Consultorios y puntos de emisión (REQ-042, REQ-085)

- **OR-020** — El sistema DEBERÁ mantener **consultorios** por sede, cada uno
  con nombre único dentro de su sede, con la garantía en la base.
- **OR-021** — Un consultorio DEBERÁ pertenecer a exactamente una sede, y SI se
  intenta usar en una cita de otra sede, ENTONCES el sistema DEBERÁ rechazarlo
  con `ROOM_NOT_IN_SITE` (AG-105).
- **OR-022** — MIENTRAS un consultorio esté desactivado, el sistema NO DEBERÁ
  ofrecerlo para nuevas citas, y DEBERÁ conservar intactas las existentes.
- **OR-023** — El sistema DEBERÁ mantener los **puntos de emisión** del SRI por
  sede, cada uno con su código de tres dígitos.
- **OR-024** — El sistema DEBERÁ impedir dos puntos de emisión con el mismo
  código dentro de una sede, con la garantía en la base.
- **OR-025** — El sistema DEBERÁ exponer RUC y punto de emisión a `billing`
  como **dato**, sin numerar comprobantes ni hablar con el SRI: esa lógica es de
  `billing` (REQ-085).
- **OR-026** — Toda mutación de consultorios y puntos de emisión DEBERÁ quedar
  en la bitácora con autor, instante y valor anterior.

---

## Códigos de error

| Código                      | HTTP | Cuándo                                                     |
| --------------------------- | ---- | ---------------------------------------------------------- |
| `ESTABLISHMENT_NOT_FOUND`   | 404  | Todavía no se ha registrado el establecimiento (OR-001)    |
| `SITE_NOT_FOUND`            | 404  | La sede indicada no existe                                 |
| `SITE_ROOM_NOT_FOUND`       | 404  | El consultorio indicado no existe                          |
| `EMISSION_POINT_NOT_FOUND`  | 404  | El punto de emisión indicado no existe                     |
| `SITE_IN_USE`               | 409  | Borrar una sede referenciada (OR-006)                      |
| `SITE_ROOM_IN_USE`          | 409  | Borrar un consultorio con citas (OR-022)                   |
| `MSP_UNICODE_DUPLICATE`     | 409  | Código único del MSP repetido (OR-002)                     |
| `SITE_ROOM_DUPLICATE`       | 409  | Nombre de consultorio repetido en la sede (OR-020)         |
| `EMISSION_POINT_DUPLICATE`  | 409  | Punto de emisión repetido en la sede (OR-024)              |
| `ROOM_NOT_IN_SITE`          | 422  | Consultorio de otra sede (OR-021)                          |
| `INVALID_RUC`               | 422  | RUC que no supera la validación del SRI (OR-008)           |

`ROOM_NOT_IN_SITE` ya existe en `error-catalogue.ts`, emitido hoy desde
`agenda`: la garantía se declara aquí y se comprueba allí, sin cambiar la cadena.

Los cuatro «no existe» y los dos «en uso» de consultorio y punto de emisión no
estaban en la primera redacción de esta tabla: aparecieron al implementar los
`PATCH` y `DELETE` que OR-022 y OR-026 exigen, y se anotan aquí porque el
`code` es contrato público desde la primera respuesta que lo lleva.

`EMISSION_POINT_IN_USE` **no existe a propósito**: hoy nada referencia a
`emission_point`. Lo traerá `billing` junto con su clave foránea (REQ-085);
armar un código que ninguna prueba puede provocar sería prometer una garantía
que no está escrita en ninguna parte.

## Notas de esquema

Las tablas `site` y `site_room` ya existen y hoy no tienen módulo dueño — la
razón de ser de este SPEC. `site.msp_unicode` es único y `site_room` es único
por `(site_id, name)`.

Lo que entra con este módulo, en la migración
`20260813025017_organization_establishment_and_emission_points`:

- La entidad **establecimiento** propiamente dicha, con su tipología: hoy
  `Site` mezcla establecimiento y sede porque la clínica arranca con una sola.
  Separarlas mientras hay una fila es barato; con historial de dos años, no.
  `site.establishment_id` nace **anulable** para que las filas existentes
  sobrevivan a la migración; la semilla las rellena.
- Los **puntos de emisión** (OR-023): tabla nueva, única por `(site_id, código)`,
  con un `CHECK` de tres dígitos.
- El `UNIQUE (id, site_id)` en `site_room` **y la clave foránea compuesta**
  `agenda_entry (room_id, site_id) → site_room (id, site_id)`, que saca OR-021
  (AG-105) de TypeScript y lo mete en la base. Con `room_id` anulable,
  `MATCH SIMPLE` deja pasar la cita sin consultorio, que es lo correcto.

Lo que **no** hizo falta añadir, comprobado antes de escribir la migración:
`site` ya tenía `name`, `address_line`, `phone`, `parish_concept_id`, `ruc` y
`active`. A OR-004 y OR-007 no les faltaban columnas: les faltaba un módulo
dueño, que es exactamente lo que constató ADR-011.
