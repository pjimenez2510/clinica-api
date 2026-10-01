import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import type {
  RestOverlap,
  RestOverlapSide,
} from '../../../shared/domain/rest-overlap';

export type { RestOverlap, RestOverlapSide };

const shown = (day: ClinicalDate) => day.split('-').reverse().join('/');
const named = (rest: RestOverlapSide) =>
  `el N.º ${rest.number} (${rest.maternity ? 'maternidad, ' : ''}del ${shown(rest.from)} al ${shown(rest.to)})`;

/**
 * PA-062, D-110 §7 (provisional until the IESS confirms the procedure). What
 * the desk reads when a merge brings together rests that overlap with a
 * maternity rest: the merge is done —it corrects a duplicated identity— and
 * each pair is NAMED, by number and period, so the one that does not belong is
 * revoked from its attention (CER-011). `null` when there is nothing to say.
 */
export function restOverlapNoticeOf(
  overlaps: readonly RestOverlap[],
): string | null {
  if (overlaps.length === 0) return null;
  const pairs = overlaps
    .map(
      ({ absorbed, surviving }) => `${named(absorbed)} con ${named(surviving)}`,
    )
    .join('; ');
  return `La fusión junta reposos que se solapan con una maternidad: ${pairs}. Anule desde su atención el que no corresponda.`;
}
