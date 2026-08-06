import type { Permission } from './permissions';

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
      'user:manage',
      'site:manage',
      'catalog:manage',
      'catalog:read',
      'audit:read',
    ],
  },
  {
    code: 'MEDICO',
    name: 'Médico',
    description: 'Atiende, diagnostica, prescribe y firma documentos clínicos.',
    permissions: [
      'patient:read',
      'agenda:read',
      'agenda:write',
      'record:read',
      'record:write',
      'record:sign',
      'vitals:write',
      'prescription:write',
      'catalog:read',
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
      'agenda:read',
      'record:read',
      'vitals:write',
      'catalog:read',
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
      'catalog:read',
    ],
  },
  {
    code: 'CAJA',
    name: 'Caja y facturación',
    description: 'Emite comprobantes y registra cobros.',
    permissions: ['patient:read', 'billing:read', 'billing:write', 'catalog:read'], // prettier-ignore
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
