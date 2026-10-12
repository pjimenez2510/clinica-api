import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  BOARD_FIELDS,
  BOARD_FIELD_LABELS,
} from '../../../shared/domain/board-fields';
import { BOARD_NOTE_MAX } from '../domain/board';

import { agendaEntrySchema, clinicalDateField } from './agenda.dto';

/**
 * The day board's contract (AG-133 to AG-139, AG-176).
 *
 * TWO RESPONSE SHAPES AND NO PARAMETER BETWEEN THEM (AG-136): the staff row
 * and the waiting-room row are different schemas, served by different routes
 * under different permissions. Nothing here turns one into the other.
 */

const BOARD_FIELD = z.enum(BOARD_FIELDS);

export const staffBoardQuerySchema = z.object({
  /** The Ecuadorian calendar date; the day is cut in Guayaquil (AG-133). */
  date: clinicalDateField('Indique la fecha en formato AAAA-MM-DD'),
  practitionerId: z.uuid('Seleccione un profesional de la lista').optional(),
  specialtyId: z.uuid('Seleccione una especialidad de la lista').optional(),
});
/** Query of GET /agenda/sites/:siteId/board. */
export class StaffBoardQueryDto extends createZodDto(staffBoardQuerySchema) {}

/**
 * AG-134. The entry exactly as the day listing serves it — the board offers
 * the same actions as the calendar, and those are decided on these fields —
 * plus what the board adds. A field the caller's view lacks (AG-138) travels
 * `null`, and `fields` on the response says which ones the view carries.
 */
export const staffBoardRowSchema = agendaEntrySchema.extend({
  practitionerName: z.string().nullable(),
  roomName: z.string().nullable(),
  /** AG-134, AG-176. Never on the waiting-room projection. */
  boardNote: z.string().nullable(),
  /** AG-176. Who wrote the note last, and when. */
  boardNoteStamp: z
    .object({ byName: z.string(), at: z.iso.datetime() })
    .nullable(),
  /** AG-135. When the row entered its current state. */
  stateSince: z.iso.datetime().nullable(),
  /** AG-135. Whole minutes in it, against the application's clock at serving time. */
  minutesInState: z.number().int().nullable(),
  /** AG-134, AG-118. Minutes late, before or at arrival; `null` when not late. */
  latenessMinutes: z.number().int().nullable(),
  /**
   * AG-183 (D-170 §4). Una emergencia en sala sin «Enterado» de nadie a los
   * 2 minutos: avisar en persona. Calculado con el reloj de la aplicación.
   */
  emergencyNeedsInPersonNotice: z.boolean(),
  /** AG-184 (D-176 §3c). Si la nota de esta fila se puede escribir: hoy y abierta. */
  boardNoteEditable: z.boolean(),
});

export const staffBoardSchema = z.object({
  siteId: z.uuid(),
  date: z.iso.date(),
  /** AG-138. The optional columns this caller's view carries, in catalogue order. */
  fields: z.array(BOARD_FIELD),
  /** The instant every row was counted against. */
  generatedAt: z.iso.datetime(),
  /** Ordered by the appointment's instant (AG-133). */
  items: z.array(staffBoardRowSchema),
});
/** Response of GET /agenda/sites/:siteId/board. */
export class StaffBoardDto extends createZodDto(staffBoardSchema) {}
export type StaffBoardResponse = z.infer<typeof staffBoardSchema>;

/**
 * AG-137. A waiting-room row. NO IDENTIFIER of the appointment or the patient,
 * no document, no full name, no reason, no note — the schema itself has no
 * place for them.
 */
export const publicBoardRowSchema = z.object({
  startsAt: z.iso.datetime(),
  /** «María A.» (D-176.1). */
  displayName: z.string(),
  practitionerName: z.string(),
  roomName: z.string().nullable(),
  state: z.enum(['WAITING', 'IN_PREPARATION', 'IN_CARE']),
});

export const publicBoardSchema = z.object({
  siteId: z.uuid(),
  /** Today in Guayaquil: the route takes no date (D-176.2). */
  date: z.iso.date(),
  generatedAt: z.iso.datetime(),
  items: z.array(publicBoardRowSchema),
});
/** Response of GET /agenda/sites/:siteId/board/public. */
export class PublicBoardDto extends createZodDto(publicBoardSchema) {}
export type PublicBoardResponse = z.infer<typeof publicBoardSchema>;

/** AG-176. `null` or blank clears it. */
export const setBoardNoteSchema = z.object({
  boardNote: z
    .string()
    .trim()
    .max(
      BOARD_NOTE_MAX,
      `La nota no puede superar ${BOARD_NOTE_MAX} caracteres`,
    )
    .nullable(),
});
export class SetBoardNoteDto extends createZodDto(setBoardNoteSchema) {}

export const boardNoteSchema = z.object({
  boardNote: z.string().nullable(),
  boardNoteStamp: z.object({ byName: z.string(), at: z.iso.datetime() }),
});
/** Response of PUT …/entries/:entryId/board-note. */
export class BoardNoteDto extends createZodDto(boardNoteSchema) {}
export type BoardNoteResponse = z.infer<typeof boardNoteSchema>;

/** AG-138. The catalogue of fields, and each role's view. */
export const boardViewsSchema = z.object({
  fields: z.array(z.object({ code: BOARD_FIELD, label: z.string() })),
  roles: z.array(
    z.object({
      roleId: z.uuid(),
      roleCode: z.string(),
      roleName: z.string(),
      active: z.boolean(),
      fields: z.array(BOARD_FIELD),
    }),
  ),
});
/** Response of GET /agenda/board-views. */
export class BoardViewsDto extends createZodDto(boardViewsSchema) {}
export type BoardViewsResponse = z.infer<typeof boardViewsSchema>;

export const replaceBoardViewSchema = z.object({
  fields: z
    .array(
      z.enum(BOARD_FIELDS, {
        error: 'Elija campos del tablero de la lista',
      }),
    )
    .max(BOARD_FIELDS.length),
});
export class ReplaceBoardViewDto extends createZodDto(replaceBoardViewSchema) {}

export const boardViewSchema = z.object({
  roleId: z.uuid(),
  fields: z.array(BOARD_FIELD),
});
/** Response of PUT /agenda/board-views/:roleId. */
export class BoardViewDto extends createZodDto(boardViewSchema) {}
export type BoardViewResponse = z.infer<typeof boardViewSchema>;

/** Labels exported for the route, so the screen never hardcodes them. */
export const BOARD_FIELD_CATALOGUE = BOARD_FIELDS.map((code) => ({
  code,
  label: BOARD_FIELD_LABELS[code],
}));
