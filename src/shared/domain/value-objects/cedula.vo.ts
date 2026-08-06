import { ValidationError } from '../errors/domain-error';

export class CedulaInvalidaError extends ValidationError {
  readonly code = 'CEDULA_INVALIDA';

  constructor(motivo: string) {
    // El valor rechazado NO se incluye: es un dato personal y este mensaje
    // termina en logs y en tickets de soporte.
    super(`Invalid Ecuadorian cédula: ${motivo}`, { motivo });
  }
}

/**
 * Cédula de identidad ecuatoriana (10 dígitos).
 *
 * Es un value object autovalidante: si existe una instancia, el número es
 * válido. Una entidad `Paciente` no puede construirse con una cédula inválida
 * porque el tipo es imposible de crear mal — eso no se consigue llamando a una
 * función de validación desde un DTO.
 *
 * Estructura:
 *   - Dígitos 1-2: provincia (01-24, o 30 para extranjeros)
 *   - Dígito 3:    < 6 para persona natural (6 = sector público, 9 = sociedad;
 *                  esos dos solo existen como RUC, no como cédula)
 *   - Dígitos 1-9: base
 *   - Dígito 10:   verificador, algoritmo módulo 10
 */
export class Cedula {
  /** Coeficientes alternos aplicados a los 9 primeros dígitos. */
  private static readonly COEFICIENTES = [2, 1, 2, 1, 2, 1, 2, 1, 2] as const;

  private static readonly PROVINCIA_MIN = 1;
  private static readonly PROVINCIA_MAX = 24;
  private static readonly PROVINCIA_EXTRANJEROS = 30;

  private constructor(private readonly valor: string) {}

  static crear(entrada: string): Cedula {
    const limpia = (entrada ?? '').trim();

    if (!/^\d{10}$/.test(limpia)) {
      throw new CedulaInvalidaError(
        'debe tener exactamente 10 dígitos numéricos',
      );
    }

    const provincia = Number.parseInt(limpia.slice(0, 2), 10);
    const provinciaValida =
      (provincia >= Cedula.PROVINCIA_MIN &&
        provincia <= Cedula.PROVINCIA_MAX) ||
      provincia === Cedula.PROVINCIA_EXTRANJEROS;

    if (!provinciaValida) {
      throw new CedulaInvalidaError('el código de provincia no existe');
    }

    const tercerDigito = Number.parseInt(limpia[2], 10);
    if (tercerDigito >= 6) {
      throw new CedulaInvalidaError(
        'el tercer dígito debe ser menor que 6 en una cédula de persona natural',
      );
    }

    if (Cedula.digitoVerificador(limpia) !== Number.parseInt(limpia[9], 10)) {
      throw new CedulaInvalidaError('el dígito verificador no coincide');
    }

    return new Cedula(limpia);
  }

  /** Valida sin lanzar. Útil para filtros y búsquedas, no para construir entidades. */
  static esValida(entrada: string): boolean {
    try {
      Cedula.crear(entrada);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Módulo 10: multiplica cada dígito por su coeficiente; si el producto pasa
   * de 9 se le resta 9; el verificador es lo que falta para la siguiente decena.
   */
  private static digitoVerificador(cedula: string): number {
    const suma = Cedula.COEFICIENTES.reduce((acc, coeficiente, i) => {
      const producto = Number.parseInt(cedula[i], 10) * coeficiente;
      return acc + (producto > 9 ? producto - 9 : producto);
    }, 0);

    return (10 - (suma % 10)) % 10;
  }

  get provincia(): number {
    return Number.parseInt(this.valor.slice(0, 2), 10);
  }

  /** Para mostrar en pantalla cuando no hace falta el número completo. */
  enmascarada(): string {
    return `${this.valor.slice(0, 3)}****${this.valor.slice(7)}`;
  }

  toString(): string {
    return this.valor;
  }

  equals(otra: Cedula): boolean {
    return this.valor === otra.valor;
  }
}
