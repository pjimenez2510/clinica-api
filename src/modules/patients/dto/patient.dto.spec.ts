import { describe, expect, it } from 'vitest';

import {
  addIdentifierSchema,
  correctPatientSchema,
  createPatientSchema,
  searchPatientsSchema,
} from './patient.dto';

/**
 * The registration contract, exercised on the cases that actually walk in.
 *
 * Every cedula below has a REAL check digit. A made-up number would be
 * rejected for the right reason by accident, and the test would keep passing
 * the day the algorithm broke.
 */
const VALID_CEDULA = '1710034065';

/**
 * Una cédula sintética con el dígito verificador CALCULADO, nunca copiado.
 *
 * Los nueve primeros dígitos se eligen para el caso que se quiere probar
 * —provincia, tercer dígito— y el décimo sale del módulo 10. Componerlo a ojo
 * produce un rechazo por el motivo equivocado, que es una prueba que pasa
 * mientras la regla que dice probar está rota.
 */
function cedulaFor(firstNine: string): string {
  const digits = [...firstNine].map(Number);
  const total = digits.reduce((sum, digit, index) => {
    if (index % 2 !== 0) return sum + digit;
    const doubled = digit * 2;
    return sum + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return `${firstNine}${(10 - (total % 10)) % 10}`;
}
const BASE = {
  familyName: 'Guamán',
  givenName: 'María',
  sex: 'FEMALE',
  birthDate: '1990-04-12',
} as const;

/**
 * Hoy en Ecuador, calculado APARTE del esquema.
 *
 * Con `clinicalDateToday()` importado del dominio, la prueba y el código bajo
 * prueba compartirían la única cosa que hay que comprobar —contra qué reloj se
 * resuelve la cota— y un `new Date()` del anfitrión pasaría igual. `Intl` con
 * el huso escrito es una segunda opinión.
 */
function todayInEcuador(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
  }).format(new Date());
}

