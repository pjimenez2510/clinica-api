import { ValidationError, type DomainFieldError } from './domain-error';

/**
 * D-021, SP-021, SP-022. A configurable duration is not a whole number of
 * slots.
 *
 * WHY IN `shared` AND NOT IN `specialties`. `specialties` owns the base
 * duration of a service type and `staff` owns the per-practitioner exception,
 * and both have to refuse the same thing with the SAME code — `code` is a
 * public contract and changing the emitter must not change the string. The
 * alternative was for one module to import the class from the other, which
 * `dependency-cruiser`'s `sin-imports-entre-modulos` refuses outright. Same
 * path `SERVICE_TYPE_NOT_FOUND` and `INVALID_RUC` already took.
 *
 * WHY NOT `PARAM_OUT_OF_RANGE`. That code is `configuration`'s, it means «a
 * site parameter is outside its declared range», and this is neither a site
 * parameter nor a range: a duration of 25 minutes on a 10-minute grid is
 * comfortably inside 5..240 and still unbookable. A client branching on the
 * code would have to read the Spanish text to tell the two apart, which is the
 * one thing `code` exists to avoid. The SHAPE is borrowed, though — a 422 with
 * one entry in `errors[]` per offending field, naming the number to type
 * instead — because that is what makes CF-065 usable and the reason is the
 * same here.
 */
export class DurationNotSlotMultipleError extends ValidationError {
  readonly code = 'DURATION_NOT_SLOT_MULTIPLE';
  override readonly userTitle =
    'La duración no encaja en los turnos de la agenda. Ajústela al múltiplo indicado y guarde de nuevo';

  constructor(fieldErrors: readonly DomainFieldError[]) {
    super('Duration is not a multiple of the site slot atom', {}, fieldErrors);
  }
}
