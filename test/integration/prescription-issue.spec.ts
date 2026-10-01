import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { PrescriptionService } from '../../src/modules/prescription/application/prescription.service';
import { PrismaPrescriptionRepository } from '../../src/modules/prescription/infrastructure/prisma-prescription.repository';
import { PrismaActiveAllergyReader } from '../../src/shared/infrastructure/clinical/prisma-active-allergy.reader';
import '../../src/modules/prescription/infrastructure/prescription.constraints';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { createPatient, createSite, createUser } from './setup/fixtures';

/**
 * The prescription against a real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GUARANTEES THAT ONLY THE DATABASE CAN DEMONSTRATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - PR-003: `prescription_issued_coherence`. A draft cannot carry an instant
 *    of issue and an issued prescription cannot be missing one — which is what
 *    keeps the validity of art. 18 computable for ever.
 *  - PR-011: `prescription_discard_states_who_when_and_why` and
 *    `prescription_discard_only_from_draft`. Discarding a draft demands who,
 *    when and why TOGETHER, and cannot touch a prescription that was issued —
 *    that one is annulled, which is the other act. Both are `CHECK`s, so both
 *    are shown here rather than trusted to the service that writes them.
 *  - PR-009: `prescription_item_off_formulary`. Prescribing outside the CNMB is
 *    allowed; not saying why is not.
 *  - PR-007: the concept has to be a CNMB medicine IN FORCE on the clinical
 *    date, resolved with `AT TIME ZONE 'America/Guayaquil'`. A double returning
 *    what we asked it for proves nothing about a `daterange @>`.
 *  - PR-062: the allergy of an ABSORBED chart refuses the issue from the
 *    surviving one. This one cannot be shown any other way at all: it depends
 *    on the merge link being walked in the database.
 *
 * ⚠️ AND THE FIRST TWO ARE EXERCISED THROUGH RAW SQL AS WELL AS THROUGH THE
 * REPOSITORY, which is how an import, a `psql` or a use case somebody writes in
 * two years reaches them. If only the first path were tested, an application
 * check would look indistinguishable from a database guarantee.
 */
const db = useDatabase();

/** PR-038, PR-039. Art. 5.e of the receta, demanded at the issue. */
const INDICATIONS = {
  warningSigns: 'Fiebre mayor de 39 °C o dificultad para respirar',
  nonPharmacologicalAdvice: 'Abundantes líquidos y reposo relativo',
};

const ENCOUNTER_STARTED_AT = new Date('2026-09-14T14:00:00Z');

const repositoryOf = (prisma: PrismaClient) =>
  new PrismaPrescriptionRepository(prisma as unknown as PrismaService);

const serviceOf = (prisma: PrismaClient) => {
  const audit: AccessAuditRecorder = { record: () => Promise.resolve() };
  const logger = { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger; // prettier-ignore
  return new PrescriptionService(
    repositoryOf(prisma),
    // PR-062. El MISMO lector que usa la consulta del médico: «la ficha y las
    // que absorbió» se escribe una vez para todo el sistema.
    new PrismaActiveAllergyReader(prisma as unknown as PrismaService),
    audit,
    logger,
  );
};

/** A CNMB medicine as the catalogue holds it: a system and a versioned concept. */
async function aCnmbConcept(
  prisma: PrismaClient,
  concept: { code: string; display: string; validFrom: Date; validTo?: Date },
  systemCode = 'CNMB',
) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: systemCode },
    create: { code: systemCode, name: `Catálogo ${systemCode}` },
    update: {},
  });

  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code: concept.code,
      display: concept.display,
      validFrom: concept.validFrom,
      validTo: concept.validTo ?? null,
    },
  });
}

/**
 * PR-021. A site whose parish hangs off a canton, which is «la ciudad» of art.
 * 5.a.ii.
 *
 * TWO CONCEPTS AND NOT ONE, because the city is the PARENT of the parish in the
 * DPA tree: `site` has no city column (⚠️ **Falta esquema**), and the two hops
 * are what the adapter walks.
 */
async function aSiteWithCity(prisma: PrismaClient, city = 'Quito') {
  const system = await prisma.catalogSystem.upsert({
    where: { code: 'DPA' },
    create: { code: 'DPA', name: 'División política administrativa', hierarchical: true }, // prettier-ignore
    update: {},
  });
  const canton = await prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code: '1701',
      display: city,
      validFrom: new Date('2010-01-01'),
    },
  });
  const parish = await prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code: '170150',
      display: 'Iñaquito',
      parentId: canton.id,
      validFrom: new Date('2010-01-01'),
    },
  });

  const site = await createSite(prisma);
  return prisma.site.update({
    where: { id: site.id },
    data: { parishConceptId: parish.id },
  });
}

