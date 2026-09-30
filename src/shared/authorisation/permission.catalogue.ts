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

/**
 * What a permission IS, as the `permission` table mirrors it and the
 * administration screen reads it. These three fields and no more: they are the
 * published contract (`PermissionDto`), so anything added here shows up in an
 * HTTP response and in a column.
 */
export interface PermissionDefinition {
  code: string;
  /** Grouping for the administration screen. */
  resource: string;
  /** Read by whoever assigns it, so it is written in Spanish. */
  description: string;
}

/** A catalogue entry: the definition above, plus how it may be granted. */
export interface CatalogueEntry extends PermissionDefinition {
  /**
   * NO AUTOMATED PROCESS MAY HAND THIS OUT. A person grants it, on purpose, or
   * nobody holds it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHY THE MARK LIVES HERE AND NOT IN A LIST INSIDE A SEED.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The property belongs to the permission, so it is declared next to it: a
   * separate list is a second place to update, and the one thing nobody does
   * when adding a permission is remember a file they are not editing. That is
   * exactly how `user:reset-mfa` reached the development role — the seed built
   * it from the WHOLE catalogue, so a permission whose requirement says «no
   * shipped role may carry it» arrived on its own the day it was declared.
   *
   * WHAT IT MEANS, PRECISELY: no seed and no sync may grant it. It says
   * nothing about a clinic granting it from the administration screen — that
   * is the entire point of these permissions existing, and AU-035 is explicit
   * that the installation has to concede it deliberately.
   *
   * THE TEST OF «IS THIS ONE OF THEM»: holding it lets somebody TAKE OVER
   * another person's identity, or erase the evidence of having done so. Not
   * «it is powerful» — `user:manage` is powerful and is not marked, because it
   * cannot by itself sign in as a doctor.
   */
  explicitGrantOnly?: true;
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
  // PA-052, D-030. Fusionar dos fichas y deshacer la fusión.
  //
  // ⚠️ NO LO TRAE NINGÚN ROL DE FÁBRICA, y ésa es la decisión, no un olvido.
  // Una fusión mal hecha une los expedientes clínicos de dos personas
  // distintas —el peor incidente posible de este módulo— y deshacerla puede
  // ser IMPOSIBLE si otra ficha reclamó el documento mientras tanto (PA-048).
  // Que exista y no lo tenga nadie es preferible a que lo tenga quien registra
  // pacientes en el mostrador, así que `explicitGrantOnly` deja fuera a las
  // semillas —construyen sus roles desde `SEEDABLE_PERMISSIONS`— y la
  // instalación se lo concede a alguien a propósito.
  //
  // FUERA DE `patient:write` por lo mismo: quien corrige un apellido no debería
  // poder unir dos historias con el permiso que ya tiene puesto.
  {
    code: 'patient:merge',
    resource: 'patient',
    description:
      'Fusionar dos historias duplicadas y deshacer la fusión. Une los expedientes de dos fichas: hecho sobre personas distintas, mezcla dos historias clínicas y puede no tener vuelta atrás',
    explicitGrantOnly: true,
  },
  // Los grupos prioritarios del paciente (P3, REQ-024, D-026, D-027, D-029).
  //
  // DOS PERMISOS Y NO UNO, y la diferencia es el artículo 35 leído entero.
  //
  //   - `patient:priority` abre el MOTIVO de la prioridad: embarazo,
  //     discapacidad, enfermedad catastrófica, privación de libertad. Es dato
  //     de salud de categoría especial bajo la LOPDP, así que no viaja con
  //     `patient:read` — que tienen recepción y caja— sino aparte. D-029 lo da
  //     de fábrica a `MEDICO` y a `ENFERMERIA`. Recepción sigue viendo el
  //     ORDEN, que es lo que necesita para trabajar (PA-041).
  //   - `patient:priority:protected` abre los cuatro grupos de la SEGUNDA
  //     frase del art. 35 —personas en situación de riesgo, víctimas de
  //     violencia doméstica y sexual, de maltrato infantil y de desastres—,
  //     que reciben «la misma atención prioritaria» y por tanto CUENTAN PARA
  //     EL ORDEN igual que los demás, pero no se leen con la misma llave que
  //     la edad.
  //
  // ⚠️ EL SEGUNDO LO TRAEN `MEDICO` Y `ADMIN` DESDE EL 19-08-2026, y hasta ese
  // día no lo traía nadie. Decisión del usuario, que cierra D-027/D-034 por la
  // opción B ampliada al administrador: el médico tratante necesita saber que
  // la paciente que tiene delante es víctima de violencia —era el caso clínico
  // real— y la dirección se lo reserva también. Por eso este permiso YA NO
  // lleva `explicitGrantOnly`: la marca significa «ninguna semilla lo reparte»
  // y aquí dejó de ser cierto. Los otros tres —`agenda:overbook:self`
  // (AG-103), `user:reset-mfa` (AU-035) y `patient:merge` (D-030)— siguen
  // marcados: su argumento no ha cambiado.
  //
  // ⚠️ LA CONSECUENCIA, DICHA EN VOZ ALTA: con `ADMIN` llevándolo, QUIEN
  // ADMINISTRA CUENTAS PUEDE LEER QUE UNA PACIENTE ES VÍCTIMA DE VIOLENCIA
  // DOMÉSTICA. El argumento de este permiso nunca fue la suplantación sino la
  // SEGURIDAD DE LA PERSONA —que «víctima de violencia doméstica» aparezca en
  // la pantalla de quien no debe verlo tiene consecuencias distintas de las de
  // una filtración corriente, y es la razón de que REQ-025 le dé tabla y
  // régimen propios dentro de la atención—, así que ampliar el reparto a la
  // dirección amplía ese riesgo. Está escrito aquí para que en un año se sepa
  // que fue deliberado y no un descuido, y para que quien revise el reparto de
  // roles sepa qué está mirando. Lo que lo acota hoy: `ADMIN` no trae
  // `patient:read` ni `patient:priority`, y la ruta de los grupos exige
  // `patient:priority` (PA-040), así que el administrador de fábrica no llega a
  // leerlos sin que alguien le conceda además esos dos.
  //
  // ⚠️ Y LOS ROLES SON DATOS: la clínica puede quitárselo a `ADMIN` —o a
  // `MEDICO`— desde la pantalla de roles, sin desplegar nada. Esto es el estado
  // inicial de una instalación nueva, no una regla del código.
  //
  // NO SE LLAMA `patient:violence` ni nada que NOMBRE EL DATO. El código del
  // permiso se lee en la pantalla de roles, en la bitácora y en un mensaje de
  // error, y un nombre que describa la categoría convierte cada uno de esos
  // sitios en una pista sobre el paciente. `:protected` dice cuánto protege,
  // no de qué.
  {
    code: 'patient:priority',
    resource: 'patient',
    description:
      'Ver y registrar por qué un paciente es prioritario: embarazo, discapacidad, enfermedad catastrófica o privación de libertad. Es dato de salud',
  },
  {
    code: 'patient:priority:protected',
    resource: 'patient',
    description:
      'Ver y registrar los grupos prioritarios de acceso restringido. Quien lo tiene conoce situaciones cuya difusión puede poner en riesgo a la persona',
  },
  // La orientación sexual del paciente (PA-057, PA-058, D-039 (b)).
  //
  // ⚠️ SE ESCRIBE CON `patient:write` Y SE LEE CON ESTE, y la asimetría es la
  // decisión. Es la columna 7 del formulario del RDACAA: se teclea en el
  // mostrador junto a las columnas 6, 8 y de la 11 a la 14, así que exigir este
  // permiso también para escribirla dejaría la casilla imposible de llenar para
  // quien no lo tenga. Lo que queda tras la puerta es VOLVER A LEERLA: la ficha
  // no la lleva, el listado tampoco, y hay una ruta aparte que deja su propia
  // fila de bitácora.
  //
  // ⚠️ LO TRAEN `MEDICO` Y `ADMIN` DESDE EL 19-08-2026, y hasta ese día no lo
  // traía nadie. Decisión del usuario, que cierra la única pregunta que D-039
  // dejó abierta, y contestada a la vez que la gemela de
  // `patient:priority:protected`. Por eso ya NO lleva `explicitGrantOnly`: esa
  // marca significa «ninguna semilla lo reparte» y aquí dejó de ser cierto.
  //
  // ⚠️ LA CONSECUENCIA, DICHA EN VOZ ALTA: con `ADMIN` llevándolo, QUIEN
  // ADMINISTRA CUENTAS PUEDE LEER LA ORIENTACIÓN SEXUAL DE CUALQUIER PACIENTE.
  // Y aquí sin acotar, a diferencia de `patient:priority:protected`: la ruta de
  // PA-058 exige ESTE permiso y ningún otro, así que `ADMIN` la abre de fábrica
  // sin necesitar `patient:read`. Es dato de categoría especial bajo la LOPDP,
  // la decisión es del usuario y se respeta; queda escrito para que en un año
  // se sepa que fue deliberado y no un descuido, y para que quien revise el
  // reparto de roles sepa qué está mirando. Lo que lo compensa es lo de
  // siempre: cada lectura deja su fila de bitácora con quién y cuándo.
  //
  // ⚠️ Y LOS ROLES SON DATOS: la clínica puede quitárselo a `ADMIN` desde la
  // pantalla de roles sin desplegar nada. Esto es el estado inicial de una
  // instalación nueva, no una regla del código.
  //
  // EL CÓDIGO NOMBRA EL CAMPO Y NO SU CONTENIDO —nada de `patient:lgbt`—, por
  // lo mismo que `patient:priority:protected` no se llama `patient:violence`:
  // el código se lee en la pantalla de roles, en la bitácora y en un mensaje de
  // error, y un nombre que describa el valor convertiría cada uno de esos
  // sitios en una pista sobre el paciente.
  {
    code: 'patient:sexual-orientation',
    resource: 'patient',
    description:
      'Ver la orientación sexual registrada del paciente. Es dato de categoría especial: quien lo tiene lee un dato que el paciente declaró y que no viaja en la ficha',
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
  // Sobrecupo (E4, AG-101, AG-103, D-005). DOS permisos y no uno, y la
  // diferencia entre ellos es el control entero:
  //
  //   - `agenda:overbook` lo trae de fábrica quien puede AUTORIZAR que se
  //     rompa la rejilla: el médico que atenderá la urgencia y el
  //     administrador. Es el caso real —recepción reserva, el médico
  //     autoriza—, y por eso NO lo trae `RECEPCION`: quien reserva no autoriza
  //     su propia excepción (AG-103), o el campo de autorización se rellena
  //     solo y deja de autorizar nada.
  //   - `agenda:overbook:self` es la excepción a esa separación, para el
  //     médico de guardia a las 21:00 sin nadie más conectado.
  //
  // ⚠️ EL SEGUNDO NO LO TRAE NINGÚN ROL, por el mismo argumento que
  // `user:reset-mfa` (AU-035): quien lo tiene puede saltarse él solo la única
  // separación de personas que este módulo tiene, así que la instalación se lo
  // concede a alguien A PROPÓSITO o no lo tiene nadie. `explicitGrantOnly` es
  // lo que lo hace cierto en código: las semillas construyen sus roles a
  // partir de `SEEDABLE_PERMISSIONS`, no del catálogo entero.
  //
  // CUÁL de los dos autoriza es un PARÁMETRO DE SEDE (AG-094,
  // `site_parameter.overbooking_permission`), con `agenda:overbook` de
  // arranque. Que el permiso sea configurable no hace configurable el
  // CATÁLOGO: qué códigos existen sigue siendo código, y guardar uno que este
  // catálogo no declara se rechaza con `UNKNOWN_PERMISSION`.
  {
    code: 'agenda:overbook',
    resource: 'agenda',
    description:
      'Autorizar un sobrecupo: una cita fuera de la rejilla, con motivo y constancia de quién la autorizó',
  },
  {
    code: 'agenda:overbook:self',
    resource: 'agenda',
    description:
      'Autorizar el propio sobrecupo, sin que otra persona lo autorice. Es la excepción para el médico de guardia: quien lo tiene puede saltarse la separación entre quien reserva y quien autoriza',
    explicitGrantOnly: true,
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
    // D-A-003. Opening a chart is an ADMINISTRATIVE act, not a clinical one:
    // A.M. 00115-2021 art. 11 puts it on «personal de Gestión de Admisiones».
    // Without this, nursing could not take vital signs before the doctor walked
    // in — `encounter_vitals` hangs off an encounter that has to exist first,
    // and creating one required `record:write`, which only MEDICO carries.
    code: 'encounter:open',
    resource: 'record',
    description: 'Abrir una atención (no autoriza a escribir en la historia)',
  },
  {
    // D-A-004. The forms the A.M. 00115-2021 instructivo assigns to nursing:
    // 020 (vital signs), 120 (nursing interventions), 022 (drug
    // administration), plus the compliance check on 005. Deliberately NOT
    // `record:write`: nursing neither diagnoses nor prescribes, which is what
    // LOS art. 198 requires («limitar sus acciones al área que el título les
    // asigne»).
    code: 'nursing:write',
    resource: 'record',
    description: 'Registrar y firmar los formularios propios de enfermería',
  },
  {
    code: 'prescription:write',
    resource: 'record',
    description: 'Emitir recetas',
  },
  {
    // ORD-094. Transcribir y corregir un resultado de laboratorio.
    //
    // ⚠️ DELIBERADAMENTE FUERA DE `record:write`, y el argumento es el mismo
    // que produjo `nursing:write` y `encounter:open`: quien teclea un informe
    // de laboratorio puede ser un técnico o el personal de admisiones, y
    // `record:write` es lo que permite DIAGNOSTICAR. El art. 198 de la Ley
    // Orgánica de Salud obliga a «limitar sus acciones al área que el título
    // les asigne», y copiar un número no es diagnosticar.
    //
    // ⚠️ LEER UN RESULTADO SIGUE SIENDO `record:read`, y la asimetría es
    // deliberada: el resultado es contenido clínico de la historia, así que
    // todo el que puede abrirla puede leerlo. Aquí transcribir es un acto MÁS
    // estrecho que leer, al revés que en `patient:sexual-orientation`.
    //
    // ⚠️ NINGÚN ROL LO TRAE DE FÁBRICA, y eso NO es `explicitGrantOnly`: no es
    // un permiso de suplantación, es que quién teclea los informes es una
    // decisión de la clínica y todavía no está tomada. Queda anotado en las
    // preguntas abiertas del SPEC de `orders` con su recomendación.
    code: 'result:write',
    resource: 'record',
    description:
      'Registrar y corregir los resultados de laboratorio que devuelve el informe. No autoriza a escribir en la historia ni a diagnosticar',
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
    // Prices move money, so changing them is a permission of its own — never
    // bundled with issuing an invoice. D-049: the clinic decides who holds it.
    code: 'billing:price-manage',
    resource: 'billing',
    description: 'Crear y modificar listas de precios y tarifas',
  },
  {
    // A discount beyond the role's own ceiling needs a SECOND person. Without a
    // separate permission there is nobody to ask.
    code: 'billing:discount-override',
    resource: 'billing',
    description: 'Autorizar un descuento por encima del límite del rol',
  },
  {
    // D-A-007. There is no «edit invoice» anywhere in this system: the SRI does
    // not allow modifying an authorised invoice, only a credit note. This is
    // that, and it is deliberately not `billing:write`.
    code: 'billing:credit-note',
    resource: 'billing',
    description: 'Emitir notas de crédito para corregir una factura',
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
  // being able to create an account or move a permission.
  //
  // ⚠️ THE DESCRIPTION NAMES THE CEDULA, and it has to. This description used
  // to say «las cuentas, los roles y el catálogo de permisos», and three
  // places in the system repeated that the list carries «el nombre y el correo
  // institucional» — while `accountSchema` has carried `cedula` all along and
  // the LIST route serves it. ROLES ARE DATA: a clinic that invents a
  // «TALENTO HUMANO» role and ticks this box gets the national ID of every
  // employee, and it deserves to know that BEFORE ticking it, not after.
  //
  // The field is NOT dropped from the listing instead, and that is a decision
  // rather than an omission: `clinica-web` has no detail request at all —
  // `GET /auth/users/{id}` is deliberately unused — so the edit form reads the
  // cedula from the list row, and a listing without it would send `cedula:
  // null` back on the next save and ERASE the cedula of every practitioner
  // somebody renamed. Making the grant informed is the fix that does not trade
  // one leak for a data loss. Compare `staff:read`, whose read side is narrow
  // for the same reason stated the other way round.
  {
    code: 'user:read',
    resource: 'admin',
    description:
      'Consultar las cuentas del personal —incluida su cédula—, los roles y el catálogo de permisos',
  },
  {
    code: 'user:manage',
    resource: 'admin',
    description: 'Administrar usuarios, roles y permisos',
  },
  // Recuperar el segundo factor de otra cuenta (A4, AU-035, D-014).
  //
  // ⚠️ UN PERMISO PROPIO, FUERA DE `user:manage`, Y NINGÚN ROL DE FÁBRICA LO
  // TRAE. Quien reinicia el segundo factor de un médico le quita la única
  // barrera que queda entre una contraseña y su firma; si además puede
  // invitarle de nuevo (AU-021), puede entrar como él y firmar en su nombre.
  // El no repudio de la bitácora —la evidencia principal ante la SPDP
  // (REQ-110)— se apoya en que eso no llegue por herencia, así que la
  // instalación tiene que concedérselo a alguien a propósito.
  //
  // LA DESCRIPCIÓN NOMBRA LA CONSECUENCIA, como la de `user:read` nombra la
  // cédula: los roles son dato, y quien marca la casilla tiene derecho a saber
  // qué está entregando ANTES de marcarla, no después.
  //
  // ⚠️ Y NINGUNA SEMILLA LO REPARTE. `explicitGrantOnly` es lo que lo hace
  // cierto en código: la semilla de desarrollo construía su rol «todos los
  // permisos» a partir del catálogo entero, así que este permiso aterrizaba
  // ahí solo, y la única barrera era `NODE_ENV !== 'production'`. Para un
  // permiso al que AU-035 dedica un párrafo explicando por qué no puede llegar
  // por herencia, «esto no es producción» es más flojo que el resto del
  // argumento: cualquier staging, UAT o demo sembrada lo concedía.
  {
    code: 'user:reset-mfa',
    resource: 'admin',
    description:
      'Retirar el segundo factor de otra cuenta para que vuelva a matricularlo. Deja esa cuenta protegida solo por su contraseña y cierra sus sesiones',
    explicitGrantOnly: true,
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
] as const satisfies readonly CatalogueEntry[];

export type Permission = (typeof PERMISSION_CATALOGUE)[number]['code'];

export const PERMISSIONS: readonly Permission[] = PERMISSION_CATALOGUE.map(
  (definition) => definition.code,
);

/**
 * The ones a person has to grant deliberately. See `explicitGrantOnly`.
 *
 * DERIVED, never written by hand: the marks are the source, and a hand-kept
 * copy would be the second list this exists to avoid.
 */
/**
 * The two lists below, from the one mark.
 *
 * The predicate is typed as `PermissionDefinition` on purpose: `as const`
 * narrows each entry to its own literal type, where an optional field that is
 * absent does not exist at all, and reading it off the union does not compile.
 */
const marked = (wanted: boolean): readonly Permission[] =>
  PERMISSION_CATALOGUE.filter(
    (definition: CatalogueEntry) =>
      Boolean(definition.explicitGrantOnly) === wanted,
  ).map((definition) => definition.code);

export const EXPLICIT_GRANT_ONLY_PERMISSIONS: readonly Permission[] =
  marked(true);

/**
 * What a seed may hand out: everything except the above.
 *
 * A SEED THAT WANTS «ALL THE PERMISSIONS» ASKS FOR THIS ONE. Using `PERMISSIONS`
 * there is what put `user:reset-mfa` into the development superuser role — a
 * permission that AU-035 says must reach nobody by inheritance — and made
 * `NODE_ENV !== 'production'` the only thing standing between a staging
 * database and an account able to take over any doctor's identity.
 */
export const SEEDABLE_PERMISSIONS: readonly Permission[] = marked(false);

/**
 * The catalogue as the `permission` table stores it and the API publishes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROJECTION IS THE CONTRACT BOUNDARY, AND IT IS DELIBERATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `explicitGrantOnly` is an internal rule about who may GRANT a permission, and
 * it stops here: `PermissionDto` declares three fields, `permission` has three
 * columns, and letting a fourth leak out of the constant would make the served
 * response disagree with the OpenAPI document generated from that DTO — which
 * is how a frontend ends up typing a field by hand.
 *
 * Whether the administration screen should SAY «este permiso se concede a
 * propósito» is a good question and a separate change: it needs the DTO, the
 * document and the interface to move together.
 */
export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] =
  PERMISSION_CATALOGUE.map(({ code, resource, description }) => ({
    code,
    resource,
    description,
  }));
