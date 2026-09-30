import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import { PrismaPatientAllergyRepository } from '../../src/modules/encounter/infrastructure/prisma-patient-allergy.repository';
import { PrismaChartSummaryRepository } from '../../src/modules/encounter/infrastructure/prisma-chart-summary.repository';
import { PrismaClinicalCodingRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-coding.repository';
import { PrismaActiveAllergyReader } from '../../src/shared/infrastructure/clinical/prisma-active-allergy.reader';
import {
  AllergyAlreadyRefutedError,
  ConceptWrongCatalogueError,
} from '../../src/modules/encounter/domain/encounter.errors';
import type {
  NewAllergy,
  RefuteAllergy,
} from '../../src/modules/encounter/domain/patient-allergy.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * REQ-008 against a real PostgreSQL — the two things a double cannot show.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. THAT REFUTING DOES NOT DELETE (EN-082) — «sólo se ve contando filas»
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The SPEC says it in those words, and it is right: a repository double
 * returns whatever it was told to, so «no se borró» has to be asserted against
 * the table. What the requirement protects is the patient who was told they
 * were allergic to penicillin and turned out not to be — if that row
 * disappears, in two years somebody writes it again and again withholds the
 * right antibiotic.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2. THAT A MERGED CHART DOES NOT LOSE HALF ITS ALLERGIES (PA-055, EN-081)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the scene `patient-chart-scope.ts` opens with: admissions merges two
 * charts correctly, the absorbed one held the penicillin allergy, the doctor
 * opens the survivor and sees nothing. A merge re-points nothing (D-031), so
 * the absorbed chart's rows keep their own `patient_id`; a read by the bare id
 * omits them and NEITHER FAILS NOR WARNS. Only a real merge on a real database
 * shows that the reads follow the link.
 */
const db = useDatabase();

/**
 * The adapter, with EN-086's author filled in for the tests that are about
 * something else. The tests about the author pass one explicitly.
 */
class AuthoredAllergies extends PrismaPatientAllergyRepository {
  constructor(private readonly client: PrismaClient) {
    super(client as unknown as PrismaService);
  }

  override async record(
    allergy: Omit<NewAllergy, 'recordedById'> & { recordedById?: string },
  ) {
    return super.record({
      ...allergy,
      recordedById: allergy.recordedById ?? (await createUser(this.client)).id,
    });
  }

  override async refute(
    refutation: Omit<RefuteAllergy, 'refutedById'> & { refutedById?: string },
  ) {
    return super.refute({
      ...refutation,
      refutedById: refutation.refutedById ?? (await createUser(this.client)).id,
    });
  }
}

const allergiesOf = (prisma: PrismaClient) => new AuthoredAllergies(prisma);

const activeOf = (prisma: PrismaClient) =>
  new PrismaActiveAllergyReader(prisma as unknown as PrismaService);

const summariesOf = (prisma: PrismaClient) =>
  new PrismaChartSummaryRepository(prisma as unknown as PrismaService);

const encountersOf = (prisma: PrismaClient) =>
  new PrismaEncounterRepository(prisma as unknown as PrismaService);

const codingOf = (prisma: PrismaClient) =>
  new PrismaClinicalCodingRepository(prisma as unknown as PrismaService);

/** A concept of a named catalogue, so the CNMB check has something to refuse. */
async function aConcept(
  prisma: PrismaClient,
  systemCode: string,
  code: string,
  display = 'Amoxicilina 500 mg',
) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: systemCode },
    create: { code: systemCode, name: `Catálogo ${systemCode}` },
    update: {},
  });
  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code,
      display,
      validFrom: new Date('2020-01-01'),
    },
  });
}

