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
    code: 'user:manage',
    resource: 'admin',
    description: 'Administrar usuarios, roles y permisos',
  },
  {
    code: 'site:manage',
    resource: 'admin',
    description: 'Administrar sedes y consultorios',
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
