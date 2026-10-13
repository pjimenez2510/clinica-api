import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-045, AS-056. The contract of the listening. The audio channel itself is
 * not HTTP and is not in OpenAPI: its messages are described in
 * `listening.gateway.ts`.
 */

const ticketSchema = z.object({
  /** Single use, sent as the first message of the channel; never in a URL. */
  ticket: z.string(),
  expiresAt: z.iso.datetime(),
});

const sessionSchema = z.object({
  state: z.enum(['LISTENING', 'PAUSED', 'STOPPED']),
  /** The clock of the consultation, in ms. */
  offsetMs: z.number().int(),
  /** Why the system paused it, as a code; null when nobody but the physician did. */
  reason: z
    .enum(['device-lost', 'recognizer-failed', 'store-failed'])
    .nullable(),
  device: z.string(),
  /** Whether a channel is capturing right now. */
  capturing: z.boolean(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const listeningSchema = z.object({
  session: sessionSchema.nullable(),
  segments: z.array(
    z.object({
      startMs: z.number().int(),
      endMs: z.number().int(),
      text: z.string(),
    }),
  ),
  /** AS-167. The patient has the authorization to record standing. */
  recordingAuthorized: z.boolean(),
});

/** AS-168. What registering the authorization from the attention answers. */
const recordingAuthorizationSchema = z.object({
  recordingAuthorized: z.boolean(),
});

export class ListeningTicketDto extends createZodDto(ticketSchema) {}
export class ListeningDto extends createZodDto(listeningSchema) {}
export class RecordingAuthorizationDto extends createZodDto(
  recordingAuthorizationSchema,
) {}
