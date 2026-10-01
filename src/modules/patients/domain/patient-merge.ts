/**
 * PA-062, D-110 §7 (provisional until the IESS confirms the procedure). What
 * the desk reads when a merge brings together rests that overlap with a
 * maternity rest: the merge is done —it corrects a duplicated identity— and
 * the one that does not belong is revoked from its attention (CER-011).
 * `null` when there is nothing to say.
 */
export function restOverlapNoticeOf(overlaps: number): string | null {
  if (overlaps === 0) return null;
  return overlaps === 1
    ? 'La fusión junta 1 reposo que se solapa con una maternidad. Anule desde su atención el que no corresponda.'
    : `La fusión junta ${overlaps} reposos que se solapan con una maternidad. Anule desde su atención los que no correspondan.`;
}