/** PR-004, PR-034. A prescriber with an ACESS registration in force. */
async function aPrescriber(
  prisma: PrismaClient,
  overrides: { acessRegistration?: string | null; acessExpiresOn?: Date | null } = {}, // prettier-ignore
) {
  const user = await prisma.user.create({
    data: {
      email: `medico-${Date.now()}-${Math.trunc(performance.now() * 1000)}@clinica.ec`, // prettier-ignore
      passwordHash: 'not-a-real-hash',
      firstName: 'Ana',
      lastName: 'Villacís',
      acessRegistration:
        overrides.acessRegistration === undefined
          ? 'ACESS-11223'
          : overrides.acessRegistration,
      acessExpiresOn:
        overrides.acessExpiresOn === undefined
          ? new Date('2030-01-01')
          : overrides.acessExpiresOn,
    },
  });
  return prisma.practitioner.create({ data: { userId: user.id } });
}

/** An attention ready to be prescribed on, with everything art. 5 needs. */
async function anEncounter(prisma: PrismaClient) {
  const site = await aSiteWithCity(prisma);
  const practitioner = await aPrescriber(prisma);
  const patient = await createPatient(prisma);

  const encounter = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: ENCOUNTER_STARTED_AT,
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });

  return {
    site,
    practitioner,
    patient,
    encounter,
    requester: {
      userId: practitioner.userId,
      sites: [site.id] as const,
    },
  };
}

const aLine = (conceptId: string | null) => ({
  conceptId,
  genericName: conceptId === null ? 'Amoxicilina' : null,
  presentation: 'Cápsula',
  concentration: '500 mg',
  routeCode: 'ORAL',
  quantity: 20,
  doseText: '1 cápsula',
  frequencyText: 'Cada 8 horas',
  durationDays: 7,
  instructions: null,
  offFormularyJustification: null,
});

/** Runs an operation expected to fail and maps whatever it threw. */
async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error('the operation should have failed');
  } catch (error) {
    return extractDatabaseProblem(error);
  }
}

