import { ConflictError } from './domain-error';

/**
 * The chart was merged into another after a duplicate was resolved.
 *
 * NOT a 404: the record genuinely existed and printed documents still quote
 * its MRN. The caller needs to be told where it went, or a receptionist will
 * keep opening the old chart and wondering why the notes stop.
 *
 * IN `shared`, AND THAT IS THE POINT OF THIS FILE. It was declared inside
 * `modules/patients`, and the first module that had to refuse an operation on a
 * merged chart — the agenda, AG-027 — could not reach it: no module imports
 * another. Declaring a second class with the same `PATIENT_MERGED` code is what
 * `error-catalogue.spec.ts` refuses outright, and it is right to: two errors
 * answering one code is two situations a client cannot tell apart.
 *
 * Every module that acts on a patient meets this state — the agenda today, the
 * encounter and the invoice next — so the error belongs to the shared clinical
 * vocabulary, exactly like `Principal` does for authorisation.
 */
export class PatientMergedError extends ConflictError {
  readonly code = 'PATIENT_MERGED';
  override readonly userTitle =
    'Esta historia se unificó con otra. Abra la vigente';

  constructor(readonly survivingMrn: string) {
    /**
     * The number travels in `errors[]`, and that is the fix rather than a
     * decoration.
     *
     * `problem-details.filter.ts` emits `type`, `title`, `status`, `detail`,
     * `code` and `errors[]` — `params` never leaves the process, and `detail`
     * is dropped in production because a technical message can drag a
     * PostgreSQL row along with it. So until this existed, production answered
     * "Esta historia se unificó con otra. Abra la vigente" and NO NUMBER, and
     * the test that claimed otherwise was reading `detail`, which only exists
     * outside production. `errors[]` is the one structured channel emitted in
     * every environment.
     *
     * The surviving MEDICAL RECORD NUMBER and nothing else: it is an internal
     * number, not a national identifier, and it is exactly what AG-027 orders
     * to say. No name, no document, no reason for the visit (SC-006).
     */
    super(`Patient was merged into ${survivingMrn}`, { mrn: survivingMrn }, [
      {
        // The field of the request that has to change: the client sent a
        // `patientId` whose chart moved.
        field: 'patientId',
        code: 'PATIENT_MERGED',
        message: `La historia vigente es ${survivingMrn}`,
      },
    ]);
  }
}
