import { BusinessRuleViolation } from '../../../shared/domain/errors/domain-error';

/**
 * Lo que puede salir mal al resolver un código de catálogo.
 *
 * DOS DE LOS TRES VIVEN EN `shared` DESDE EL 17-08-2026 y se reexportan aquí,
 * para que este módulo siga nombrando sus errores donde están los demás.
 * `patients` tuvo que aprender a rechazar una referencia inexistente o no
 * vigente cuando la ficha empezó a elegir etnia, nacionalidad, parroquia e
 * identidad de género (PA-026 a PA-029), y ningún módulo importa de otro:
 * declarar una segunda clase con el mismo `code` es justo lo que
 * `error-catalogue.spec.ts` rechaza. Ver `shared/domain/errors/catalog-reference.errors.ts`.
 *
 * `CatalogConceptNotSelectableError` NO se movió: «esto es un capítulo, no un
 * diagnóstico» es una pregunta que sólo hace la caja de diagnóstico.
 */
export {
  CatalogConceptNotFoundError,
  CatalogConceptNotInForceError,
} from '../../../shared/domain/errors/catalog-reference.errors';

/**
 * Se intentó registrar un capítulo o un grupo como diagnóstico.
 *
 * `A00-B99` es «Ciertas enfermedades infecciosas y parasitarias»: un título de
 * capítulo, no una enfermedad. El RDACAA lo rechaza, y dejarlo pasar produce un
 * registro que hay que corregir a mano meses después.
 */
export class CatalogConceptNotSelectableError extends BusinessRuleViolation {
  readonly code = 'CATALOG_CONCEPT_NOT_SELECTABLE';
  override readonly userTitle =
    'Debe elegir un diagnóstico concreto, no un capítulo ni un grupo';
  constructor(code: string) {
    super(`${code} is a chapter or group, not a diagnosable concept`, { code });
  }
}
