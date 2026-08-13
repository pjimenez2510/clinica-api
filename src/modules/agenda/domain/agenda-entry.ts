/**
 * The two closed vocabularies of an agenda entry, in a file with NO imports.
 *
 * They used to live in `agenda.repository.ts`, until the transition errors
 * needed the status union to label states in Spanish — and the port imports
 * the booking policy, which imports the errors: a cycle. The vocabulary is
 * upstream of everything in this module, so it lives upstream. The port
 * re-exports both, and every existing importer keeps its path.
 */

export type AgendaEntryKind = 'APPOINTMENT' | 'BLOCK';

export type AgendaEntryStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'BLOCKED';
