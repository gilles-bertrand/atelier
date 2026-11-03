/**
 * Session de dictée côté renderer (ADR-004 D3, D6) : `voice:start`, capture du
 * micro, trames envoyées par `voice:audio`, segments reçus à chaque pause
 * (`voice:transcript`), puis `voice:stop` (texte final) ou `voice:cancel`.
 *
 * Le hook ne touche pas au texte du Composer : il rend le texte dicté par ses
 * rappels (`onLive`, `onDone`, `onCancelled`). Aucun audio n'est gardé : chaque
 * trame part au main puis n'est plus référencée.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_DICTATION_MS,
  type SerializedAtelierError,
  type VoiceInputWarning,
} from '@atelier/shared';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { joinSegments, micLevel } from '@renderer/lib/voice';
import { MicCaptureError, useMicCapture, type MicCapture } from './capture';

/**
 * - `opening` : `voice:start` en cours (moteur qui se charge) ;
 * - `starting` : micro en cours d'ouverture, aucune trame encore traitée ;
 * - `listening` : l'utilisateur peut parler ;
 * - `transcribing` : arrêt demandé, dernier segment en cours.
 */
export type DictationPhase = 'idle' | 'opening' | 'starting' | 'listening' | 'transcribing';

/** Fin d'une dictée qui n'a pas été demandée par l'utilisateur. */
export type DictationEnd = 'max_duration' | 'engine_stopped' | 'mic_lost';

export interface DictationCallbacks {
  /** Texte dicté jusqu'ici (segments assemblés), à chaque pause. */
  onLive?: (text: string) => void;
  /** Texte final (typographie appliquée par le main). */
  onDone: (text: string, end?: DictationEnd) => void;
  /** Dictée abandonnée : le texte dicté doit être retiré. */
  onCancelled?: () => void;
}

export interface DictationOptions extends DictationCallbacks {
  deviceId?: string | undefined;
  /**
   * Arrêt côté renderer (test de 5 s des Réglages). Par défaut, un filet de
   * sécurité juste après l'arrêt automatique du main (5 min).
   */
  maxMs?: number;
}

export interface Dictation {
  phase: DictationPhase;
  active: boolean;
  /** Durée depuis le début de la prise. */
  elapsedMs: number;
  /** Niveau du micro, de 0 à 1 (vu-mètre). */
  level: number;
  warning: VoiceInputWarning | undefined;
  /** Dernière erreur (codes `voice/*`, `voice/mic_denied` pour un micro refusé). */
  error: SerializedAtelierError | undefined;
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  cancel: () => void;
  clearError: () => void;
}

/** Délai laissé au main pour son propre arrêt à 5 min avant que le renderer n'arrête. */
const MAIN_AUTOSTOP_GRACE_MS = 3_000;

function captureError(error: MicCaptureError): SerializedAtelierError {
  switch (error.kind) {
    case 'denied':
      return {
        code: 'voice/mic_denied',
        message: error.message,
        retryable: false,
      };
    case 'no_device':
      return {
        code: 'voice/no_input',
        message: error.message,
        retryable: true,
        details: { reason: 'no_device' },
      };
    case 'unavailable':
      return { code: 'voice/no_input', message: error.message, retryable: true };
  }
}

interface Live {
  id: string;
  capture: MicCapture | undefined;
  seq: number;
  segments: string[];
  startedAt: number;
  /** Arrêt ou annulation demandés par l'utilisateur (l'`idle` du main est alors attendu). */
  ending: boolean;
}

