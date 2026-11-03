/**
 * Capture du micro dans le renderer (ADR-004 D3) : `getUserMedia` (annulation
 * d'écho, réduction de bruit, gain automatique), `AudioContext` à 16 kHz et
 * `AudioWorklet` servi par l'app (`voice-capture-worklet.js`, sous
 * `script-src 'self'`), qui rend des trames de 100 ms en PCM mono.
 *
 * Injectée par contexte React : les tests de composants fournissent une fausse
 * capture (jsdom n'a ni micro ni Web Audio).
 */
import { createContext, use } from 'react';
import { VOICE_SAMPLE_RATE } from '@atelier/shared';

export interface MicCaptureOptions {
  /** Micro choisi dans les Réglages ; absent : micro par défaut. */
  deviceId?: string | undefined;
  /** Trame de 100 ms, PCM mono 16 kHz. */
  onFrame: (pcm: Float32Array) => void;
  /** Micro débranché ou coupé par le système. */
  onEnded: () => void;
}

export interface MicCapture {
  /** Ferme le micro et libère l'audio (aucune trame n'est gardée). */
  stop: () => Promise<void>;
}

export type StartMicCapture = (options: MicCaptureOptions) => Promise<MicCapture>;

/** Échec de l'ouverture du micro, classé pour le message affiché. */
export class MicCaptureError extends Error {
  constructor(
    readonly kind: 'denied' | 'no_device' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'MicCaptureError';
  }
}

/** Classe une erreur de `getUserMedia` (`DOMException.name`). */
export function classifyCaptureError(error: unknown): MicCaptureError {
  if (error instanceof MicCaptureError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicCaptureError('denied', 'Accès au micro refusé.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new MicCaptureError('no_device', 'Aucun micro disponible.');
  }
  return new MicCaptureError('unavailable', 'Le micro ne peut pas être ouvert.');
}

/** URL du worklet, fichier de l'app à côté de `index.html` (dev comme production). */
const WORKLET_URL = './voice-capture-worklet.js';

/** Capture réelle (Chromium). */
export const startMicCapture: StartMicCapture = async ({ deviceId, onFrame, onEnded }) => {
  // `navigator.mediaDevices` est absent hors contexte sécurisé.
  const devices = (navigator as Partial<Navigator>).mediaDevices;
  if (devices === undefined) throw new MicCaptureError('unavailable', 'Micro indisponible.');
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(deviceId !== undefined && deviceId !== '' ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  } catch (error) {
    throw classifyCaptureError(error);
  }
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
  let node: AudioWorkletNode | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    node?.port.close();
    node?.disconnect();
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    await context.close().catch(() => undefined);
  };
  try {
    await context.audioWorklet.addModule(WORKLET_URL);
    const source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'voice-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!stopped && event.data instanceof Float32Array) onFrame(event.data);
    };
    source.connect(node);
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (!stopped) onEnded();
      };
    }
  } catch {
    await stop();
    throw new MicCaptureError('unavailable', 'La capture audio n’a pas pu démarrer.');
  }
  return { stop };
};

/** Capture utilisée par la dictée (remplacée dans les tests). */
export const MicCaptureContext = createContext<StartMicCapture>(startMicCapture);

export function useMicCapture(): StartMicCapture {
  return use(MicCaptureContext);
}

/** Micros branchés (libellés vides tant que l'accès n'a pas été accordé). */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
  const devices = (navigator as Partial<Navigator>).mediaDevices;
  if (devices?.enumerateDevices === undefined) return [];
  const all = await devices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== '')
    .map((d, index) => ({
      deviceId: d.deviceId,
      label: d.label !== '' ? d.label : `Micro ${String(index + 1)}`,
    }));
}
