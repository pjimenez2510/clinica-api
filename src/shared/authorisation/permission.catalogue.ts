/**
 * The catalogue of permissions, and how a caller's access is evaluated.
 *
 * WHAT IS CODE AND WHAT IS DATA — the distinction the first version got wrong:
 *
 *   - WHICH PERMISSIONS EXIST is code. Each one corresponds to a check in a
 *     route, so inventing one in a database row would protect nothing. The
 *     catalogue is mirrored into the `permission` table for referential
 *     integrity and so the admin screen can list it, and a test asserts the
 *     two agree.
 *   - WHICH ROLES EXIST is data. A clinic hires an external auditor, splits
 *     nursing into ward and outpatient, brings in an insurance liaison. None
 *     of that should need a migration and a deploy.
 *   - WHICH PERMISSIONS A ROLE CARRIES is data. It is the clinic's policy, not
 *     the code's.
 *
 * The first two were hardcoded as a PostgreSQL enum and a constant map. That
 * was wrong, and this file is the correction.
 */

export interface PermissionDefinition {
  code: string;
  /** Grouping for the administration screen. */
  resource: string;
  /** Read by whoever assigns it, so it is written in Spanish. */
  description: string;
}

/**
 * Every permission the code checks.
 *
 * Adding an entry here is half the work: the other half is a route that asks
 * for it. A permission nothing checks is a promise the system does not keep.
 */
export const PERMISSION_CATALOGUE = [
  {
    code: 'patient:read',
    resource: 'patient',
    description: 'Consultar la ficha administrativa de un paciente',
  },
  {
    code: 'patient:write',
    resource: 'patient',
    description: 'Registrar y corregir datos de pacientes',
  },
  {
    code: 'agenda:read',
    resource: 'agenda',
    description: 'Ver la agenda de citas',
  },
  {
    code: 'agenda:write',
    resource: 'agenda',
    description: 'Agendar, reprogramar y anular citas',
  },
  {
    code: 'record:read',
    resource: 'record',
    description: 'Abrir la historia clínica de un paciente',
  },
  {
    code: 'record:write',
    resource: 'record',
    description: 'Registrar la atención en la historia clínica',
  },
  {
    code: 'record:sign',
    resource: 'record',
    description: 'Firmar notas clínicas y certificados',
  },
  {
    code: 'vitals:write',
    resource: 'record',
    description: 'Registrar signos vitales y antropometría',
  },
  {
    code: 'prescription:write',
    resource: 'record',
    description: 'Emitir recetas',
  },
  {
    code: 'billing:read',
    resource: 'billing',
    description: 'Consultar facturación y estado de cobros',
  },
  {
    code: 'billing:write',
    resource: 'billing',
    description: 'Emitir comprobantes y registrar cobros',
  },
  {
    code: 'catalog:read',
    resource: 'catalog',
    description: 'Consultar catálogos: CIE-10, medicamentos, tarifario',
  },
  {
    code: 'catalog:manage',
    resource: 'catalog',
    description: 'Cargar y versionar catálogos',
  },
  {
    code: 'config:read',
    resource: 'config',
    description: 'Consultar la configuración clínica y operativa',
  },
  {
    code: 'config:manage',
    resource: 'config',
    description:
      'Administrar especialidades, tipos de atención, duraciones y parámetros',
  },
  // Operational parameters of the clinic (ADR-011, `configuration`): holidays
  // and the per-site numbers of D-001. A SEPARATE pair from `config:*`, which
  // covers specialties, attention types and durations — those are master data
  // the record and the invoice reference, and these are numbers nobody
  // references from a row. Reading them is split from editing them because
  // every booking screen has to know the holidays and the lead times to
  // explain a refusal, and nothing about that implies being able to raise the
  // overbooking cap.
  //
  // NAMED `settings:manage` AND NOT `settings:write`, which is what D-002's
  // prose says: every other administration pair in this catalogue is
  // `read`/`manage` (`config:*`, `site:*`, `staff:*`, `catalog:*`), and one
  // odd verb in a closed union is a typo waiting to compile.
  {
    code: 'settings:read',
    resource: 'settings',
    description:
      'Consultar los feriados y los parámetros de operación de cada sede',
  },
  {
    code: 'settings:manage',
    resource: 'settings',
    description:
      'Administrar feriados y parámetros de operación: antelaciones, tope de sobrecupos y retención',
  },
  // Administering accounts and roles (`auth`, A2). `user:manage` already
  // existed and covers every mutation; `user:read` is new and is what lets a
  // screen LIST the staff, their roles and the permission catalogue without
  // being able to create an account or move a permission. The list carries the
  // name and the institutional email of every employee, so it is not open to
  // anyone who merely holds a clinical permission.
  {
    code: 'user:read',
    resource: 'admin',
    description:
      'Consultar las cuentas, los roles y el catálogo de permisos del sistema',
  },
  {
    code: 'user:manage',
    resource: 'admin',
    description: 'Administrar usuarios, roles y permisos',
  },
  // Reading the clinic's map is split from editing it (ADR-011, OR-004): a
  // receptionist has to know which sites, consulting rooms and points of
  // emission exist to book into them, and nothing about that implies being
  // able to create one. `site:manage` already existed and is reused unchanged
  // for every mutation.
  {
    code: 'site:read',
    resource: 'admin',
    description:
      'Consultar el establecimiento, las sedes, los consultorios y los puntos de emisión',
  },
  {
    code: 'site:manage',
    resource: 'admin',
    description: 'Administrar sedes y consultorios',
  },
  // The clinical profile of the staff (ADR-011, `staff`). Split read from
  // write for the same reason as `site:*` — except that here the READ side is
  // deliberately narrow: a practitioner's file carries their cedula, their
  // ACESS registration and its expiry, which is personal data of an employee
  // and not something a booking screen needs. The agenda lists who can be
  // booked through its own AG-108 route under `agenda:read`, so no clinical
  // role has to hold `staff:read` to work.
  {
    code: 'staff:read',
    resource: 'staff',
    description:
      'Consultar la ficha profesional: ACESS, código MSP, sedes, especialidades y horarios',
  },
  {
    code: 'staff:manage',
    resource: 'staff',
    description:
      'Administrar profesionales, sus sedes, sus especialidades y sus horarios',
  },
  {
    code: 'audit:read',
    resource: 'admin',
    description: 'Consultar la bitácora de accesos',
  },
] as const satisfies readonly PermissionDefinition[];

export type Permission = (typeof PERMISSION_CATALOGUE)[number]['code'];

export const PERMISSIONS: readonly Permission[] = PERMISSION_CATALOGUE.map(
  (definition) => definition.code,
);