export function useDictation(options: DictationOptions): Dictation {
  const startCapture = useMicCapture();
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [warning, setWarning] = useState<VoiceInputWarning | undefined>();
  const [error, setError] = useState<SerializedAtelierError | undefined>();
  const live = useRef<Live | undefined>(undefined);
  /** Annulation demandée pendant `voice:start`. */
  const abortOpening = useRef(false);
  const opening = useRef(false);
  const mounted = useRef(true);
  /** Lus après un `await` : fonctions, pour que TypeScript ne fige pas leur valeur. */
  const isMounted = (): boolean => mounted.current;
  const isAborted = (): boolean => abortOpening.current || !mounted.current;
  const callbacks = useRef<DictationOptions>(options);
  useEffect(() => {
    callbacks.current = options;
  });

  const reset = useCallback(() => {
    live.current = undefined;
    if (!mounted.current) return;
    setPhase('idle');
    setLevel(0);
    setWarning(undefined);
  }, []);

  /** Fin non demandée (5 min, moteur arrêté, micro débranché) : le texte reçu est gardé. */
  const endUnexpectedly = useCallback(
    (end: DictationEnd) => {
      const session = live.current;
      if (!session || session.ending) return;
      session.ending = true;
      void session.capture?.stop();
      if (end === 'mic_lost') {
        // Le main attend encore : on termine proprement pour garder le texte final.
        void call('voice:stop', { voiceSessionId: session.id }).then(
          ({ text }) => {
            reset();
            callbacks.current.onDone(text, end);
          },
          () => {
            reset();
            callbacks.current.onDone(joinSegments(session.segments), end);
          },
        );
        return;
      }
      reset();
      callbacks.current.onDone(joinSegments(session.segments), end);
    },
    [reset],
  );

  // Événements du main pour la session en cours.
  useEffect(() => {
    const api = atelier();
    const offTranscript = api.on('voice:transcript', (segment) => {
      const session = live.current;
      if (session?.id !== segment.voiceSessionId) return;
      session.segments[segment.index] = segment.text;
      callbacks.current.onLive?.(joinSegments(session.segments));
    });
    const offState = api.on('voice:state', ({ voiceSessionId, state, warning: alert }) => {
      const session = live.current;
      if (session?.id !== voiceSessionId) return;
      setWarning(alert);
      if (state === 'listening' && !session.ending) setPhase('listening');
      if (state === 'idle' && !session.ending) {
        const elapsed = Date.now() - session.startedAt;
        endUnexpectedly(elapsed >= MAX_DICTATION_MS - 1_000 ? 'max_duration' : 'engine_stopped');
      }
    });
    return () => {
      offTranscript();
      offState();
    };
  }, [endUnexpectedly]);

  const stop = useCallback(async () => {
    if (opening.current) {
      abortOpening.current = true;
      return;
    }
    const session = live.current;
    if (!session || session.ending) return;
    session.ending = true;
    setPhase('transcribing');
    setLevel(0);
    await session.capture?.stop();
    let text: string;
    try {
      ({ text } = await call('voice:stop', { voiceSessionId: session.id }));
    } catch (e) {
      text = joinSegments(session.segments);
      if (mounted.current) setError(toSerializedError(e));
    }
    reset();
    callbacks.current.onDone(text);
  }, [reset]);

  const cancel = useCallback(() => {
    if (opening.current) {
      abortOpening.current = true;
      callbacks.current.onCancelled?.();
      return;
    }
    const session = live.current;
    if (!session) return;
    session.ending = true;
    void session.capture?.stop();
    call('voice:cancel', { voiceSessionId: session.id }).catch(() => undefined);
    reset();
    callbacks.current.onCancelled?.();
  }, [reset]);

  const start = useCallback(async (): Promise<boolean> => {
    if (live.current || opening.current) return false;
    setError(undefined);
    setWarning(undefined);
    setElapsedMs(0);
    setPhase('opening');
    opening.current = true;
    abortOpening.current = false;
    let id: string;
    try {
      ({ voiceSessionId: id } = await call('voice:start', { mode: 'dictation' }));
    } catch (e) {
      opening.current = false;
      reset();
      if (mounted.current) setError(toSerializedError(e));
      return false;
    }
    opening.current = false;
    if (isAborted()) {
      call('voice:cancel', { voiceSessionId: id }).catch(() => undefined);
      reset();
      return false;
    }
    const session: Live = {
      id,
      capture: undefined,
      seq: 0,
      segments: [],
      startedAt: Date.now(),
      ending: false,
    };
    live.current = session;
    setPhase('starting');
    try {
      session.capture = await startCapture({
        deviceId: callbacks.current.deviceId,
        onFrame: (pcm) => {
          if (live.current !== session || session.ending) return;
          const seq = session.seq;
          session.seq += 1;
          setLevel(micLevel(pcm));
          // Trame refusée (session terminée entre-temps) : rien à faire, la suivante non plus.
          void atelier().invoke('voice:audio', { voiceSessionId: id, seq, pcm });
        },
        onEnded: () => {
          endUnexpectedly('mic_lost');
        },
      });
    } catch (e) {
      call('voice:cancel', { voiceSessionId: id }).catch(() => undefined);
      reset();
      if (isMounted()) {
        setError(
          e instanceof MicCaptureError
            ? captureError(e)
            : { code: 'voice/no_input', message: String(e), retryable: true },
        );
      }
      return false;
    }
    // Annulé (Échap) pendant l'ouverture du micro.
    if (session.ending) await session.capture.stop();
    return true;
  }, [endUnexpectedly, reset, startCapture]);

  // Chronomètre et arrêt de sécurité.
  const active = phase !== 'idle';
  const maxMs = options.maxMs ?? MAX_DICTATION_MS + MAIN_AUTOSTOP_GRACE_MS;
  useEffect(() => {
    if (phase !== 'starting' && phase !== 'listening') return;
    const tick = (): void => {
      const session = live.current;
      if (!session) return;
      const elapsed = Date.now() - session.startedAt;
      setElapsedMs(elapsed);
      if (elapsed >= maxMs) void stop();
    };
    const timer = window.setInterval(tick, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase, maxMs, stop]);

  // Démontage (conversation quittée, fenêtre rechargée) : la session est abandonnée.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = live.current;
      if (opening.current) abortOpening.current = true;
      if (session && !session.ending) {
        session.ending = true;
        void session.capture?.stop();
        call('voice:cancel', { voiceSessionId: session.id }).catch(() => undefined);
      }
      live.current = undefined;
    };
  }, []);

  return {
    phase,
    active,
    elapsedMs,
    level,
    warning,
    error,
    start,
    stop,
    cancel,
    clearError: () => {
      setError(undefined);
    },
  };
}
