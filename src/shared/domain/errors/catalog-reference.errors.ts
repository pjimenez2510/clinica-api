import { BusinessRuleViolation, NotFoundError } from './domain-error';

/**
 * «The catalogue concept you referenced is not usable», for the two negatives
 * that MORE THAN ONE module has to be able to answer.
 *
 * WHY IN `shared` AND NOT IN `catalogs`, since 17-08-2026. `catalogs` owns the
 * concepts and, until today, was the only module that resolved a reference to
 * one. P2 of `patients` makes the chart choose four of them — ethnicity,
 * nationality, DPA parish and gender identity (PA-026 to PA-029) — so
 * `patients` now has to refuse an id that does not exist or was not in force,
 * with the SAME `code`: it is a public contract, and which module emitted it
 * must not change the string a client branches on.
 *
 * The alternative was for `patients` to import the classes from `catalogs`,
 * which `dependency-cruiser`'s `sin-imports-entre-modulos` refuses outright —
 * a build error, not a preference. It is the same path `master-data.errors.ts`
 * took for `SPECIALTY_NOT_FOUND`, and `patient-merged.error.ts` before it.
 *
 * NOT MOVED HERE: `CatalogConceptNotSelectableError`. «This is a chapter, not
 * a diagnosis» is a question only the diagnosis box asks, and a flat catalogue
 * like ethnicity has no chapters to refuse. An error nobody else can raise
 * belongs where it is raised.
 */

/**
 * Un concepto que no está.
 *
 * DOS FORMAS DE PREGUNTAR Y UN SOLO `code`, porque para quien recibe la
 * respuesta significan lo mismo: lo que buscabas no existe. Lo que cambia es
 * qué se puede decir en el detalle — un sistema y un código cuando se tecleó
 * un diagnóstico, un id a secas cuando se resolvía una referencia guardada — y
 * dos constructores nombrados dicen eso mejor que un parámetro que a veces
 * sobra.
 *
 * ⚠️ ES TAMBIÉN LA RESPUESTA A «existe, pero en otro catálogo». Un id de
 * parroquia enviado como etnia se rechaza con este mismo código y no con uno
 * propio: para quien llama significa lo mismo —ese no es un concepto válido
 * aquí— y decirle «existe pero es de otro catálogo» convertiría el endpoint de
 * la ficha en un oráculo del catálogo entero, que se recorre probando ids.
 */
export class CatalogConceptNotFoundError extends NotFoundError {
  readonly code = 'CATALOG_CONCEPT_NOT_FOUND';
  override readonly userTitle = 'No se encontró el código en el catálogo';

  private constructor(
    message: string,
    details: Record<string, string>,
    field?: string,
  ) {
    super(message, details, fieldErrorsFor(field, 'CATALOG_CONCEPT_NOT_FOUND', 'Elija un valor de la lista: el que se envió no existe en el catálogo')); // prettier-ignore
  }

  /**
   * `field` is optional for the same reason as in {@link byId}: the
   * catalogue's own routes resolve a code that came from the URL, where there
   * is no input to blame. The chart's country DOES name one (PA-053) — it is
   * one selector among several on the same form.
   */
  static byCode(
    systemCode: string,
    code: string,
    field?: string,
  ): CatalogConceptNotFoundError {
    return new CatalogConceptNotFoundError(
      `${code} does not exist in ${systemCode}`,
      { systemCode, code },
      field,
    );
  }

  /**
   * `field` names the request field that carries the id, so the message lands
   * on the right input instead of on the form as a whole. Optional because the
   * catalogue's own routes resolve an id that came from the URL, where there
   * is no field to blame.
   */
  static byId(id: string, field?: string): CatalogConceptNotFoundError {
    return new CatalogConceptNotFoundError(
      `no concept has id ${id}`,
      { id },
      field,
    );
  }
}

/**
 * El código existe pero no estaba vigente en la fecha pedida.
 *
 * NO es un 404, y la diferencia importa: un código retirado en 2020 SÍ existió,
 * y un diagnóstico de 2018 que lo use es válido. Confundirlos haría que una
 * historia antigua pareciese corrupta.
 *
 * ⚠️ SÓLO AL ESCRIBIR. Al LEER una ficha no se comprueba la vigencia: una
 * parroquia retirada del DPA no debe dejar en blanco la dirección de alguien
 * que no se ha mudado. Mismo criterio que `CatalogsService.byId`.
 */
export class CatalogConceptNotInForceError extends BusinessRuleViolation {
  readonly code = 'CATALOG_CONCEPT_NOT_IN_FORCE';
  override readonly userTitle =
    'Ese código no estaba vigente en la fecha indicada';

  constructor(code: string, on: Date | string, field?: string) {
    super(
      `${code} was not in force on ${on instanceof Date ? on.toISOString() : on}`,
      { code },
      fieldErrorsFor(field, 'CATALOG_CONCEPT_NOT_IN_FORCE', 'Ese valor ya no está vigente: elija uno de la lista actual'), // prettier-ignore
    );
  }
}

/**
 * The per-field detail, or nothing at all.
 *
 * `params` never leaves the process — `problem-details.filter.ts` emits
 * `errors[]` and drops `detail` in production — so a code that only sets
 * `params` reaches the client as a status and a sentence with no indication of
 * WHICH of the four references was wrong. With four catalogue fields on one
 * form, that is the difference between correcting an input and re-checking all
 * of them.
 */
function fieldErrorsFor(
  field: string | undefined,
  code: string,
  message: string,
) {
  return field === undefined ? undefined : [{ field, code, message }];
}
