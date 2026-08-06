/**
 * Raíz de todos los errores de negocio.
 *
 * REGLA ARQUITECTÓNICA: esta capa NO conoce HTTP. No hay códigos de estado aquí.
 * El mapeo a HTTP vive en `shared/http/problem-details`, y es el único sitio que
 * lo conoce. Gracias a eso, las mismas reglas de negocio se reutilizan desde un
 * worker de cola o un comando de CLI, donde "404" no significa nada.
 */
export abstract class DomainError extends Error {
  /**
   * Código de negocio ESTABLE. Es contrato público: lo consumen los logs, las
   * alertas y los integradores. Nunca se traduce y nunca se renombra.
   */
  abstract readonly code: string;

  /**
   * Parámetros para interpolar en el mensaje traducido.
   * NUNCA meter aquí datos de salud ni identificadores nacionales: estos valores
   * acaban en la respuesta HTTP y en capturas de pantalla de soporte.
   */
  readonly params: Readonly<Record<string, string | number>>;

  protected constructor(
    mensajeTecnico: string,
    params: Record<string, string | number> = {},
  ) {
    // El mensaje técnico va en inglés y solo alimenta logs. Nunca se expone.
    super(mensajeTecnico);
    this.name = new.target.name;
    this.params = Object.freeze({ ...params });
    Error.captureStackTrace?.(this, new.target);
  }
}

/** La entrada no cumple una invariante del dominio. */
export abstract class ValidationError extends DomainError {}

/** El recurso solicitado no existe, o el solicitante no puede saber que existe. */
export abstract class NotFoundError extends DomainError {}

/** El estado actual impide la operación (duplicado, solapamiento, carrera). */
export abstract class ConflictError extends DomainError {}

/** La operación es sintácticamente válida pero viola una regla de negocio. */
export abstract class BusinessRuleViolation extends DomainError {}

/** El solicitante no está autenticado. */
export abstract class UnauthorizedError extends DomainError {}

/** Autenticado, pero sin permiso sobre este recurso. */
export abstract class ForbiddenError extends DomainError {}

/**
 * Falló un sistema de terceros (SRI, IESS, laboratorio).
 *
 * `esReintentable` es la distinción que evita dos bugs opuestos: reintentar
 * eternamente un rechazo de negocio, o descartar una caída pasajera de red.
 */
export abstract class ExternalServiceError extends DomainError {
  abstract readonly servicio: string;
  abstract readonly esReintentable: boolean;
}