describe('las alergias del paciente contra PostgreSQL', () => {
  it('EN-080 guarda la alergia estructurada, con su concepto del CNMB', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const concept = await aConcept(prisma, 'CNMB', 'J01CA04');

    const allergy = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceConceptId: concept.id,
      substanceText: 'Amoxicilina',
      reaction: 'Urticaria generalizada',
      criticality: 'HIGH',
    });

    const stored = await prisma.patientAllergy.findUniqueOrThrow({
      where: { id: allergy.id },
    });
    expect(stored.substanceConceptId).toBe(concept.id);
    expect(stored.substanceText).toBe('Amoxicilina');
    expect(stored.criticality).toBe('HIGH');
    // Y el enlace al catálogo es una clave foránea de verdad: la fila apunta
    // a un concepto que existe, no a un texto que se parece a uno.
    expect(stored.refutedAt).toBeNull();
  });

  it('EN-080 rechaza un concepto de otro catálogo, que la clave foránea aceptaría', async () => {
    /**
     * `substance_concept_id` apunta a `catalog_concept`, que guarda TODOS los
     * catálogos: nada en el esquema impide archivar una enfermedad CIE-10 como
     * la sustancia a la que alguien es alérgico. La fila se aceptaría, estaría
     * perfectamente formada, y no coincidiría jamás con nada que una
     * prescripción comprueba — una comprobación de seguridad que pasa en
     * silencio durante el resto de la vida del paciente.
     */
    const prisma = db();
    const patient = await createPatient(prisma);
    const cie10 = await aConcept(prisma, 'CIE10', 'J020', 'Faringitis aguda');

    await expect(
      allergiesOf(prisma).record({
        patientId: patient.id,
        substanceConceptId: cie10.id,
        substanceText: 'Faringitis',
        criticality: 'LOW',
      }),
    ).rejects.toBeInstanceOf(ConceptWrongCatalogueError);

    expect(await prisma.patientAllergy.count()).toBe(0);
  });

  it('EN-083 deja `UNABLE_TO_ASSESS` como valor de la columna, que dice «no se sabe» y no «es leve»', async () => {
    // La misma decisión que `NOT_APPLIED` en el tamizaje. Lo que ninguna ruta
    // hace es convertir una respuesta ausente en `LOW`.
    const prisma = db();
    const patient = await createPatient(prisma);

    const [row] = await prisma.$queryRaw<{ default_value: string | null }[]>`
      SELECT column_default AS default_value
        FROM information_schema.columns
       WHERE table_name = 'patient_allergy' AND column_name = 'criticality'
    `;

    expect(row?.default_value).toContain('UNABLE_TO_ASSESS');

    const stored = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceText: 'Mariscos',
      criticality: 'UNABLE_TO_ASSESS',
    });
    expect(stored.criticality).toBe('UNABLE_TO_ASSESS');
  });

  it('EN-082 refuta sin borrar: la fila sigue ahí y deja de contar como activa', async () => {
    /**
     * CONTANDO FILAS, que es la única forma de demostrarlo. Antes y después
     * hay exactamente una fila en `patient_allergy`; lo que cambia es que el
     * lector activo ya no la trae y el listado completo sí, con su fecha y su
     * motivo.
     */
    const prisma = db();
    const patient = await createPatient(prisma);
    const repository = allergiesOf(prisma);

    const allergy = await repository.record({
      patientId: patient.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
    });
    expect(await prisma.patientAllergy.count()).toBe(1);

    const refuted = await repository.refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: 'Prueba cutánea negativa el 20-08-2026',
      now: new Date('2026-08-20T15:00:00Z'),
    });

    expect(await prisma.patientAllergy.count()).toBe(1);
    expect(refuted?.refutedAt).not.toBeNull();
    expect(refuted?.refutedNotes).toBe('Prueba cutánea negativa el 20-08-2026');

    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(0);
    const listed = await repository.listFor(patient.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.refutedNotes).toBe(
      'Prueba cutánea negativa el 20-08-2026',
    );
  });

  it('EN-082 rechaza la segunda refutación en vez de reescribir la primera', async () => {
    // Aceptarla sobrescribiría la fecha y el motivo de quien la descartó, que
    // es justo el dato que el requisito existe para conservar.
    const prisma = db();
    const patient = await createPatient(prisma);
    const repository = allergiesOf(prisma);

    const allergy = await repository.record({
      patientId: patient.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
    });
    await repository.refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: 'Primera valoración',
      now: new Date('2026-08-20T15:00:00Z'),
    });

    await expect(
      repository.refute({
        patientId: patient.id,
        allergyId: allergy.id,
        notes: 'Segunda valoración',
        now: new Date('2026-08-21T09:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(AllergyAlreadyRefutedError);

    const stored = await prisma.patientAllergy.findUniqueOrThrow({
      where: { id: allergy.id },
    });
    expect(stored.refutedNotes).toBe('Primera valoración');
  });

  it('EN-082 no encuentra una alergia de otra ficha: una sola negativa, sin confirmar nada', async () => {
    const prisma = db();
    const mine = await createPatient(prisma);
    const someoneElse = await createPatient(prisma);
    const repository = allergiesOf(prisma);

    const theirs = await repository.record({
      patientId: someoneElse.id,
      substanceText: 'Látex',
      criticality: 'LOW',
    });

    const answer = await repository.refute({
      patientId: mine.id,
      allergyId: theirs.id,
      notes: 'motivo',
      now: new Date('2026-08-20T15:00:00Z'),
    });

    // `null`, que el servicio convierte en `PATIENT_ALLERGY_NOT_FOUND` — el
    // mismo que para «no existe».
    expect(answer).toBeNull();
    const untouched = await prisma.patientAllergy.findUniqueOrThrow({
      where: { id: theirs.id },
    });
    expect(untouched.refutedAt).toBeNull();
  });

  it('EN-081 la alergia de la ficha ABSORBIDA sigue viéndose desde la superviviente', async () => {
    /**
     * ⚠️ ESTA ES LA PRUEBA DE PA-009 CON UNA RECETA AL FINAL. Admisión fusiona
     * bien las dos fichas de la misma persona; la absorbida llevaba la alergia
     * a la penicilina. Una lectura por el `patient_id` desnudo devuelve media
     * historia y NO FALLA NI AVISA: simplemente omite. En una consulta eso es
     * una alergia que no aparece.
     */
    const prisma = db();
    const absorbed = await createPatient(prisma);
    const surviving = await createPatient(prisma);
    const repository = allergiesOf(prisma);

    await repository.record({
      patientId: absorbed.id,
      substanceText: 'Penicilina',
      reaction: 'Anafilaxia',
      criticality: 'HIGH',
    });
    await repository.record({
      patientId: surviving.id,
      substanceText: 'Ibuprofeno',
      criticality: 'LOW',
    });

    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: surviving.id, mergedAt: new Date() },
    });

    const active = await activeOf(prisma).activeFor(surviving.id);

    expect(active).toHaveLength(2);
    // EN-083. La peor primero: es la que cambia lo que el médico hace en los
    // próximos treinta segundos.
    expect(active[0]?.substanceText).toBe('Penicilina');
    expect(active[0]?.patientId).toBe(absorbed.id);
    // Y el listado completo la ve igual, porque resuelve el mismo alcance.
    expect(await repository.listFor(surviving.id)).toHaveLength(2);
  });

  it('EN-082 se puede refutar desde la superviviente una alergia escrita en la ficha absorbida', async () => {
    // Después de una fusión hay UNA persona: un 404 aquí le diría al médico
    // que la alergia que tiene en pantalla no existe.
    const prisma = db();
    const absorbed = await createPatient(prisma);
    const surviving = await createPatient(prisma);
    const repository = allergiesOf(prisma);

    const allergy = await repository.record({
      patientId: absorbed.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
    });
    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: surviving.id, mergedAt: new Date() },
    });

    const refuted = await repository.refute({
      patientId: surviving.id,
      allergyId: allergy.id,
      notes: 'Descartada tras interconsulta con alergología',
      now: new Date('2026-08-20T15:00:00Z'),
    });

    expect(refuted?.refutedAt).not.toBeNull();
    expect(await prisma.patientAllergy.count()).toBe(1);
  });

  it('EN-159 el resumen de la consulta incluye las atenciones de la ficha absorbida', async () => {
    /**
     * La misma omisión silenciosa, del otro lado: si el resumen leyera por el
     * `patient_id` desnudo, la consulta de marzo en la ficha vieja —con su
     * diagnóstico— desaparecería de la pantalla del médico.
     */
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const absorbed = await createPatient(prisma);
    const surviving = await createPatient(prisma);
    const encounters = encountersOf(prisma);

    const opening = (patientId: string, startedAt: Date) => ({
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId,
      startedAt,
      careModality: 'MORBIDITY' as const,
      careSetting: 'INTRAMURAL' as const,
      visitSequence: 'FIRST_TIME' as const,
    });

    await encounters.open(
      opening(absorbed.id, new Date('2026-03-02T14:00:00Z')),
    );
    await encounters.open(
      opening(surviving.id, new Date('2026-06-10T14:00:00Z')),
    );
    const today = await encounters.open(
      opening(surviving.id, new Date('2026-08-20T14:00:00Z')),
    );

    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: surviving.id, mergedAt: new Date() },
    });

    const query = {
      patientId: surviving.id,
      sites: [site.id],
      excludeEncounterId: today.id,
      limit: 5,
    };
    const previous = await summariesOf(prisma).previousEncounters(query);

    expect(previous).toHaveLength(2);
    // La de hoy queda fuera de «las anteriores», y la más reciente va primero.
    expect(previous.map((row) => row.id)).not.toContain(today.id);
    expect(previous[0]?.startedAt.toISOString()).toBe(
      '2026-06-10T14:00:00.000Z',
    );
    // La de la ficha absorbida, que una lectura por el id desnudo habría
    // omitido sin decir nada.
    expect(previous[1]?.startedAt.toISOString()).toBe(
      '2026-03-02T14:00:00.000Z',
    );
    expect(await summariesOf(prisma).countEncounters(query)).toBe(2);
  });

  it('EN-159 el resumen trae el diagnóstico CONGELADO y los signos vitales de cada atención anterior', async () => {
    /**
     * El código y la descripción son los que `trg_diagnosis_snapshot` escribió
     * el día del diagnóstico, no los que el catálogo diga hoy: dentro de
     * quince años el catálogo puede haberse migrado y el resumen sigue
     * teniendo que decir qué se diagnosticó.
     */
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const encounters = encountersOf(prisma);
    const concept = await aConcept(
      prisma,
      'CIE10',
      'J020',
      'Faringitis estreptocócica',
    );

    const previousEncounter = await encounters.open({
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: new Date('2026-05-11T14:00:00Z'),
      careModality: 'MORBIDITY',
      careSetting: 'INTRAMURAL',
      visitSequence: 'FIRST_TIME',
    });
    const today = await encounters.open({
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: new Date('2026-08-20T14:00:00Z'),
      careModality: 'MORBIDITY',
      careSetting: 'INTRAMURAL',
      visitSequence: 'SUBSEQUENT',
    });

    // Por el adaptador del bloque K y no por `prisma.encounterDiagnosis`
    // directamente: el código y la descripción los escribe
    // `trg_diagnosis_snapshot`, y escribirlos a mano aquí probaría que el
    // resumen devuelve lo que la prueba tecleó, no lo que la base congeló.
    await codingOf(prisma).addDiagnosis({
      encounterId: previousEncounter.id,
      conceptId: concept.id,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      rank: 1,
      sites: [site.id],
    });
    await encounters.saveVitals(
      { encounterId: previousEncounter.id, sites: [site.id] },
      {
        weightKg: 68.4,
        heightCm: 165,
        heightPosition: 'STANDING',
        systolicBp: 120,
        diastolicBp: 80,
        temperatureC: 36.8,
        measuredAt: new Date('2026-05-11T14:05:00Z'),
      },
      practitioner.userId,
    );

    const [previous] = await summariesOf(prisma).previousEncounters({
      patientId: patient.id,
      sites: [site.id],
      excludeEncounterId: today.id,
      limit: 5,
    });

    expect(previous?.diagnoses[0]?.cie10Code).toBe('J020');
    expect(previous?.diagnoses[0]?.cie10Display).toBe(
      'Faringitis estreptocócica',
    );
    expect(previous?.diagnoses[0]?.rank).toBe(1);
    expect(previous?.vitals?.weightKg).toBe(68.4);
    // EN-061. El IMC es el que escribió `trg_encounter_vitals_bmi`, no uno
    // derivado aquí: 68,4 kg y 1,65 m dan 25,12.
    expect(previous?.vitals?.bmi).toBeCloseTo(25.12, 2);
  });

  it('EN-121 el resumen omite las atenciones de una sede fuera del alcance de quien pregunta', async () => {
    // Es un coste real —el médico de la sede sur no ve lo que se diagnosticó
    // en el centro— y es el mismo que ya paga el listado de atenciones.
    // Ampliarlo aquí convertiría el resumen en un rodeo al alcance por sede.
    const prisma = db();
    const site = await createSite(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const encounters = encountersOf(prisma);

    await encounters.open({
      siteId: otherSite.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: new Date('2026-05-11T14:00:00Z'),
      careModality: 'MORBIDITY',
      careSetting: 'INTRAMURAL',
      visitSequence: 'FIRST_TIME',
    });
    const today = await encounters.open({
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: new Date('2026-08-20T14:00:00Z'),
      careModality: 'MORBIDITY',
      careSetting: 'INTRAMURAL',
      visitSequence: 'SUBSEQUENT',
    });

    const previous = await summariesOf(prisma).previousEncounters({
      patientId: patient.id,
      sites: [site.id],
      excludeEncounterId: today.id,
      limit: 5,
    });

    expect(previous).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * EN-087 — «SIN ALERGIAS CONOCIDAS» ES UNA AFIRMACIÓN, NO UNA CASILLA VACÍA
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Las tres garantías de abajo viven en la base y sólo en la base: el
   * disparador de inmutabilidad, el que rechaza la afirmación sobre una ficha
   * con alergias —las suyas y las de la ficha que absorbió— y la regla de que
   * una alergia posterior deja de servirla. Un doble contesta lo que se le pida
   * y no demuestra ninguna.
   */

  it('EN-087 registra la afirmación con su autor y su instante, y la sirve como vigente', async () => {
    /**
     * La frase del estándar hecha fila: «una afirmación positiva por parte de
     * un usuario clínico, y no una posición por defecto afirmada por un sistema
     * informático a falta de otra información». Sin `asserted_by` esto sería
     * otra vez el silencio de una base de datos.
     */
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const repository = allergiesOf(prisma);

    const assertion = await repository.assertNoKnownAllergies({
      patientId: patient.id,
      assertedById: practitioner.userId,
    });

    expect(assertion.assertedById).toBe(practitioner.userId);
    // El nombre viaja porque es lo que se lee en la banda: «Sin alergias
    // conocidas (Ana Villacís, 20-08-2026)».
    expect(assertion.assertedByName).toBe('Ana Villacís');

    const standing = await repository.standingAbsenceFor(patient.id);
    expect(standing?.id).toBe(assertion.id);
  });

  it('EN-087 sin afirmación devuelve `null`: es «no se preguntó», no «no tiene»', async () => {
    // Una ficha vacía y sin afirmación es exactamente «no lo sabemos». Que la
    // lectura devuelva `null` y no algo parecido a «ninguna» es el requisito.
    const prisma = db();
    const patient = await createPatient(prisma);

    expect(await allergiesOf(prisma).standingAbsenceFor(patient.id)).toBeNull();
  });

  it('EN-087 la base rechaza la afirmación sobre una ficha con alergias, aunque el servicio no mire', async () => {
    /**
     * ⚠️ CONTRA LA BASE Y NO CONTRA EL SERVICIO. El servicio comprueba y da una
     * frase legible; lo que no puede es arbitrar dos peticiones simultáneas
     * —registrar la alergia y afirmar que no hay ninguna— que leen las dos un
     * estado que deja de ser cierto un milisegundo después. Aquí se escribe
     * directamente en la tabla, que es lo que hace la petición que gana la
     * carrera.
     */
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);

    await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
    });

    await expect(
      prisma.patientAllergyAbsence.create({
        data: { patientId: patient.id, assertedById: practitioner.userId },
      }),
    ).rejects.toThrow();

    expect(await prisma.patientAllergyAbsence.count()).toBe(0);
  });

  it('EN-087 el rechazo alcanza la alergia de la ficha ABSORBIDA, no sólo la propia', async () => {
    /**
     * PA-009 con una receta al final, otra vez: mirar sólo `NEW.patient_id`
     * dejaría afirmar «ninguna» sobre una ficha cuya alergia a la penicilina
     * vive en la absorbida, y la banda escribiría «sin alergias conocidas»
     * encima de ella.
     */
    const prisma = db();
    const absorbed = await createPatient(prisma);
    const surviving = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);

    await allergiesOf(prisma).record({
      patientId: absorbed.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
    });
    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: surviving.id, mergedAt: new Date() },
    });

    await expect(
      prisma.patientAllergyAbsence.create({
        data: { patientId: surviving.id, assertedById: practitioner.userId },
      }),
    ).rejects.toThrow();
  });

  it('EN-087 una alergia posterior deja de servir la afirmación, y refutarla NO la resucita', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * AFIRMADO EN MARZO · PENICILINA EN ABRIL · DESCARTADA EN MAYO
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La ficha vuelve a estar vacía y NADIE HA PREGUNTADO DESDE ENTONCES. La
     * afirmación de marzo no era falsa —fue cierta hasta abril— pero ya no es
     * la última palabra sobre esta ficha, así que el estado es «no se
     * preguntó» hasta que un clínico diga otra cosa.
     *
     * Servir la de marzo aquí sería exactamente «una posición por defecto
     * afirmada por un sistema informático», que es la frase que el requisito
     * existe para obedecer.
     */
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const repository = allergiesOf(prisma);

    const assertion = await prisma.patientAllergyAbsence.create({
      data: {
        patientId: patient.id,
        assertedById: practitioner.userId,
        assertedAt: new Date('2026-03-14T15:00:00Z'),
      },
    });
    expect((await repository.standingAbsenceFor(patient.id))?.id).toBe(
      assertion.id,
    );

    const allergy = await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId: patient.id,
        substanceText: 'Penicilina',
        criticality: 'HIGH',
        recordedAt: new Date('2026-04-02T15:00:00Z'),
      },
    });
    expect(await repository.standingAbsenceFor(patient.id)).toBeNull();

    await repository.refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: 'Prueba cutánea negativa',
      now: new Date('2026-05-20T15:00:00Z'),
    });

    // La ficha está vacía otra vez y la respuesta sigue siendo «no se
    // preguntó». La fila de marzo no se ha borrado: deja de ser la vigente.
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(0);
    expect(await repository.standingAbsenceFor(patient.id)).toBeNull();
    expect(await prisma.patientAllergyAbsence.count()).toBe(1);
  });

  it('EN-087 la afirmación de la ficha ABSORBIDA se sigue viendo desde la superviviente', async () => {
    // Es historia de la PERSONA, no del papel: una fusión no repunta nada
    // (D-031) y la superviviente lee por el enlace, como con las alergias.
    const prisma = db();
    const absorbed = await createPatient(prisma);
    const surviving = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);

    const assertion = await prisma.patientAllergyAbsence.create({
      data: { patientId: absorbed.id, assertedById: practitioner.userId },
    });
    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: surviving.id, mergedAt: new Date() },
    });

    const standing = await allergiesOf(prisma).standingAbsenceFor(surviving.id);

    expect(standing?.id).toBe(assertion.id);
    expect(standing?.patientId).toBe(absorbed.id);
  });

  it('EN-087 la afirmación no se puede editar ni borrar: UPDATE, DELETE y TRUNCATE fallan', async () => {
    /**
     * Una afirmación clínica fechada y firmada que se puede reescribir no es
     * una afirmación: es una casilla. Y el `TRUNCATE` va aparte porque un
     * disparador `FOR EACH ROW` no lo cubre — es el mismo hueco que la bitácora
     * y la cadena de notas tapan con su segundo disparador.
     */
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);

    const assertion = await prisma.patientAllergyAbsence.create({
      data: { patientId: patient.id, assertedById: practitioner.userId },
    });

    await expect(
      prisma.patientAllergyAbsence.update({
        where: { id: assertion.id },
        data: { assertedAt: new Date('2020-01-01T00:00:00Z') },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.patientAllergyAbsence.delete({ where: { id: assertion.id } }),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE patient_allergy_absence'),
    ).rejects.toThrow();

    expect(await prisma.patientAllergyAbsence.count()).toBe(1);
  });

  it('EN-086 la alergia nombra en la fila a quien la registro y a quien la descarto', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const nurse = await createUser(prisma);
    const doctor = await createUser(prisma);
    const repository = allergiesOf(prisma);

    const recorded = await repository.record({
      patientId: patient.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
      recordedById: nurse.id,
    });
    expect(recorded.recordedBy).toEqual({
      id: nurse.id,
      name: 'Carmen Salazar',
    });
    expect(recorded.refutedBy).toBeNull();

    const refuted = await repository.refute({
      patientId: patient.id,
      allergyId: recorded.id,
      notes: 'Prueba cutánea negativa',
      now: new Date(),
      refutedById: doctor.id,
    });
    expect(refuted?.recordedBy?.id).toBe(nurse.id);
    expect(refuted?.refutedBy?.id).toBe(doctor.id);
  });

  it('EN-086 la base rechaza una alergia escrita sin autor, y la descartada sin quien la descarto', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const author = await createUser(prisma);

    // Control positivo: la misma fila con autor entra.
    const allergy = await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        substanceText: 'Látex',
        criticality: 'LOW',
        recordedById: author.id,
      },
    });
    await expect(
      prisma.patientAllergy.create({
        data: {
          patientId: patient.id,
          substanceText: 'Látex',
          criticality: 'LOW',
        },
      }),
    ).rejects.toThrow(/patient_allergy_names_its_author/);
    await expect(
      prisma.patientAllergy.update({
        where: { id: allergy.id },
        data: { refutedAt: new Date(), refutedNotes: 'No era alergia' },
      }),
    ).rejects.toThrow(/patient_allergy_refutation_names_its_author/);
  });
});