describe('la receta contra PostgreSQL', () => {
  it('PR-003 nace en borrador y sin instante de emisión', async () => {
    const prisma = db();
    const { encounter, practitioner, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });

    const prescription = await repositoryOf(prisma).create({
      encounterId: encounter.id,
      prescriberId: practitioner.id,
      ...INDICATIONS,
      items: [aLine(concept.id)],
      sites: [...requester.sites],
    });

    expect(prescription.status).toBe('DRAFT');
    expect(prescription.issuedAt).toBeNull();
    expect(prescription.verificationCode).toBeNull();
  });

  it('PR-003 la BASE rechaza un borrador con instante de emisión', async () => {
    /**
     * `prescription_issued_coherence`: `(status = 'DRAFT') = (issued_at IS
     * NULL)`. Lo que impide es una receta que dice estar emitida y no puede
     * decir cuándo, que deja la vigencia del art. 18 sin poder calcularse nunca.
     */
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);

    const problem = await problemFrom(
      prisma.$executeRawUnsafe(
        `INSERT INTO prescription (encounter_id, prescriber_id, status, issued_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'DRAFT', now(), now())`,
        encounter.id,
        practitioner.id,
      ),
    );

    expect(problem?.code).toBe('PRESCRIPTION_STATE_INCONSISTENT');
    expect(problem?.status).toBe(422);
  });

  it('PR-009 la BASE rechaza una línea sin concepto y sin justificación', async () => {
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);

    const prescription = await prisma.prescription.create({
      data: {
        encounterId: encounter.id,
        siteId: encounter.siteId,
        prescriberId: practitioner.id,
      },
    });

    const problem = await problemFrom(
      prisma.$executeRawUnsafe(
        `INSERT INTO prescription_item
           (prescription_id, generic_name, dose_text, frequency_text)
         VALUES ($1::uuid, 'Amoxicilina', '1 cápsula', 'Cada 8 horas')`,
        prescription.id,
      ),
    );

    expect(problem?.code).toBe('OFF_FORMULARY_JUSTIFICATION_REQUIRED');
    expect(problem?.status).toBe(422);
  });

  it('PR-009 el servicio se adelanta con una frase sobre la casilla', async () => {
    const prisma = db();
    const { encounter, practitioner, requester } = await anEncounter(prisma);

    await expect(
      repositoryOf(prisma).create({
        encounterId: encounter.id,
        prescriberId: practitioner.id,
        ...INDICATIONS,
        items: [aLine(null)],
        sites: [...requester.sites],
      }),
    ).rejects.toMatchObject({ code: 'OFF_FORMULARY_JUSTIFICATION_REQUIRED' });
  });

  it('PR-009 admite recetar fuera del CNMB cuando se escribe por qué', async () => {
    const prisma = db();
    const { encounter, practitioner, requester } = await anEncounter(prisma);

    const prescription = await repositoryOf(prisma).create({
      encounterId: encounter.id,
      prescriberId: practitioner.id,
      ...INDICATIONS,
      items: [
        {
          ...aLine(null),
          offFormularyJustification: 'Desabastecimiento del equivalente CNMB',
        },
      ],
      sites: [...requester.sites],
    });

    expect(prescription.items[0]?.conceptId).toBeNull();
    expect(prescription.items[0]?.genericName).toBe('Amoxicilina');
  });

  it('PR-008 congela la DCI del concepto y no la que envíe el llamador', async () => {
    /**
     * ⚠️ ESTO ES LO QUE HACE HONESTA A LA REDUNDANCIA. La copia existe para que
     * la receta archivada siga diciendo qué se recetó aunque el CNMB se haya
     * recargado. Y esa misma copia es por donde entraría la mentira, así que el
     * valor sólo puede salir del concepto leído en la transacción que escribe.
     */
    const prisma = db();
    const { encounter, practitioner, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });

    const prescription = await repositoryOf(prisma).create({
      encounterId: encounter.id,
      prescriberId: practitioner.id,
      ...INDICATIONS,
      items: [{ ...aLine(concept.id), genericName: 'Otra cosa' }],
      sites: [...requester.sites],
    });

    expect(prescription.items[0]?.genericName).toBe('Amoxicilina');
  });

  it('PR-007 rechaza un concepto que es de otro catálogo', async () => {
    // La clave foránea apunta a `catalog_concept`, que guarda TODOS los
    // catálogos: sin esta comprobación una parroquia se receta como medicamento.
    const prisma = db();
    const { encounter, practitioner, requester } = await anEncounter(prisma);
    const notAMedicine = await aCnmbConcept(
      prisma,
      {
        code: 'J020',
        display: 'Faringitis',
        validFrom: new Date('2019-01-01'),
      },
      'CIE10',
    );

    await expect(
      repositoryOf(prisma).create({
        encounterId: encounter.id,
        prescriberId: practitioner.id,
        ...INDICATIONS,
        items: [aLine(notAMedicine.id)],
        sites: [...requester.sites],
      }),
    ).rejects.toMatchObject({ code: 'CONCEPT_NOT_PRESCRIBABLE' });
  });

  it('PR-007 rechaza un medicamento retirado del CNMB antes de la atención', async () => {
    const prisma = db();
    const { encounter, practitioner, requester } = await anEncounter(prisma);
    const retired = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
      validTo: new Date('2025-01-01'),
    });

    await expect(
      repositoryOf(prisma).create({
        encounterId: encounter.id,
        prescriberId: practitioner.id,
        ...INDICATIONS,
        items: [aLine(retired.id)],
        sites: [...requester.sites],
      }),
    ).rejects.toMatchObject({ code: 'CONCEPT_NOT_PRESCRIBABLE' });
  });

  it('PR-001 rechaza componer sobre una atención de otra sede', async () => {
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });

    await expect(
      repositoryOf(prisma).create({
        encounterId: encounter.id,
        prescriberId: practitioner.id,
        ...INDICATIONS,
        items: [aLine(concept.id)],
        sites: [otherSite.id],
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_ENCOUNTER_NOT_FOUND' });
  });

  it('PR-005 emite una vez y rechaza la segunda emisión', async () => {
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );

    const issued = await service.issue(composed.prescription.id, {
      userId: requester.userId,
      sites: [...requester.sites],
    });
    expect(issued.status).toBe('ACTIVE');
    expect(issued.issuedAt).not.toBeNull();
    expect(issued.verificationCode).toMatch(/^[0-9A-F]{16}$/);

    await expect(
      service.issue(composed.prescription.id, {
        userId: requester.userId,
        sites: [...requester.sites],
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_EDITABLE' });
  });

  it('PR-020 la receta emitida vuelve con su número; el borrador, sin él', async () => {
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
    });
    const service = serviceOf(prisma);
    const who = { userId: requester.userId, sites: [...requester.sites] };

    const first = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      who,
    );
    const second = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      who,
    );
    expect(first.prescription.sequenceNumber).toBeNull();

    expect(
      (await service.issue(second.prescription.id, who)).sequenceNumber,
    ).toBe(1);
    expect(
      (await service.issue(first.prescription.id, who)).sequenceNumber,
    ).toBe(2);
  });

  it('PR-038 PR-039 rechaza emitir el borrador que se compuso sin signos de alarma ni recomendaciones', async () => {
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
    });
    const service = serviceOf(prisma);
    const who = { userId: requester.userId, sites: [...requester.sites] };

    const bare = await service.compose(
      { encounterId: encounter.id, items: [aLine(concept.id)] },
      who,
    );
    await expect(
      service.issue(bare.prescription.id, who),
    ).rejects.toMatchObject({
      code: 'PRESCRIPTION_ITEM_INCOMPLETE',
    });
    // Control positivo: el mismo camino, con las indicaciones, emite.
    const complete = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      who,
    );
    const issued = await service.issue(complete.prescription.id, who);
    expect(issued.warningSigns).toBe(INDICATIONS.warningSigns);
    expect(issued.nonPharmacologicalAdvice).toBe(
      INDICATIONS.nonPharmacologicalAdvice,
    );
  });

  it('PR-010 anula una receta emitida sin borrar ninguna fila', async () => {
    // Que algo no se borre sólo se demuestra contando. Y se anula la EMITIDA:
    // `prescription_issued_coherence` obliga a que todo estado distinto de
    // `DRAFT` lleve instante de emisión, así que un borrador no puede llegar a
    // `CANCELLED` — que es también lo que describe el art. 70.
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );

    await service.issue(composed.prescription.id, {
      userId: requester.userId,
      sites: [...requester.sites],
    });
    await service.cancel(composed.prescription.id, {
      userId: requester.userId,
      sites: [...requester.sites],
    });

    expect(await prisma.prescription.count()).toBe(1);
    expect(await prisma.prescriptionItem.count()).toBe(1);
    const stored = await prisma.prescription.findUniqueOrThrow({
      where: { id: composed.prescription.id },
    });
    expect(stored.status).toBe('CANCELLED');
  });

  it('PR-011 descarta un borrador con su motivo, sin borrar ninguna fila', async () => {
    // La salida que un borrador equivocado no tenía: nada se borra, así que se
    // demuestra contando. Y el borrador descartado sigue en la ficha, que es
    // justamente lo que permite distinguirlo de la medicación que el paciente
    // toma de verdad.
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );

    const discarded = await service.discard(
      composed.prescription.id,
      'Se tecleó en la atención equivocada',
      { userId: requester.userId, sites: [...requester.sites] },
    );

    expect(discarded.status).toBe('DISCARDED');
    expect(await prisma.prescription.count()).toBe(1);
    expect(await prisma.prescriptionItem.count()).toBe(1);

    const stored = await prisma.prescription.findUniqueOrThrow({
      where: { id: composed.prescription.id },
    });
    expect(stored.status).toBe('DISCARDED');
    // `prescription_issued_coherence` puso `DISCARDED` del lado de los estados
    // SIN instante de emisión: se descartó antes de emitirse.
    expect(stored.issuedAt).toBeNull();
    expect(stored.discardReason).toBe('Se tecleó en la atención equivocada');
    expect(stored.discardedById).toBe(requester.userId);
    expect(stored.discardedAt).not.toBeNull();
  });

  it('PR-011 la BASE rechaza descartar sin decir quién, cuándo y por qué', async () => {
    /**
     * `prescription_discard_states_who_when_and_why`: o los tres, o el estado
     * no es `DISCARDED`. Sin motivo, descartar es una forma de hacer
     * desaparecer lo que se escribió, y el `CHECK` es lo que se lo impide
     * también a una importación y a un `psql`.
     */
    const prisma = db();
    const { encounter, practitioner } = await anEncounter(prisma);
    const prescription = await prisma.prescription.create({
      data: {
        encounterId: encounter.id,
        siteId: encounter.siteId,
        prescriberId: practitioner.id,
      },
    });

    const problem = await problemFrom(
      prisma.$executeRawUnsafe(
        `UPDATE prescription
            SET status = 'DISCARDED', discarded_at = now(), updated_at = now()
          WHERE id = $1::uuid`,
        prescription.id,
      ),
    );

    expect(problem?.code).toBe('PRESCRIPTION_DISCARD_REASON_REQUIRED');
    expect(problem?.status).toBe(422);
  });

  it('PR-011 la BASE no deja descartar una receta ya emitida, que se anula', async () => {
    /**
     * `prescription_discard_only_from_draft`: `discarded_at IS NULL OR status =
     * 'DISCARDED'`. Anular pesa —hay papel en la mano de alguien y el art. 70
     * describe el procedimiento— y descartar es limpieza de un borrador que
     * nunca salió de la consulta. La base no deja confundir los dos actos.
     */
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );
    await service.issue(composed.prescription.id, {
      userId: requester.userId,
      sites: [...requester.sites],
    });

    const problem = await problemFrom(
      prisma.$executeRawUnsafe(
        `UPDATE prescription
            SET discarded_at = now(), discarded_by_id = $2::uuid,
                discard_reason = 'me equivoqué', updated_at = now()
          WHERE id = $1::uuid`,
        composed.prescription.id,
        requester.userId,
      ),
    );

    expect(problem?.code).toBe('PRESCRIPTION_DISCARD_NOT_FROM_DRAFT');
    expect(problem?.status).toBe(422);

    // Y el servicio se adelanta con una frase que nombra el estado.
    await expect(
      service.discard(composed.prescription.id, 'Me equivoqué', {
        userId: requester.userId,
        sites: [...requester.sites],
      }),
    ).rejects.toMatchObject({
      code: 'PRESCRIPTION_NOT_EDITABLE',
      params: { status: 'ACTIVE' },
    });
  });

  it('PR-034 rechaza emitir con el registro ACESS vencido ayer, sin que nadie toque su fila', async () => {
    const prisma = db();
    const site = await aSiteWithCity(prisma);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const practitioner = await aPrescriber(prisma, {
      acessExpiresOn: yesterday,
    });
    const patient = await createPatient(prisma);
    const encounter = await prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startedAt: ENCOUNTER_STARTED_AT,
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);
    const requester = { userId: practitioner.userId, sites: [site.id] };

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      requester,
    );

    await expect(
      service.issue(composed.prescription.id, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIBER_NOT_LICENSED' });
  });

  it('PR-021 rechaza emitir desde una sede sin parroquia, porque no hay ciudad que imprimir', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await aPrescriber(prisma);
    const patient = await createPatient(prisma);
    const encounter = await prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startedAt: ENCOUNTER_STARTED_AT,
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);
    const requester = { userId: practitioner.userId, sites: [site.id] };

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      requester,
    );

    await expect(
      service.issue(composed.prescription.id, requester),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_ESTABLISHMENT_INCOMPLETE' });
  });

  it('PR-062 la alergia de la ficha ABSORBIDA impide emitir desde la superviviente', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA ESCENA QUE `patient-chart-scope.ts` ABRE, OCURRIENDO AQUÍ
     * ═══════════════════════════════════════════════════════════════════════
     *
     * «Admisiones fusiona correctamente las dos fichas de una paciente. La
     * absorbida llevaba su ALERGIA A LA PENICILINA. El médico abre la ficha
     * superviviente, no ve alergia, y receta.» La fusión no re-apunta nada
     * (D-031), así que leer por `patient_id` desnudo devuelve media historia
     * sin fallar ni avisar. Un doble no puede demostrar esto: depende de que el
     * enlace se recorra EN LA BASE.
     */
    const prisma = db();
    const { site, practitioner, patient, requester } =
      await anEncounter(prisma);
    const absorbed = await createPatient(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CE01',
      display: 'Penicilina G',
      validFrom: new Date('2019-01-01'),
    });

    // La alergia se queda donde se escribió, en la ficha absorbida.
    await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId: absorbed.id,
        substanceConceptId: concept.id,
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      },
    });
    await prisma.patient.update({
      where: { id: absorbed.id },
      // `patient_merged_at_matches_link` exige las dos columnas o ninguna.
      data: { mergedIntoId: patient.id, mergedAt: new Date() },
    });

    const encounter = await prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: practitioner.id,
        // La atención es de la ficha SUPERVIVIENTE, que no tiene alergias
        // propias: es exactamente el caso en que la lectura ingenua calla.
        patientId: patient.id,
        startedAt: ENCOUNTER_STARTED_AT,
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });

    const service = serviceOf(prisma);
    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );

    // PR-067: al componer informa …
    expect(composed.allergyAlerts).toEqual([
      { line: 1, allergyId: expect.any(String), match: 'EXACT' },
    ]);

    // … y al emitir interrumpe.
    await expect(
      service.issue(composed.prescription.id, {
        userId: requester.userId,
        sites: [...requester.sites],
      }),
    ).rejects.toMatchObject({ code: 'ALLERGY_CONTRAINDICATION' });
  });

  it('PR-063 una alergia refutada deja emitir', async () => {
    const prisma = db();
    const { encounter, patient, requester } = await anEncounter(prisma);
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CE01',
      display: 'Penicilina G',
      validFrom: new Date('2019-01-01'),
    });

    await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId: patient.id,
        substanceConceptId: concept.id,
        substanceText: 'Penicilina',
        refutedAt: new Date('2026-08-01T12:00:00Z'),
        refutedNotes: 'Prueba de provocación negativa',
        refutedById: (await createUser(prisma)).id,
      },
    });

    const service = serviceOf(prisma);
    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );

    expect(composed.allergyAlerts).toEqual([]);
    await expect(
      service.issue(composed.prescription.id, {
        userId: requester.userId,
        sites: [...requester.sites],
      }),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('PR-026 el documento lleva el diagnóstico CIE de la atención y las alergias de las dos fichas', async () => {
    const prisma = db();
    const { site, practitioner, patient, requester } =
      await anEncounter(prisma);
    const absorbed = await createPatient(prisma);
    const medicine = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const disease = await aCnmbConcept(
      prisma,
      {
        code: 'J020',
        display: 'Faringitis estreptocócica',
        validFrom: new Date('2019-01-01'),
      },
      'CIE10',
    );

    await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId: absorbed.id,
        substanceText: 'Maní',
        criticality: 'HIGH',
      },
    });
    await prisma.patient.update({
      where: { id: absorbed.id },
      // `patient_merged_at_matches_link` exige las dos columnas o ninguna.
      data: { mergedIntoId: patient.id, mergedAt: new Date() },
    });

    const encounter = await prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        startedAt: ENCOUNTER_STARTED_AT,
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
    await prisma.encounterDiagnosis.create({
      data: {
        encounterId: encounter.id,
        conceptId: disease.id,
        cie10Code: 'J020',
        cie10Display: 'Faringitis estreptocócica',
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        rank: 1,
      },
    });

    const service = serviceOf(prisma);
    const requesterArgs = {
      userId: requester.userId,
      sites: [...requester.sites],
    };
    const composed = await service.compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [aLine(medicine.id)],
      },
      requesterArgs,
    );
    await service.issue(composed.prescription.id, requesterArgs);

    const document = await service.document(
      composed.prescription.id,
      requesterArgs,
    );

    expect(document.diagnoses).toEqual([
      { code: 'J020', display: 'Faringitis estreptocócica' },
    ]);
    // PR-027: la alergia alimentaria de la ficha absorbida está en el documento
    // aunque no interrumpa nada, porque el art. 5.b.iv la pone en el contenido
    // mínimo.
    expect(document.allergies).toEqual(['Maní']);
    expect(document.city).toBe('Quito');
    expect(document.items[0]?.quantityInWords).toBe('veinte');
    expect(document.prescriber.acessRegistration).toBe('ACESS-11223');

    /**
     * PR-050. Tres días CONTADOS DESDE LA FECHA DE PRESCRIPCIÓN, no desde la de
     * la atención: el art. 18 cuenta desde que se emite. Se compara contra la
     * fecha ecuatoriana del instante que la propia receta lleva, porque fijar
     * un literal aquí sería una prueba que caduca mañana.
     */
    const issuedOn = clinicalDateOf(document.issuedAt!);
    expect(document.validity).toEqual({
      days: 3,
      through: addDays(issuedOn, 2),
    });
  });

  it('PR-006 no sirve el documento de una receta de otra sede', async () => {
    const prisma = db();
    const { encounter, requester } = await anEncounter(prisma);
    const otherSite = await createSite(prisma, 'Sede Sur');
    const concept = await aCnmbConcept(prisma, {
      code: 'J01CA04',
      display: 'Amoxicilina',
      validFrom: new Date('2019-01-01'),
    });
    const service = serviceOf(prisma);

    const composed = await service.compose(
      { encounterId: encounter.id, ...INDICATIONS, items: [aLine(concept.id)] },
      { userId: requester.userId, sites: [...requester.sites] },
    );

    await expect(
      service.document(composed.prescription.id, {
        userId: requester.userId,
        sites: [otherSite.id],
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });
});
