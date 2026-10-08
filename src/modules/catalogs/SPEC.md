# SPEC — Módulo `catalogs`

**Estado:** borrador (parcial) · **Fecha:** 7 de octubre de 2026
**Formato:** EARS, según ADR-010

Los catálogos externos que el sistema consulta y no edita: CIE-10, CNMB,
tarifario, DPA (provincias, cantones y parroquias), países, etnias y los demás
del RDACAA.

> **Cómo se lee.** `CUANDO` = disparador · `MIENTRAS` = estado que dura ·
> `SI … ENTONCES` = comportamiento no deseado · `DONDE` = opcional · sin palabra
> clave = siempre activo. `DEBERÁ` es obligación; no existe «debería».

---

## Alcance

**Parcial, a propósito.** El módulo existía sin `SPEC.md` (la deuda de REQ-165
que declara `REQUISITOS.md`). Este documento nace con un solo requisito, el
orden de la búsqueda que pidió el autor el 07-10-2026 (ESTANDAR-UI §12.7), y
el resto —vigencia, jerarquía, importación, rutas y códigos de error— sigue
siendo deuda: está construido y probado (`test/integration/catalog-*.spec.ts`)
pero no escrito aquí.

## Entregas priorizadas

### CT1 — Encontrar lo que se escribe _(P1, 07-10-2026)_

Un buscador de catálogo grande —ciudades, parroquias, CIE-10, CNMB— busca en el
servidor según lo que se escribe y pone primero lo que empieza igual.

**Prueba independiente:** buscar «san» entre «Santa Rosa», «San Antonio» y
«Puerto San Miguel», contra PostgreSQL real.
**Cubre:** CAT-001.
**Solo servidor:** CAT-001. La pantalla enseña la lista en el orden en que
llega (`CatalogCombobox.spec.ts` lo cita); lo que se prueba es el orden.

## Requisitos

### Búsqueda

- **CAT-001** — CUANDO alguien busque un texto en un catálogo, el sistema
  DEBERÁ ordenar las coincidencias así: el código exacto; los códigos que
  empiezan por lo escrito; **las descripciones que empiezan por lo escrito**,
  sin tildes ni mayúsculas; y después las demás por parecido.
  > El parecido (`word_similarity`) mide la mejor palabra de la descripción,
  > no su principio: puntúa igual «**San** Antonio» que «Puerto **San**
  > Miguel», y entre 1401 parroquias lo que la persona busca quedaba detrás de
  > veinte que sólo contienen la palabra. Quien escribe el principio de un
  > nombre espera verlo primero (ESTANDAR-UI §12.7).
