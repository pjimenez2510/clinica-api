/**
 * RFC 9457 — Problem Details for HTTP APIs.
 * Proposed Standard, julio 2023. Obsoleta al RFC 7807.
 *
 * Se sirve con `Content-Type: application/problem+json`.
 */

/** Miembros estándar del RFC 9457 §3.1. */
export interface ProblemDetailsBase {
  /**
   * URI que identifica el TIPO de problema.
   * El §3.1.1 aclara que NO tiene por qué ser dereferenciable: no hace falta
   * servir documentación en esa URL para que el contrato sea válido.
   */
  type: string;
  /** Resumen legible del tipo de problema. Se traduce. */
  title: string;
  status: number;
  /** Explicación de ESTA ocurrencia. Se traduce. NUNCA lleva datos de salud. */
  detail?: string;
  /** URI de la ocurrencia concreta. Sin query string: puede llevar la cédula. */
  instance?: string;
}

/**
 * Extensiones propias. El §3.2 obliga a los clientes a ignorar los miembros
 * que no reconozcan, así que añadirlas es conforme al estándar.
 */
export interface ProblemDetails extends ProblemDetailsBase {
  /**
   * Código de negocio ESTABLE, en inglés y mayúsculas.
   * Es el contrato de máquina: los clientes hacen `switch` sobre él y los
   * integradores lo usan en sus alertas. Nunca se traduce ni se renombra.
   */
  code: string;
  /** Trace ID de OpenTelemetry: el usuario reporta el ID y encuentras la traza. */
  traceId?: string;
  timestamp: string;
  /** Errores por campo, para formularios. */
  errors?: FieldError[];
}

export interface FieldError {
  /** Ruta del campo con notación de puntos: `paciente.cedula`. */
  field: string;
  /** Código estable, no traducido. */
  code: string;
  /** Mensaje traducido para mostrar al usuario. */
  message: string;
  /**
   * Valor rechazado. Se OMITE cuando el campo puede contener datos personales:
   * devolver la cédula rechazada en el cuerpo del error es una fuga.
   */
  rejectedValue?: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