function daysFromToday(days: number): string {
  const [year, month, day] = todayInEcuador().split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

describe('registering a patient', () => {
  it('PA-011 accepts a valid Ecuadorian cedula', () => {
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: VALID_CEDULA,
      },
    });
    expect(result.success).toBe(true);
  });

  it('PA-011 rejects a cedula whose check digit is wrong', () => {
    // Same number with the last digit changed: it looks entirely plausible,
    // which is exactly why the check digit exists.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: '1710034064',
      },
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['identifier', 'value']);
    expect(issue?.message).toBe('La cédula ingresada no es válida');
  });

  it('PA-011 rejects an impossible province code even with a perfect check digit', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA PRUEBA ANTERIOR NO PROBABA ESTO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Usaba `9910034065`, cuyo DÍGITO VERIFICADOR TAMBIÉN ESTÁ MAL, así que
     * fallaba por la otra rama y sólo afirmaba `success === false`. Una
     * auditoría por mutación borró entera la línea de la provincia y la suite
     * siguió en verde: la regla que la prueba decía proteger no estaba
     * protegida por nadie.
     *
     * Aquí el décimo dígito SE CALCULA para el número, así que lo único que
     * puede rechazarlo es la provincia. Y se afirma el camino del error —qué
     * campo y qué frase— porque es lo que lee quien está en el mostrador con
     * la persona delante.
     */
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        // 99 no es una provincia y nunca lo será. Tercer dígito 1: persona
        // natural, para que tampoco sea ésa la rama que rechaza.
        value: cedulaFor('991003406'),
      },
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['identifier', 'value']);
    expect(issue?.message).toBe('La cédula ingresada no es válida');
  });

  it('PA-011 accepts 24 and rejects 25: el límite superior de las provincias', () => {
    /**
     * EL LÍMITE, que es donde una regla escrita a ojo se equivoca. 24 es
     * Bolívar—la última provincia creada—, 25 no existe, y entre las dos no
     * hay nada que las distinga salvo esta comparación. Los dos números llevan
     * su dígito verificador calculado, así que el único motivo posible de
     * rechazo es la provincia.
     */
    const cedulaWithProvince = (province: string) =>
      createPatientSchema.safeParse({
        ...BASE,
        identifier: {
          type: 'CEDULA',
          issuingCountry: 'ECU',
          value: cedulaFor(`${province}1234567`),
        },
      });

    expect(cedulaWithProvince('24').success).toBe(true);
    expect(cedulaWithProvince('25').success).toBe(false);
    // Y el otro extremo: 00 tampoco es una provincia, y `01` sí lo es.
    expect(cedulaWithProvince('00').success).toBe(false);
    expect(cedulaWithProvince('01').success).toBe(true);
  });

  it('PA-011 rejects a RUC dressed up as a cedula', () => {
    // El tercer dígito 6 o más identifica a un RUC —entidad pública o persona
    // jurídica—, nunca a un paciente. La base ya lo exigía y esta capa no, así
    // que llegaba como una violación de restricción ilegible en el mostrador.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: '0960048080',
      },
    });
    expect(result.success).toBe(false);
  });

  it('PA-011 accepts 30, the code for citizens registered abroad', () => {
    /**
     * A real case in Ecuador, and a rule that says "01 to 24" quietly refuses
     * the entire diaspora.
     *
     * ⚠️ EL DÍGITO VERIFICADOR SE CALCULA PARA ESTE NÚMERO. Antes esto pegaba
     * `30` delante de los ocho dígitos de otra cédula y aceptaba como éxito
     * tanto que pasara como que fallara «por el dígito» — una aserción que se
     * cumplía sola y que habría seguido en verde con la provincia 30 prohibida.
     */
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: cedulaFor('300123456'),
      },
    });

    expect(result.success).toBe(true);
  });

  it('PA-012 does NOT apply the Ecuadorian check digit to a foreign document', () => {
    // A Colombian cedula follows different rules. Validating it as Ecuadorian
    // would reject a document that is perfectly valid.
    const result = createPatientSchema.safeParse({
      ...BASE,
      identifier: {
        type: 'FOREIGN_ID',
        issuingCountry: 'COL',
        value: '1234567890',
      },
    });
    expect(result.success).toBe(true);
  });

  it('PA-003 registers a patient with NO document at all', () => {
    // A newborn twenty minutes old and an unconscious trauma case both need a
    // chart before anybody has paperwork for them. This is the requirement,
    // not a relaxation of one.
    const result = createPatientSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    expect(result.data?.identifier).toBeUndefined();
  });

  it('PA-006 keeps an estimated birth date marked as estimated', () => {
    // Undocumented migrants arrive with an estimated age. Without the flag the
    // estimate is later reported to the ministry as a fact.
    const result = createPatientSchema.safeParse({
      ...BASE,
      birthDateEstimated: true,
    });
    expect(result.data?.birthDateEstimated).toBe(true);
  });

  it('PA-006 defaults the estimate flag to false rather than leaving it absent', () => {
    const result = createPatientSchema.safeParse(BASE);
    expect(result.data?.birthDateEstimated).toBe(false);
  });

  it('PA-004 requires both a given name and a family name', () => {
    expect(
      createPatientSchema.safeParse({ ...BASE, givenName: '   ' }).success,
    ).toBe(false);
    expect(
      createPatientSchema.safeParse({ ...BASE, familyName: '' }).success,
    ).toBe(false);
  });

  it('PA-004 keeps the four name parts apart and offers no full-name field', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * NO ES PREFERENCIA DE MODELADO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Con un `fullName` no se puede ordenar el listado como se archiva a la
     * gente en Ecuador ni componer la fila del RDACAA, y separarlo después
     * obliga a adivinar dónde acaba el apellido de «María del Carmen Vélez
     * Andrade». Así que se comprueban las dos mitades del requisito: que las
     * cuatro partes sobreviven POR SEPARADO, y que un campo único de nombre
     * completo no entra por la puerta de atrás.
     */
    const result = createPatientSchema.safeParse({
      ...BASE,
      familyName: 'Vélez',
      secondFamilyName: 'Andrade',
      givenName: 'María',
      secondGivenName: 'del Carmen',
      fullName: 'María del Carmen Vélez Andrade',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      familyName: 'Vélez',
      secondFamilyName: 'Andrade',
      givenName: 'María',
      secondGivenName: 'del Carmen',
    });
    expect(result.data).not.toHaveProperty('fullName');
    expect(Object.keys(createPatientSchema.shape)).not.toContain('fullName');
  });

  it('PA-004 keeps the second surname optional', () => {
    // Not everybody has one recorded, and demanding it invents data.
    const result = createPatientSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    expect(result.data?.secondFamilyName).toBeUndefined();
    expect(result.data?.familyName).toBe(BASE.familyName);
  });

  it('PA-005 records the sex as documented, with no default and no collapse', () => {
    /**
     * El formulario del ministerio sólo admite H/M, y ESA REDUCCIÓN ES DE LA
     * CAPA DE EXPORTACIÓN. Colapsar `INTERSEX` o `UNKNOWN` al guardar hace que
     * la ficha mienta sobre lo que se documentó, y ya no hay vuelta atrás.
     *
     * Y NO HAY VALOR POR DEFECTO: una ficha sin sexo declarado no puede salir
     * «FEMALE» porque sea el primero de la lista.
     */
    const withoutSex: Record<string, unknown> = { ...BASE };
    delete withoutSex.sex;
    expect(createPatientSchema.safeParse(withoutSex).success).toBe(false);

    for (const sex of ['MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN'] as const) {
      const result = createPatientSchema.safeParse({ ...BASE, sex });
      expect(result.success, sex).toBe(true);
      expect(result.data?.sex, sex).toBe(sex);
    }
  });

  it('PA-007 keeps the birth date a calendar date, never an instant', () => {
    /**
     * Serializada como instante, la fecha se desplaza un día según quién la
     * lea, y el paciente sale un día más joven en el reporte que en su ficha.
     * El esquema la toma y la deja como `YYYY-MM-DD`, y RECHAZA un instante:
     * aceptarlo dejaría entrar la hora que luego desplaza el día.
     */
    const result = createPatientSchema.safeParse({
      ...BASE,
      birthDate: '1990-04-12',
    });
    expect(result.data?.birthDate).toBe('1990-04-12');

    expect(
      createPatientSchema.safeParse({
        ...BASE,
        birthDate: '1990-04-12T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('PA-006 refuses a birth date later than today in Ecuador', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA COTA NO ESTÁ EN LA BASE, Y NO HAY QUE BUSCARLA ALLÍ.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `patient_deceased_after_birth` cierra el otro extremo con un CHECK porque
     * compara dos columnas. «No después de hoy» compara con `now()`, que no es
     * `IMMUTABLE` y por tanto no cabe en un CHECK: va donde va el dígito
     * verificador de la cédula, en la validación de entrada y como error por
     * campo.
     */
    const result = createPatientSchema.safeParse({
      ...BASE,
      birthDate: daysFromToday(1),
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['birthDate']);
    expect(issue?.message).toBe(
      'La fecha de nacimiento no puede ser posterior a hoy',
    );
  });

  it('PA-006 accepts a birth born TODAY, which is the exact boundary', () => {
    // Un recién nacido de veinte minutos. La cota es «posterior a hoy», no
    // «anterior a hoy»: rechazar el día de hoy cerraría el alta a la mitad del
    // caso para el que el registro existe.
    expect(
      createPatientSchema.safeParse({ ...BASE, birthDate: todayInEcuador() })
        .success,
    ).toBe(true);
  });
});

describe('searching the register', () => {
  it('PA-021 caps the page size at 50, exactly', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * 50 Y 51, NO 500.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El registro es dato de salud: una petición que devuelve todas las filas
     * es a la vez un problema de rendimiento y una primitiva de exfiltración.
     * La prueba anterior pedía 500, y por eso el tope sobrevivía a subirlo a
     * 200 sin que nada se pusiera rojo — la cota que se afirmaba era «algo
     * menos de 500», que no es una cota.
     */
    expect(searchPatientsSchema.safeParse({ pageSize: 50 }).success).toBe(true);
    expect(searchPatientsSchema.safeParse({ pageSize: 51 }).success).toBe(
      false,
    );
    expect(searchPatientsSchema.safeParse({ pageSize: 500 }).success).toBe(
      false,
    );
    // Y por abajo: una página de cero filas es una petición sin sentido que
    // igualmente cuesta una consulta.
    expect(searchPatientsSchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(searchPatientsSchema.safeParse({ pageSize: 1 }).success).toBe(true);
  });

  it('defaults to a first page of a sane size', () => {
    const result = searchPatientsSchema.safeParse({});
    expect(result.data).toMatchObject({ page: 1, pageSize: 20 });
  });

  it('PA-020 hides merged records unless they are asked for', () => {
    // A merged chart is not deleted, but staff opening it would find notes
    // that simply stop.
    expect(searchPatientsSchema.safeParse({}).data?.includeMerged).toBe(false);
  });
});

/** Any uuid; the schema only cares that it is one. */
const CONCEPT = '00000000-0000-4000-8000-000000000001';

describe('the RDACAA references on the registration form', () => {
  it('PA-032 registers a chart with none of the four references (D-028)', () => {
    // Optional at registration and mandatory when the first encounter closes,
    // which is `encounter`'s rule. Refusing the chart here is what REQ-009
    // forbids: a newborn cannot wait for the form to be complete.
    const result = createPatientSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    expect(result.data?.ethnicityConceptId).toBeUndefined();
  });

  it('PA-026 accepts the ethnicity as a reference to a concept, not as text', () => {
    // Never free text: INEC revises the categories, and a chart from three
    // years ago has to keep the wording it was recorded with.
    expect(
      createPatientSchema.safeParse({ ...BASE, ethnicityConceptId: 'Mestizo' })
        .success,
    ).toBe(false);
    expect(
      createPatientSchema.safeParse({ ...BASE, ethnicityConceptId: CONCEPT })
        .success,
    ).toBe(true);
  });

  it('PA-029 accepts a gender identity alongside the recorded sex', () => {
    // Two data, neither derived from the other.
    const result = createPatientSchema.safeParse({
      ...BASE,
      genderIdentityConceptId: CONCEPT,
    });
    expect(result.data).toMatchObject({
      sex: 'FEMALE',
      genderIdentityConceptId: CONCEPT,
    });
  });
});

describe('el país de nacionalidad de la ficha', () => {
  it('PA-053 accepts the country as an alpha-3 code and stores it upper-cased', () => {
    /**
     * `ISO 3166-1 alpha-3`, el mismo estándar y la misma forma que
     * `patient_identifier.issuingCountry`. Se normaliza aquí porque la base lo
     * exige en mayúsculas (`patient_country_of_nationality_format`) y un 422
     * por haber tecleado `ven` sería un rechazo que no enseña nada.
     */
    expect(
      createPatientSchema.safeParse({
        ...BASE,
        countryOfNationalityCode: 'ven',
      }).data?.countryOfNationalityCode,
    ).toBe('VEN');
  });

  it('PA-053 refuses anything that is not three letters', () => {
    // Los tres casos reales de una importación: el alpha-2, el nombre entero y
    // el código con un dígito. El CHECK de la base rechaza los tres; esta capa
    // los rechaza ANTES, por campo y con un mensaje accionable.
    for (const value of ['EC', 'ECUADOR', 'EC1']) {
      const result = createPatientSchema.safeParse({
        ...BASE,
        countryOfNationalityCode: value,
      });
      expect(result.success, value).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([
        'countryOfNationalityCode',
      ]);
      expect(result.error?.issues[0]?.message).toBe(
        'Elija el país de la lista',
      );
    }
  });

  it('PA-053 registers a chart with no country at all (D-028)', () => {
    // Como los cuatro datos del RDACAA: nada de esto bloquea un alta. Un
    // politraumatizado inconsciente no tiene nacionalidad conocida todavía.
    const result = createPatientSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    expect(result.data?.countryOfNationalityCode).toBeUndefined();
  });

  it('PA-053 corrects the country, and clearing it is a correction too', () => {
    expect(
      correctPatientSchema.safeParse({ countryOfNationalityCode: 'col' }).data,
    ).toEqual({ countryOfNationalityCode: 'COL' });
    expect(
      correctPatientSchema.safeParse({ countryOfNationalityCode: null }).data,
    ).toEqual({ countryOfNationalityCode: null });
  });
});

describe('finding a newborn through their mother', () => {
  it('PA-009 accepts the mother as a filter of the register listing', () => {
    // The link is what finds a chart that has no document and often no name
    // yet. Without the filter, `mother_patient_id` is a column nobody can walk.
    expect(
      searchPatientsSchema.safeParse({ motherId: CONCEPT }).data,
    ).toMatchObject({ motherId: CONCEPT });
  });

  it('PA-009 refuses anything that is not a chart identifier as the mother', () => {
    expect(searchPatientsSchema.safeParse({ motherId: 'Guamán' }).success).toBe(
      false,
    );
  });
});

describe('correcting a chart', () => {
  it('PA-031 accepts a correction of a single field and leaves the rest absent', () => {
    const result = correctPatientSchema.safeParse({ familyName: 'Guamán' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ familyName: 'Guamán' });
  });

  it('PA-031 tells absent apart from an explicit null', () => {
    // Absent means "do not touch"; `null` means "clear it". Collapsing them
    // would make every unsent field an erasure — data loss dressed as an
    // update.
    const cleared = correctPatientSchema.safeParse({ phone: null });
    expect(cleared.data).toEqual({ phone: null });
    expect('phone' in (cleared.data ?? {})).toBe(true);
  });

  it('PA-031 refuses a body with no correctable field at all', () => {
    /**
     * A 200 that changed nothing makes the desk believe the correction was
     * saved, and what they then see is the previous chart — which reads as a
     * caching problem and gets reported as one.
     */
    expect(correctPatientSchema.safeParse({}).success).toBe(false);
  });

  it('PA-002 refuses a body whose only field is the medical record number', () => {
    // The MRN is not on the list, so it is stripped, and what remains is a
    // body with nothing to correct. The identity anchor never changes.
    expect(
      correctPatientSchema.safeParse({ mrn: 'HC0000000999' }).success,
    ).toBe(false);
  });

  it('PA-008 takes the date of death as a DATE, which is what the desk knows', () => {
    expect(
      correctPatientSchema.safeParse({ deceasedAt: '2026-03-03' }).success,
    ).toBe(true);
    // Not an instant: whoever is at the counter has a date, and accepting a
    // timestamp would let the client decide the zone the death falls in.
    expect(
      correctPatientSchema.safeParse({ deceasedAt: '2026-03-03T00:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('PA-008 accepts clearing a date of death recorded by mistake', () => {
    expect(correctPatientSchema.safeParse({ deceasedAt: null }).data).toEqual({
      deceasedAt: null,
    });
  });

  it('PA-008 refuses a date of death later than today in Ecuador', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL MISMO ERROR DE TECLEO, EN LA OTRA DIRECCIÓN.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El CHECK de la base justifica su existencia con «un año mal tecleado
     * —2016 por 2026—», y el argumento es SIMÉTRICO: 2062 por 2026 se aceptaba.
     * Y como la edad se resuelve contra la fecha de fallecimiento cuando la hay
     * (PA-030), la ficha y cada fila del listado reportaban setenta y dos años
     * para alguien de treinta y seis, congelado para siempre.
     */
    const result = correctPatientSchema.safeParse({
      deceasedAt: daysFromToday(1),
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['deceasedAt']);
    expect(issue?.message).toBe(
      'La fecha de fallecimiento no puede ser posterior a hoy',
    );
  });

  it('PA-008 accepts a death recorded TODAY, which is the exact boundary', () => {
    // Alguien que murió esta mañana se registra esta mañana. La cota corre en
    // `America/Guayaquil` y no en el huso del proceso: a las 21:00 aquí la
    // fecha UTC ya es la de mañana, y con el huso equivocado la franja
    // vespertina rechazaría fechas de hoy perfectamente válidas.
    expect(
      correctPatientSchema.safeParse({ deceasedAt: todayInEcuador() }).success,
    ).toBe(true);
  });

  it('PA-006 refuses a corrected birth date later than today in Ecuador', () => {
    // La corrección usa el MISMO esquema de fecha que el alta, no una copia.
    const result = correctPatientSchema.safeParse({
      birthDate: daysFromToday(1),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['birthDate']);
  });
});

describe('adding a document to an existing chart', () => {
  it('PA-015 validates the cedula check digit exactly as registration does', () => {
    // The SAME schema, not a copy: two implementations of the check digit are
    // two that must agree for ever, and the second is the one left behind.
    expect(
      addIdentifierSchema.safeParse({
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: VALID_CEDULA,
      }).success,
    ).toBe(true);

    const wrong = addIdentifierSchema.safeParse({
      type: 'CEDULA',
      issuingCountry: 'ECU',
      value: '1710034064',
    });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.path).toEqual(['value']);
  });

  it('PA-015 does NOT apply the Ecuadorian check digit to a foreign document', () => {
    expect(
      addIdentifierSchema.safeParse({
        type: 'PASSPORT',
        issuingCountry: 'COL',
        value: 'AB123456',
      }).success,
    ).toBe(true);
  });
});
