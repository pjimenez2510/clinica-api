import { describe, expect, it } from 'vitest';

import { podarAllowlist, sanearMensajeError, sanearUrl } from './log-privacy';

/**
 * Datos señuelo. Si alguno aparece en un log, es una fuga de datos de salud
 * notificable a la SPDP. Este archivo es la red que impide que eso se degrade
 * con el tiempo.
 */
const SEÑUELOS = [
  '1712345678', // cédula
  'paciente@ejemplo.com',
  '0991234567', // celular
  'Juan Pérez Andrade',
  'J45.9', // CIE-10
];

function contieneSeñuelo(salida: string): string | null {
  return SEÑUELOS.find((s) => salida.includes(s)) ?? null;
}

describe('podarAllowlist', () => {
  it('descarta datos de paciente anidados y conserva los identificadores internos', () => {
    const resultado = podarAllowlist({
      atencion_id: 'A-1',
      duration_ms: 42,
      paciente: {
        cedula: '1712345678',
        nombres: 'Juan',
        apellidos: 'Pérez Andrade',
        email: 'paciente@ejemplo.com',
        diagnostico: 'J45.9',
      },
    });

    const salida = JSON.stringify(resultado);
    expect(contieneSeñuelo(salida)).toBeNull();
    expect(resultado).toEqual({ atencion_id: 'A-1', duration_ms: 42 });
  });

  it('descarta campos NUEVOS no declarados: falla cerrado', () => {
    // Simula el sprint que añade un campo a la entidad Paciente y nadie
    // se acuerda de tocar la configuración de logs. Con una denylist esto
    // se filtraría; con allowlist, no.
    const resultado = podarAllowlist({
      campoInventadoEnElSprint12: '1712345678',
      usuario_id: 'u-1',
    });

    expect(JSON.stringify(resultado)).not.toContain('1712345678');
    expect(resultado).toEqual({ usuario_id: 'u-1' });
  });

  it('no se deja engañar por mayúsculas ni variantes del nombre de la clave', () => {
    // Los paths de `redact` de pino distinguen mayúsculas: `Cedula` != `cedula`.
    // La allowlist no tiene ese problema porque no enumera lo prohibido.
    const resultado = podarAllowlist({
      Cedula: '1712345678',
      CEDULA: '1712345678',
      numeroIdentificacion: '1712345678',
    });

    expect(resultado).toEqual({});
  });

  it('corta la recursión en objetos muy profundos', () => {
    let anidado: Record<string, unknown> = { estado: 'fin' };
    for (let i = 0; i < 12; i++) anidado = { req: anidado };

    expect(JSON.stringify(podarAllowlist(anidado))).toContain(
      'PROFUNDIDAD_MAX',
    );
  });

  it('recorta arrays largos indicando cuántos elementos se omitieron', () => {
    const resultado = podarAllowlist(
      Array.from({ length: 30 }, (_, i) => ({ atencion_id: `A-${i}` })),
    ) as unknown[];

    expect(resultado).toHaveLength(21); // 20 + el marcador
    expect(resultado.at(-1)).toBe('[+10 elementos omitidos]');
  });

  it('conserva primitivos y serializa fechas', () => {
    expect(podarAllowlist('texto')).toBe('texto');
    expect(podarAllowlist(42)).toBe(42);
    expect(podarAllowlist(null)).toBeNull();
    expect(podarAllowlist(new Date('2026-08-06T00:00:00Z'))).toBe(
      '2026-08-06T00:00:00.000Z',
    );
  });
});

describe('sanearUrl', () => {
  it('elimina la query string, que suele llevar la cédula', () => {
    expect(sanearUrl('/api/v1/pacientes?cedula=1712345678')).toBe(
      '/api/v1/pacientes',
    );
  });

  it('normaliza identificadores numéricos para no multiplicar cardinalidad', () => {
    expect(sanearUrl('/api/v1/pacientes/123456/atenciones')).toBe(
      '/api/v1/pacientes/:id/atenciones',
    );
  });

  it('deja intactas las rutas sin identificadores', () => {
    expect(sanearUrl('/api/v1/health')).toBe('/api/v1/health');
  });
});

describe('sanearMensajeError', () => {
  it('enmascara los patrones de identificación ecuatorianos', () => {
    const limpio = sanearMensajeError(
      'duplicate key: cedula 1712345678, correo paciente@ejemplo.com, cel 0991234567',
    );
    expect(contieneSeñuelo(limpio)).toBeNull();
    expect(limpio).toContain('[CEDULA]');
    expect(limpio).toContain('[EMAIL]');
    expect(limpio).toContain('[TELEFONO]');
  });

  it('distingue el RUC de la cédula por longitud', () => {
    expect(sanearMensajeError('ruc 1712345678001')).toContain('[RUC]');
  });

  it('oculta el detalle de una violación de constraint de PostgreSQL', () => {
    // pg devuelve literalmente: Key (cedula)=(1712345678) already exists.
    const limpio = sanearMensajeError(
      'Key (cedula)=(1712345678) already exists.',
    );
    expect(limpio).not.toContain('1712345678');
  });

  it('trunca mensajes desmesurados', () => {
    expect(sanearMensajeError('x'.repeat(2000))).toHaveLength(500);
  });
});

describe('límite conocido: la interpolación en el mensaje', () => {
  it('documenta que un template literal SÍ filtra, y por eso hace falta la regla de ESLint', () => {
    // `redact` de pino opera sobre las PROPIEDADES del objeto, NUNCA sobre el
    // string `msg`. Es el vector de fuga número uno en Node y ninguna
    // configuración lo cubre.
    //
    //   logger.info({ cedula })                  -> redactado
    //   logger.info(`consulta de ${cedula}`)     -> FUGA TOTAL
    //
    // La defensa es la regla `no-restricted-syntax` de ESLint que prohíbe
    // template literals en llamadas de log. Este test existe para que el
    // límite quede escrito y nadie lo descubra en producción.
    const mensajeInterpolado = `consulta de la cédula 1712345678`;
    expect(contieneSeñuelo(mensajeInterpolado)).not.toBeNull();

    // Sanearlo a mano sí funciona, pero depende de que alguien se acuerde:
    expect(contieneSeñuelo(sanearMensajeError(mensajeInterpolado))).toBeNull();
  });
});
