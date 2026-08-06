/**
 * Protección de datos personales y de salud en los logs.
 *
 * ESTRATEGIA: lista de permitidos (allowlist), no de bloqueados.
 *
 * Una denylist es una carrera que se pierde por defecto: solo protege lo que
 * alguien recordó enumerar en el pasado, y cada sprint añade campos nuevos a
 * las entidades de paciente. Los modos de fallo son asimétricos:
 *
 *   - Allowlist mal puesta  → un log menos informativo, detectado al depurar.
 *   - Denylist mal puesta   → PHI en disco, replicado a backups y retenido
 *                             según la política de conservación. Irreversible
 *                             y notificable a la SPDP.
 *
 * Además, la LOPDP no dice "quita lo sensible", dice "trata solo lo necesario".
 * Una allowlist es la implementación literal de ese principio.
 */

/**
 * Claves que SÍ pueden aparecer en un log.
 *
 * Añadir una entrada aquí requiere revisión explícita en el pull request.
 * Nada que identifique a un paciente: ni cédula, ni nombres, ni diagnóstico.
 */
export const CLAVES_PERMITIDAS: ReadonlySet<string> = new Set([
  // Envoltorio de pino
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'name',

  // Correlación
  'trace_id',
  'span_id',
  'req_id',
  'reqId',

  // Serializadores y sus campos
  'req',
  'res',
  'err',
  'responseTime',
  'id',
  'method',
  'url',
  'route',
  'statusCode',

  // Negocio: identificadores INTERNOS, nunca identificadores nacionales
  'sede_id',
  'usuario_id',
  'rol',
  'modulo',
  'paciente_id',
  'atencion_id',
  'orden_id',
  'comprobante_id',

  // Dominio clínico desidentificado
  'especialidad_codigo',
  'tipo_documento',
  'estado',
  'accion',
  'resultado',

  // Métricas técnicas
  'duration_ms',
  'count',
  'total',
  'page',
  'limit',
  'retries',
  'cache_hit',

  // Errores
  'type',
  'message',
  'code',
  'stack',
  'error_code',
  'status',

  // Contexto
  'context',
  'service',
  'version',
  'env',

  // Operación (arranque, configuración): nunca contienen datos de paciente.
  'puerto',
  'docs',
  'ambiente_sri',
]);

const PROFUNDIDAD_MAX = 6;
const ELEMENTOS_ARRAY_MAX = 20;

/**
 * Poda un objeto dejando solo las claves permitidas.
 *
 * La ausencia de un `else` al final del bucle ES la política: lo no declarado
 * se descarta en silencio.
 */
export function podarAllowlist(valor: unknown, profundidad = 0): unknown {
  if (valor === null || valor === undefined) return valor;
  if (profundidad > PROFUNDIDAD_MAX) return '[PROFUNDIDAD_MAX]';

  const tipo = typeof valor;
  if (tipo === 'string' || tipo === 'number' || tipo === 'boolean')
    return valor;
  if (valor instanceof Date) return valor.toISOString();

  if (Array.isArray(valor)) {
    const recortado: unknown[] = valor
      .slice(0, ELEMENTOS_ARRAY_MAX)
      .map((v) => podarAllowlist(v, profundidad + 1));
    if (valor.length > ELEMENTOS_ARRAY_MAX) {
      recortado.push(
        `[+${valor.length - ELEMENTOS_ARRAY_MAX} elementos omitidos]`,
      );
    }
    return recortado;
  }

  if (tipo === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      if (CLAVES_PERMITIDAS.has(clave)) {
        salida[clave] = podarAllowlist(v, profundidad + 1);
      }
      // Sin `else`: lo no permitido se descarta. Esto es la política.
    }
    return salida;
  }

  return undefined;
}

/**
 * Quita la query string de una URL y normaliza los identificadores numéricos.
 * En un sistema clínico la query suele llevar cédula o número de historia.
 */
export function sanearUrl(url?: string): string {
  if (!url) return '';
  const i = url.indexOf('?');
  const base = i === -1 ? url : url.slice(0, i);
  return base.replace(/\/\d{4,}/g, '/:id');
}

/**
 * EL ORDEN IMPORTA: de más específico a más genérico.
 *
 * Un celular ecuatoriano (09 + 8 dígitos) tiene exactamente 10 dígitos, igual
 * que una cédula. Si el patrón genérico de 10 dígitos va primero, se traga
 * todos los teléfonos y los etiqueta mal.
 *
 * (Ambos quedan enmascarados igualmente, así que la etiqueta es cosmética —
 * pero un log que miente sobre qué tipo de dato ocultó estorba al investigar
 * un incidente.)
 */
const PATRONES_PII: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/\b\d{13}\b/g, '[RUC]'], // 13 dígitos, antes que cédula y teléfono
  [/\b09\d{8}\b/g, '[TELEFONO]'], // 10 dígitos con prefijo fijo
  [/\b\d{10}\b/g, '[CEDULA]'], // 10 dígitos, el más genérico: va al final
];

/**
 * Limpia el mensaje de un error.
 *
 * Los errores de PostgreSQL y de Prisma incluyen con frecuencia la fila que
 * causó el conflicto — con nombre y cédula del paciente dentro.
 */
export function sanearMensajeError(mensaje?: string): string {
  if (!mensaje) return '';
  let limpio = mensaje;
  for (const [patron, reemplazo] of PATRONES_PII) {
    limpio = limpio.replace(patron, reemplazo);
  }
  // El detalle de una violación de constraint de pg: `Key (cedula)=(1712345678)`
  limpio = limpio.replace(
    /\((?:[^()]{0,200})\)\s*=\s*\((?:[^()]{0,200})\)/g,
    '(...)=(...)',
  );
  return limpio.slice(0, 500);
}
