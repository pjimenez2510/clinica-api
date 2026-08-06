import { ValidationError } from '../../../shared/domain/errors/domain-error';

export class PasswordDebilError extends ValidationError {
  readonly code = 'PASSWORD_DEBIL';

  constructor(readonly motivos: string[]) {
    // La contraseña NUNCA entra en el mensaje ni en los parámetros: este texto
    // acaba en logs y en tickets de soporte.
    super(`Password rejected: ${motivos.length} rule(s) failed`, {
      cantidadMotivos: motivos.length,
    });
  }
}

/**
 * Política de contraseñas.
 *
 * Sigue la recomendación actual del NIST: **la longitud manda**, y las reglas
 * de composición ("una mayúscula, un número, un símbolo") se descartan a
 * propósito. Está medido que empujan a la gente hacia patrones predecibles
 * (`Password1!`) y hacia apuntarlas en un papel — en una clínica, pegadas al
 * monitor de recepción.
 *
 * Lo que sí se comprueba es que no sea trivial ni contenga datos del propio
 * usuario, que es de donde salen las contraseñas realmente débiles.
 */
export const LONGITUD_MINIMA = 12;
export const LONGITUD_MAXIMA = 256; // evita DoS por hashing de entradas enormes

/** Contraseñas triviales frecuentes en el contexto local. */
const PROHIBIDAS = new Set([
  'password',
  'contrasena',
  'contraseña',
  '123456789012',
  'qwertyuiop12',
  'clinica2026',
  'administrador',
]);

export interface DatosUsuarioParaPassword {
  correo?: string;
  nombres?: string;
  apellidos?: string;
  cedula?: string;
}

/**
 * Valida una contraseña. Devuelve los motivos de rechazo, vacío si es válida.
 *
 * Se devuelven TODOS los motivos y no solo el primero: obligar al usuario a
 * descubrirlos de uno en uno es la forma más rápida de que acabe eligiendo algo
 * malo por agotamiento.
 */
export function validarPassword(
  password: string,
  usuario: DatosUsuarioParaPassword = {},
): string[] {
  const motivos: string[] = [];

  if (password.length < LONGITUD_MINIMA) {
    motivos.push(`debe tener al menos ${LONGITUD_MINIMA} caracteres`);
  }
  if (password.length > LONGITUD_MAXIMA) {
    motivos.push(`no puede superar ${LONGITUD_MAXIMA} caracteres`);
  }

  const normalizada = password
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

  if (PROHIBIDAS.has(normalizada)) {
    motivos.push('es una contraseña demasiado común');
  }

  // Un solo carácter repetido, o una secuencia obvia.
  if (/^(.)\1+$/.test(password)) {
    motivos.push('no puede ser un mismo carácter repetido');
  }
  if (/0123456789|abcdefghij|qwertyuiop/.test(normalizada)) {
    motivos.push('no puede ser una secuencia del teclado');
  }

  // Datos del propio usuario: es de donde salen las contraseñas adivinables.
  const fragmentos = [
    usuario.correo?.split('@')[0],
    usuario.nombres,
    usuario.apellidos,
    usuario.cedula,
  ]
    .filter((f): f is string => typeof f === 'string' && f.length >= 4)
    .map((f) =>
      f
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, ''),
    );

  if (fragmentos.some((f) => normalizada.includes(f))) {
    motivos.push('no puede contener tu nombre, correo ni cédula');
  }

  return motivos;
}

/** Valida y lanza si no cumple. */
export function asegurarPasswordValida(
  password: string,
  usuario: DatosUsuarioParaPassword = {},
): void {
  const motivos = validarPassword(password, usuario);
  if (motivos.length > 0) throw new PasswordDebilError(motivos);
}
