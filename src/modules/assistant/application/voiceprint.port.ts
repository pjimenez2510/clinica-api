import type { ListeningVoiceprint } from './speech-recognizer.port';

/**
 * E17 (AS-310 to AS-314, D-265 §1, LOPDP art. 26). The professional's
 * voiceprint: a vector `clinica-ai` made from them reading, and nothing of the
 * recording. Biometric data: it never leaves the API in a response (AS-319).
 */
export interface Voiceprint {
  /** The voice model that made it; another model's is refused (CAI-019). */
  model: string;
  dimension: number;
  vector: number[];
  /** How many phrases with voice, and how many seconds of them, it averages. */
  phrases: number;
  seconds: number;
}

export interface StoredVoiceprint extends Voiceprint {
  userId: string;
  /** AS-313. «Distinguir mi voz de la del paciente». */
  attribution: boolean;
  consentedAt: Date;
  updatedAt: Date;
}

/** CAI-020. Whether `clinica-ai` can tell voices apart now, and why not. */
export interface AttributionStatus {
  available: boolean;
  reason: string | null;
}

/**
 * AS-310, AS-311. `clinica-ai` (`POST /v1/speech/voiceprint`). The recording
 * is handed over and forgotten. Throws `VoiceNotHeardError` when there was
 * not enough voice and `VoiceUnavailableError` when it cannot make one.
 */
export interface VoiceprintEnroller {
  enrol(recording: Buffer, signal?: AbortSignal): Promise<Voiceprint>;
  attributionStatus(): Promise<AttributionStatus>;
}

export const VOICEPRINT_ENROLLER = Symbol('VOICEPRINT_ENROLLER');

export interface VoiceprintStore {
  find(userId: string): Promise<StoredVoiceprint | null>;
  /**
   * AS-312. Writes the voiceprint, replacing the one the person had; the
   * switch keeps its position, and a first one starts with it off (AS-313).
   */
  save(
    userId: string,
    voiceprint: Voiceprint,
    at: Date,
  ): Promise<StoredVoiceprint>;
  /** AS-313. `false` when the person has no voiceprint. */
  setAttribution(userId: string, on: boolean, at: Date): Promise<boolean>;
  /** AS-312. Removes the row; `false` when there was none. */
  remove(userId: string): Promise<boolean>;
}

export const VOICEPRINT_STORE = Symbol('VOICEPRINT_STORE');

/**
 * AS-314. What the listening sends `clinica-ai` in `start`: the voiceprint of
 * whoever opens it, only when they have one and the switch is on.
 */
export interface ListeningVoiceprints {
  forListening(userId: string): Promise<ListeningVoiceprint | null>;
}

export const LISTENING_VOICEPRINTS = Symbol('LISTENING_VOICEPRINTS');
