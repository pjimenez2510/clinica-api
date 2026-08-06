import { randomUUID } from 'node:crypto';

import type { Params } from 'nestjs-pino';

import { podarAllowlist, sanearMensajeError, sanearUrl } from './log-privacy';

const esProduccion = process.env.NODE_ENV === 'production';

/** Cabeceras que pueden loguearse. El resto se descarta. */
const CABECERAS_PERMITIDAS = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'x-request-id',
  'traceparent',
] as const;

/**
 * Denylist de `redact`. Es la SEGUNDA red, no la defensa principal: la primera
 * es la allowlist de `formatters.log`.
 *
 * Se minimizan los comodines a propósito: sin ellos el coste es ~2% sobre
 * `JSON.stringify`; con ellos sube en torno al 50%.
 *
 * Los paths se compilan con un VM context, así que NUNCA pueden provenir de
 * entrada de usuario ni de configuración editable.
 */
/**
 * Formas mínimas de lo que pino-http entrega a cada serializador.
 * Se declaran a mano porque los tipos del paquete son `any`, y tipar la entrada
 * es lo que permite que el linter detecte un acceso a un campo que no existe.
 */
interface PeticionCruda {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  route?: { path?: string };
}

interface RespuestaCruda {
  statusCode?: number;
  raw?: { statusCode?: number };
}

interface ErrorCrudo {
  name?: string;
  constructor?: { name?: string };
  message?: string;
  code?: unknown;
  stack?: string;
  /** Los fallos de conexión de `pg` llegan agrupados aquí. */
  errors?: Array<{ code?: unknown; message?: string }>;
}

const PATHS_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'clave',
  'cedula',
  'ruc',
  'nombres',
  'apellidos',
  'diagnostico',
  'paciente',
  'body',
  'req.body',
];

export const loggerConfig: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? (esProduccion ? 'info' : 'debug'),

    base: {
      service: 'clinica-api',
      version: process.env.APP_VERSION ?? '0.1.0',
      env: process.env.NODE_ENV ?? 'development',
    },

    /**
     * Un solo identificador para buscar en todas partes. Cuando haya
     * OpenTelemetry, aquí se reutilizará el `trace_id` de la traza activa para
     * no tener dos identificadores distintos del mismo suceso.
     */
    genReqId(
      req: { headers: Record<string, unknown> },
      res: { setHeader: (nombre: string, valor: string) => unknown },
    ): string {
      const entrante = req.headers['x-request-id'];
      // Validar SIEMPRE la cabecera entrante: sin esto hay log-forging, un
      // cliente podría inyectar saltos de línea y falsear entradas del log.
      const valido =
        typeof entrante === 'string' &&
        entrante.length <= 128 &&
        /^[A-Za-z0-9._-]+$/.test(entrante);

      const id = valido ? entrante : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },

    /** CAPA 1 — serializadores de allowlist: se construye lo que se loguea. */
    serializers: {
      req(req: PeticionCruda) {
        const headers: Record<string, unknown> = {};
        for (const h of CABECERAS_PERMITIDAS) {
          const valor = req.headers?.[h];
          if (valor !== undefined) headers[h] = valor;
        }
        return {
          id: req.id,
          method: req.method,
          url: sanearUrl(req.url), // sin query string
          route: req.route?.path,
          headers,
          // La IP se OMITE: es dato personal bajo LOPDP. Cuando se necesite para
          // investigar accesos indebidos, va a la tabla de auditoría —donde está
          // declarada en el registro de actividades— no a los logs generales.
        };
      },
      // pino-http envuelve la respuesta: según el momento del ciclo, el código
      // real está en `res.raw`. Sin este fallback se registra `statusCode: null`
      // en todas las peticiones, que es peor que no tener log de acceso porque
      // parece correcto.
      res: (res: RespuestaCruda) => ({
        statusCode: res.statusCode ?? res.raw?.statusCode ?? null,
      }),
      err: (err: ErrorCrudo) => {
        // `pg` agrupa los fallos de conexión en `errors[]` y deja vacíos el
        // mensaje y el código de arriba. Sin este rescate, el log solo dice
        // `type: "Object", message: ""` y no sirve para diagnosticar nada.
        const agrupado = err?.errors?.[0];
        return {
          type: err?.name ?? err?.constructor?.name ?? 'Error',
          // Los errores de Prisma y pg incluyen la fila que causó el conflicto.
          message: sanearMensajeError(err?.message || agrupado?.message),
          code: err?.code ?? agrupado?.code,
          stack: esProduccion ? undefined : err?.stack,
          // err.query, err.parameters y err.detail NUNCA se serializan.
        };
      },
    },

    /** CAPA 2 — denylist como red de seguridad. */
    redact: {
      paths: PATHS_REDACT,
      censor: '[PHI_REDACTADO]',
      // Se deja el marcador en vez de borrar la clave: la ausencia visible es
      // auditable, un campo que simplemente no está no dice nada.
      remove: false,
    },

    /** CAPA 3 — poda de allowlist sobre el objeto ya combinado. Falla cerrado. */
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (objeto: Record<string, unknown>) =>
        podarAllowlist(objeto) as Record<string, unknown>,
    },

    autoLogging: {
      ignore: (req: { url?: string }) =>
        ['/api/v1/health', '/api/v1/ping'].includes(
          (req.url ?? '').split('?')[0],
        ),
    },

    quietReqLogger: true,

    transport: esProduccion
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
  },
};
