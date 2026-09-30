/**
 * What administering the things that hang off a site — consulting rooms and
 * points of emission — needs from storage (O2: OR-020..OR-026).
 *
 * A SECOND PORT rather than more methods on `OrganizationRepository`: the two
 * have different reasons to change (an establishment changes when the MSP
 * changes its typologies; a point of emission changes when the SRI changes how
 * comprobantes are numbered) and no method in common. Splitting them is what
 * keeps each service below the size the constitution fixes (§3).
 *
 * Uniqueness is NOT checked here either: OR-020 and OR-024 are unique indexes,
 * and the adapter translates their refusal.
 */

/** A consulting room as the screens list it (OR-020, OR-022). */
export interface SiteRoomView {
  id: string;
  siteId: string;
  name: string;
  active: boolean;
}

/** A point of emission of the SRI (OR-023). Data only — see OR-025. */
export interface EmissionPointView {
  id: string;
  siteId: string;
  /** Three digits, leading zero significant: «001» is not 1. */
  code: string;
  description: string | null;
  active: boolean;
}

/** Rooms and SRI points of emission of a site (OR-020..OR-026). */
export interface SiteResourcesRepository {
  /**
   * Whether the site named by the URL exists.
   *
   * The service asks BEFORE writing so a wrong site id answers 404 and not the
   * foreign key's 422: the identifier names the resource in the URL, so a
   * wrong one is a missing resource, not bad data.
   */
  siteExists(siteId: string): Promise<boolean>;

  /**
   * Which site a room or a point of emission belongs to; `null` when there is
   * no such row.
   *
   * WHY THIS EXISTS. `PATCH`/`DELETE` name the ROOM, not the site, so the
   * guard has nothing to check — guards run before pipes and before any read.
   * Declaring those routes `global` was the consequence, and the consequence
   * of THAT was a clinic scoping «Administrador de sede» to one city (which
   * `ReplaceGrantsDto` exists to allow) getting a role that could rename and
   * delete another city's consulting rooms. The site cannot be known without
   * reading the row, so reading the row is what the handler does.
   */
  siteOfRoom(id: string): Promise<string | null>;

  siteOfEmissionPoint(id: string): Promise<string | null>;

  /** OR-022: deactivated rooms travel only when explicitly asked for. */
  listRooms(
    siteId: string,
    includeInactive: boolean,
  ): Promise<readonly SiteRoomView[]>;

  /** OR-020. Throws `SiteRoomDuplicateError` when the unique index refuses. */
  createRoom(input: { siteId: string; name: string }): Promise<SiteRoomView>;

  updateRoom(
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<SiteRoomView | null>;

  /**
   * `false` when the row does not exist; throws `SiteRoomInUseError` when an
   * appointment still references it (OR-022).
   */
  deleteRoom(id: string): Promise<boolean>;

  listEmissionPoints(
    siteId: string,
    includeInactive: boolean,
  ): Promise<readonly EmissionPointView[]>;

  /** OR-023. Throws `EmissionPointDuplicateError` on a repeated code (OR-024). */
  createEmissionPoint(input: {
    siteId: string;
    code: string;
    description: string | null;
  }): Promise<EmissionPointView>;

  updateEmissionPoint(
    id: string,
    patch: { description?: string | null; active?: boolean },
  ): Promise<EmissionPointView | null>;

  /**
   * `false` when the row does not exist.
   *
   * No "in use" branch, and that is a fact about the schema rather than an
   * omission: NOTHING references `emission_point` today. `billing` will
   * (REQ-085), and the day it does it brings its own FK and the code that goes
   * with it. Arming an error nothing can raise would be a promise with no
   * guarantee behind it.
   */
  deleteEmissionPoint(id: string): Promise<boolean>;
}

export const SITE_RESOURCES_REPOSITORY = Symbol('SiteResourcesRepository');
