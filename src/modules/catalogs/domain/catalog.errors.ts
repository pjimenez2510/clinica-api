import {
  BusinessRuleViolation,
  NotFoundError,
} from '../../../shared/domain/errors/domain-error';

export class CatalogConceptNotFoundError extends NotFoundError {
  readonly code = 'CATALOG_CONCEPT_NOT_FOUND';
  override readonly userTitle = 'No se encontró el código en el catálogo';
  constructor(systemCode: string, code: string) {
    super(`${code} does not exist in ${systemCode}`, { systemCode, code });
  }
}

/**
 * El código existe pero no estaba vigente en la fecha pedida.
 *
 * NO es un 404, y la diferencia importa: un código retirado en 2020 SÍ existió,
 * y un diagnóstico de 2018 que lo use es válido. Confundirlos haría que una
 * historia antigua pareciese corrupta.
 */
export class CatalogConceptNotInForceError extends BusinessRuleViolation {
  readonly code = 'CATALOG_CONCEPT_NOT_IN_FORCE';
  override readonly userTitle =
    'Ese código no estaba vigente en la fecha indicada';
  constructor(code: string, on: Date) {
    super(`${code} was not in force on ${on.toISOString()}`, { code });
  }
}

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
