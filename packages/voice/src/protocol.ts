/**
 * Protocole entre le main et le worker de reconnaissance (`utilityProcess`,
 * ADR-004 D2). Chaque message est validé par Zod à la réception, dans les deux
 * sens : un message invalide est rejeté sans être exécuté.
 *
 * Confidentialité (D9) : aucun message de rejet ni d'erreur ne recopie le
 * contenu reçu (trames, texte) ; seul le chemin du champ fautif est rendu.
 */
import { z } from 'zod';
import {
  ATELIER_ERROR_CODES,
  VOICE_SAMPLE_RATE,
  type SerializedAtelierError,
  type TranscriptSegment,
  type VoiceInputWarning,
  type VoiceSessionState,
} from '@atelier/shared';

/** Chemin absolu sans `..` ni caractère nul : le worker ne reçoit que des chemins validés. */
const absolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine((p) => p.startsWith('/'), 'chemin absolu attendu')
  .refine((p) => !p.includes('\0'), 'caractère nul interdit')
  .refine((p) => !p.split('/').includes('..'), 'segment « .. » interdit');

const sessionId = z.string().min(1).max(128);

/** Borne haute de `maxDurationMs` (une heure), pour refuser une valeur absurde. */
const MAX_PROTOCOL_DURATION_MS = 60 * 60 * 1000;

/** Modèles à charger. Les chemins viennent du gestionnaire de modèles (L1), jamais du renderer. */
export const engineLoadConfigSchema = z.strictObject({
  /** Fichier `silero_vad.onnx` (embarqué dans l'app). */
  vadModel: absolutePath,
  /** Modèle de reconnaissance : identifiant du catalogue et dossier installé. */
  stt: z.strictObject({ modelId: z.string().min(1).max(128), dir: absolutePath }),
  /** Threads de calcul (S1 : 2 suffisent). */
  numThreads: z.int().min(1).max(8).default(2),
  /** S1 : CoreML n'est pas plus rapide et occupe plus de mémoire, `cpu` par défaut. */
  provider: z.enum(['cpu', 'coreml']).default('cpu'),
});
export type EngineLoadConfig = z.infer<typeof engineLoadConfigSchema>;
export type EngineLoadConfigInput = z.input<typeof engineLoadConfigSchema>;

/** Trame PCM : `Float32Array` non vide, au plus une seconde, valeurs finies. */
const pcmFrame = z
  .custom<Float32Array>((v) => v instanceof Float32Array, 'Float32Array attendu')
  .refine((pcm) => pcm.length > 0 && pcm.length <= VOICE_SAMPLE_RATE, 'trame de taille invalide')
  .refine((pcm) => pcm.every((v) => Number.isFinite(v)), 'échantillon non fini');

/** Messages du main vers le worker. */
export const mainToWorkerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('load'), config: engineLoadConfigSchema }),
  z.strictObject({
    type: z.literal('start'),
    voiceSessionId: sessionId,
    /** Durée maximale de la dictée ; `MAX_DICTATION_MS` par défaut. */
    maxDurationMs: z.int().min(1000).max(MAX_PROTOCOL_DURATION_MS).optional(),
  }),
  z.strictObject({
    type: z.literal('audio'),
    voiceSessionId: sessionId,
    seq: z.int().min(0),
    pcm: pcmFrame,
  }),
  z.strictObject({ type: z.literal('stop'), voiceSessionId: sessionId }),
  z.strictObject({ type: z.literal('cancel'), voiceSessionId: sessionId }),
  z.strictObject({ type: z.literal('shutdown') }),
]);
export type MainToWorkerMessage = z.input<typeof mainToWorkerSchema>;
export type ParsedMainToWorkerMessage = z.output<typeof mainToWorkerSchema>;

const serializedErrorSchema = z.strictObject({
  code: z.enum(ATELIER_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<SerializedAtelierError>;

const transcriptSegmentSchema = z.strictObject({
  voiceSessionId: sessionId,
  index: z.int().min(0),
  text: z.string(),
  final: z.boolean(),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
}) satisfies z.ZodType<TranscriptSegment>;

const sessionStates = [
  'starting',
  'listening',
  'transcribing',
  'idle',
  'thinking',
  'speaking',
  'waiting_permission',
] as const satisfies readonly VoiceSessionState[];
const inputWarnings = ['silent_input'] as const satisfies readonly VoiceInputWarning[];

/** Messages du worker vers le main. */
export const workerToMainSchema = z.discriminatedUnion('type', [
  /** Le worker a démarré et attend `load`. */
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('loaded'), loadMs: z.number().min(0) }),
  z.strictObject({
    type: z.literal('state'),
    voiceSessionId: sessionId,
    state: z.enum(sessionStates),
    warning: z.enum(inputWarnings).optional(),
  }),
  z.strictObject({ type: z.literal('transcript'), segment: transcriptSegmentSchema }),
  z.strictObject({
    type: z.literal('final'),
    voiceSessionId: sessionId,
    text: z.string(),
    /** `max_duration` : arrêt automatique au bout de `MAX_DICTATION_MS`. */
    reason: z.enum(['stopped', 'max_duration']),
  }),
  z.strictObject({
    type: z.literal('error'),
    voiceSessionId: sessionId.optional(),
    error: serializedErrorSchema,
  }),
  /** Message reçu invalide : seul le chemin du champ fautif est rendu, jamais sa valeur. */
  z.strictObject({ type: z.literal('rejected'), issue: z.string().max(200) }),
]);
export type WorkerToMainMessage = z.infer<typeof workerToMainSchema>;

/** Résultat d'une validation : le message, ou le chemin du premier champ fautif. */
export type ParseResult<T> = { ok: true; message: T } | { ok: false; issue: string };

function parseWith<T>(schema: z.ZodType<T>, data: unknown): ParseResult<T> {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, message: result.data };
  const first = result.error.issues[0];
  const path = first?.path.map(String).join('.') ?? '';
  return { ok: false, issue: path === '' ? 'message' : path };
}

/** Valide un message reçu par le worker. */
export function parseMainToWorker(data: unknown): ParseResult<ParsedMainToWorkerMessage> {
  return parseWith(mainToWorkerSchema, data);
}

/** Valide un message reçu par le main. */
export function parseWorkerToMain(data: unknown): ParseResult<WorkerToMainMessage> {
  return parseWith(workerToMainSchema, data);
}
