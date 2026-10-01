import type { Permission } from '../../../shared/authorisation/permission.catalogue';

/**
 * The roles a clinic starts with, and nothing more.
 *
 * THESE ARE DEFAULTS, NOT RULES. Every one of them can be renamed, emptied,
 * extended or deactivated from the administration screen, and a clinic can add
 * its own — that is the whole point of roles being data. What ships here is a
 * sensible starting point derived from who signs what in an Ecuadorian clinic,
 * so that a fresh installation is usable before anybody configures anything.
 *
 * ⚠️ WHAT MOVED, AND WHAT IT COSTS. In the first version these lists were the
 * enforcement, checked by a test that made it IMPOSSIBLE for an administrator
 * to hold `record:read`. Now they are only the initial state: somebody with
 * `user:manage` can grant clinical access to the administrator role. The
 * separation is still the default and still the recommendation, but it is now
 * a decision the clinic can take rather than one the code forbids.
 *
 * That trade is deliberate and it is the price of flexibility. What compensates
 * it: every change to a role is recorded, and the administration screen warns
 * before granting `record:*` to a role that also holds `user:manage`.
 */
export interface DefaultRole {
  code: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    code: 'ADMIN',
    name: 'Administrador del sistema',
    // The separation an SPDP audit asks about first: whoever holds technical
    // control does not, by default, hold clinical access.
    description:
      'Administra usuarios, sedes y catálogos. No accede a historias clínicas.',
    permissions: [
      'user:read',
      'user:manage',
      'site:read',
      'site:manage',
      'catalog:manage',
      'catalog:read',
      // Clinic-wide parametrisation (specialties, durations, schedules): it is
      // operational configuration, not clinical content, so it sits with the
      // administrator alongside users and sites.
      'config:read',
      'config:manage',
      // Feriados y parámetros de sede (D-001, D-002). Van al administrador y a
      // nadie más por defecto: el tope de sobrecupos deja de ser un control en
      // cuanto lo puede subir quien lo incumple, y la bitácora es lo que
      // compensa esa concentración.
      'settings:read',
      'settings:manage',
      // 20-08-2026. Respuesta del usuario a D-049 sobre quién toca los precios:
      // «flexible, el admin asigna». Hasta hoy ADMIN no llevaba NINGÚN permiso
      // de facturación, así que el catálogo de prestaciones, las tarifas de IVA
      // y las listas de precios no los podía mantener nadie — y son justo lo
      // que cambia entre clínicas.
      //
      // Lo que NO recibe, y es deliberado: `billing:write` ni
      // `billing:credit-note`. Parametrizar los precios y cobrar son cosas
      // distintas, y la descripción de este rol —«no accede a historias
      // clínicas»— vale igual para la caja.
      'billing:read',
      'billing:price-manage',
      // D-005, AG-101. La dirección también autoriza sobrecupos: el caso de
      // «la sede está llena y la dirección decide atender a alguien más» es
      // uno de los tres que D-005 enumera. Como el médico, sin
      // `agenda:overbook:self`.
      'agenda:overbook',
      // The staff file (ADR-011). It goes to the administrator and to NOBODY
      // ELSE by default, which is a decision and not an oversight: the file
      // carries the cedula and the ACESS registration of an employee, and the
      // two roles that could plausibly want it do not need it. The agenda
      // already lists bookable practitioners under `agenda:read` (AG-108), so
      // granting `staff:read` to MEDICO or RECEPCION would widen access to
      // personal data without unlocking a single screen they lack today. A
      // clinic that wants it can grant it — roles are data (D-012 only seeds
      // the roles whose definition declares the code).
      'staff:read',
      'staff:manage',
      'audit:read',
      // ⚠️ LOS DOS PERMISOS MÁS SENSIBLES DEL SISTEMA, y hasta el 19-08-2026 no
      // los traía nadie a propósito. Decisión del usuario, que cierra
      // D-027/D-034 y la última pregunta de D-039: van a `MEDICO` y a `ADMIN`.
      //
      // LA CONSECUENCIA, DICHA EN VOZ ALTA: QUIEN ADMINISTRA CUENTAS PUEDE
      // LEER QUE UNA PACIENTE ES VÍCTIMA DE VIOLENCIA DOMÉSTICA Y LA
      // ORIENTACIÓN SEXUAL DE CUALQUIERA. La segunda sin nada que la acote —la
      // ruta de PA-058 exige ese permiso y ningún otro—; la primera acotada
      // hoy porque este rol no trae `patient:read` ni `patient:priority`, que
      // es lo que la ruta de PA-040 pide además. Se escribe para que dentro de
      // un año se sepa que fue deliberado y no un descuido.
      //
      // Y ESTO ES EL ESTADO INICIAL, NO UNA REGLA: los roles son datos, así
      // que la clínica puede quitárselos a `ADMIN` desde la pantalla de roles
      // sin desplegar nada.
      'patient:priority:protected',
      'patient:sexual-orientation',
      // D-083 §4, decisión del autor (30-09-2026): publicar el texto del
      // consentimiento y atender las solicitudes de los pacientes sobre sus
      // datos —que incluye EXPORTAR LA FICHA ENTERA en JSON (PD-040)—.
      // ⚠️ SIN `patient:read`: por la API registra, exporta y responde sobre
      // cualquier ficha; en la pantalla no abre la ficha donde se hace. Lo
      // que eso implica y la alternativa recomendada están en D-098 §6.
      'patient:consent-text',
      'patient:data-requests',
    ],
  },
  {
    code: 'MEDICO',
    name: 'Médico',
    description: 'Atiende, diagnostica, prescribe y firma documentos clínicos.',
    permissions: [
      'patient:read',
      // D-101, 01-10-2026, decisión del autor (opción B). El certificado de
      // reposo imprime empresa, puesto, domicilio y teléfono de la ficha
      // (CER-038), y quien lo emite es el médico: corrige la ficha ENTERA por
      // la ruta de corrección, que deja cada cambio en su histórico.
      'patient:write',
      // D-029, 16-08-2026. El motivo de la prioridad (PA-040): quien atiende
      // necesita saber que la paciente está embarazada o que tiene una
      // enfermedad catastrófica. Recepción y caja NO lo llevan — les basta la
      // prioridad calculada de PA-041—, y eso es lo que separa «ver la fecha
      // de nacimiento» de «ver el diagnóstico social».
      'patient:priority',
      // 19-08-2026, decisión del usuario que cierra D-027/D-034 y la última
      // pregunta de D-039. Hasta hoy ninguno de los dos lo traía ningún rol
      // (`explicitGrantOnly`), con la consecuencia que D-034 anotaba: los
      // cuatro grupos de la segunda frase del artículo 35 no se podían ni
      // registrar, así que la lista de espera no priorizaba a una víctima de
      // violencia — justo lo que D-027 quería cerrar.
      //
      //   - `patient:priority:protected`: personas en situación de riesgo,
      //     víctimas de violencia doméstica y sexual, de maltrato infantil y
      //     de desastres. Quien atiende necesita saberlo, que era el argumento
      //     de la opción B de D-034; el coste es que en una clínica con veinte
      //     médicos el dato lo ven veinte personas.
      //   - `patient:sexual-orientation`: la columna 7 del RDACAA (PA-058).
      //     Se escribe con `patient:write` y se lee sólo con éste.
      //
      // Los dos son dato de categoría especial bajo la LOPDP y los dos son
      // DATOS, no código: la clínica los reparte de otro modo desde la
      // pantalla de roles sin desplegar nada.
      'patient:priority:protected',
      'patient:sexual-orientation',
      'agenda:read',
      'agenda:write',
      // D-005, AG-101. El médico AUTORIZA el sobrecupo que recepción reserva:
      // es quien atenderá la urgencia y quien puede decir que cabe. No lleva
      // `agenda:overbook:self` — ése se concede a mano (AU-035 hace lo mismo
      // con `user:reset-mfa`), porque salta la separación de personas.
      'agenda:overbook',
      'record:read',
      'encounter:open',
      // El médico también los transcribe cuando no hay nadie más (D-A-013).
      'result:write',
      'record:write',
      'record:sign',
      'vitals:write',
      // EN-164. The doctor keeps recording allergies and history: this is the
      // permission those routes ask for now, instead of `record:write`.
      'background:write',
      'prescription:write',
      'catalog:read',
      // Every role that reads the agenda also gets to read the clinic's map:
      // booking means picking a site and a consulting room, and a screen that
      // cannot name them is a screen nobody can use (ADR-011). It is READ
      // only — creating or deactivating a site stays with `site:manage`.
      'site:read',
    ],
  },
  {
    code: 'ENFERMERIA',
    name: 'Enfermería',
    // Reads the record because vital signs without context are useless, but
    // neither diagnoses nor prescribes.
    description:
      'Registra signos vitales y tamizajes. No diagnostica ni prescribe.',
    permissions: [
      'patient:read',
      // D-029. Enfermería hace el tamizaje y toma los signos: es quien registra
      // que una paciente está embarazada, así que lee y escribe el motivo por
      // la misma puerta que el médico.
      'patient:priority',
      'agenda:read',
      'record:read',
      'vitals:write',
      // D-A-003, 20-08-2026. Without this, EN-066 was impossible to satisfy:
      // it says nursing takes the vital signs BEFORE the doctor walks in, but
      // `encounter_vitals` hangs off an encounter that must already exist and
      // creating one required `record:write`. Opening is administrative —
      // A.M. 00115-2021 art. 11 puts it on admissions — so it gets its own
      // permission rather than widening `record:write`.
      'encounter:open',
      // D-A-004. The forms the instructivo assigns to nursing: 020 (vital
      // signs), 120 (nursing interventions), 022 (drug administration). Art. 4
      // obliges whoever intervenes to sign what they wrote, so nursing must be
      // able to sign ITS OWN forms — without ever reaching diagnosis or
      // prescription.
      'nursing:write',
      // EN-164, F-03. Preparation takes the allergies and the history the
      // patient declares. Ruling one out stays with `record:write`.
      'background:write',
      // D-A-013, 20-08-2026. Transcribir un informe de laboratorio.
      //
      // El resultado llega en PDF de un laboratorio externo (D-A-012), y quien
      // lo recibe en el mostrador es quien transcribe los pocos valores que se
      // van a graficar o alertar. Deliberadamente NO es `record:write`:
      // transcribir un número que otro midió no es diagnosticar, y confundirlo
      // pondría a enfermería fuera del ámbito de su título (LOS art. 198).
      'result:write',
      'catalog:read',
      'site:read',
    ],
  },
  {
    code: 'RECEPCION',
    name: 'Recepción',
    description:
      'Agenda citas y registra pacientes. No abre la historia clínica.',
    permissions: [
      'patient:read',
      'patient:write',
      'agenda:read',
      'agenda:write',
      // D-A-003. A.M. 00115-2021 art. 11: «La apertura de la historia clínica
      // única … la realizará el personal de Gestión de Admisiones». That is
      // this role. Note the description above still holds: opening a chart is
      // NOT writing in it.
      'encounter:open',
      'catalog:read',
      'site:read',
    ],
  },
  {
    code: 'CAJA',
    name: 'Caja y facturación',
    description: 'Emite comprobantes y registra cobros.',
    // D-A-007: there is no «edit invoice». Correcting one is a credit note,
    // and it is a separate permission on purpose. `price:manage` and
    // `discount:override` are NOT here — the clinic's admin hands those out
    // deliberately (user's answer: «flexible, el admin asigna»).
    // 20-08-2026. `site:read` NO es opcional para este rol, y faltaba: cobrar
    // exige saber EN QUÉ SEDE se cobra —la ruta de cuentas lleva `siteId`— y
    // emitir exige el punto de emisión del SRI, que cuelga de la sede. Sin él
    // la pantalla de caja no abre para una cajera; lo destapó construirla.
    //
    // No es un permiso clínico: da nombre, dirección y punto de emisión de las
    // sedes que esta persona ya tiene asignadas, acotado por su alcance. La
    // alternativa —un `GET /billing/sites` propio— duplicaría la misma lectura
    // con otro nombre para no conceder un permiso que igualmente hace falta.
    permissions: ['patient:read', 'site:read', 'billing:read', 'billing:write', 'billing:credit-note', 'catalog:read'], // prettier-ignore
  },
  {
    code: 'AUDITOR',
    name: 'Auditor',
    description: 'Consulta la bitácora de accesos. No modifica nada.',
    permissions: ['audit:read', 'catalog:read'],
  },
];

/**
 * Combinations worth warning about before they are saved.
 *
 * Not forbidden — a small clinic where the owner is also the doctor is a real
 * situation, and refusing it outright would push them to share one account,
 * which is worse for the audit trail. The administration screen shows these so
 * the choice is deliberate rather than accidental.
 */
export const RISKY_COMBINATIONS: readonly {
  permissions: readonly Permission[];
  warning: string;
}[] = [
  {
    permissions: ['user:manage', 'record:read'],
    warning:
      'Este rol podría darse a sí mismo acceso a historias clínicas y luego retirarlo. Considere separarlo en dos roles.',
  },
  {
    permissions: ['audit:read', 'user:manage'],
    warning:
      'Quien audita los accesos también podría modificar quién accede. La SPDP espera que sean personas distintas.',
  },
  {
    permissions: ['billing:write', 'record:sign'],
    warning:
      'Firmar la atención y facturarla sin un segundo par de ojos facilita el fraude a aseguradoras.',
  },
];
