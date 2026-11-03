/**
 * Dictée dans le Composer (ADR-004 D6) : bouton micro à gauche de l'envoi,
 * raccourci ⌘⇧D, texte inséré au curseur à chaque pause, Échap pour annuler.
 *
 * - Premier usage : demande d'accès macOS au micro (au clic), puis carte de
 *   téléchargement du modèle si besoin.
 * - En écoute : bouton rouge, vu-mètre, chronomètre ; le champ est en lecture
 *   seule et l'envoi est suspendu (le texte dicté n'est jamais envoyé seul).
 * - Fin : nouveau clic ou ⌘⇧D ; arrêt automatique au bout de 5 min.
 * - La dictée reste possible pendant un tour de l'agent.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import type { VoiceSettings } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { cn } from '@renderer/lib/utils';
import {
  composeDictation,
  DICTATION_SHORTCUT_LABEL,
  dictationBlocker,
  formatElapsed,
  isDictationShortcut,
  sttModelOf,
} from '@renderer/lib/voice';
import { useDictation, type DictationEnd, type DictationPhase } from './useDictation';
import { useVoiceStatus } from './useVoiceStatus';
import { LevelMeter, MicDeniedAlert, ModelDownloadCard, voiceErrorText } from './VoiceParts';

/** Voix vue par le Composer (réglages et activation au premier usage). */
export interface ComposerVoice {
  /** Réglages en vigueur (défauts si la voix n'a jamais été réglée). */
  settings: VoiceSettings;
  /** Active la voix (premier usage : `voice.enabled` passe à vrai). */
  enable: () => Promise<void>;
}

type Panel = 'mic_denied' | 'model' | undefined;

const PHASE_ANNOUNCEMENTS: Record<Exclude<DictationPhase, 'idle'>, string> = {
  opening: 'Préparation de la dictée…',
  starting: 'Ouverture du micro…',
  listening: 'Micro ouvert : parlez. Échap pour annuler.',
  transcribing: 'Transcription en cours…',
};

const END_ANNOUNCEMENTS: Record<DictationEnd, string> = {
  max_duration: 'Dictée arrêtée au bout de 5 minutes. Texte inséré.',
  engine_stopped: 'La reconnaissance s’est arrêtée. Le texte reçu est inséré.',
  mic_lost: 'Le micro a été coupé. Le texte reçu est inséré.',
};

export function useComposerDictation({
  voice,
  value,
  onChange,
  textarea,
  disabled,
}: {
  voice: ComposerVoice | undefined;
  value: string;
  onChange: (value: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}): { button: ReactNode; panel: ReactNode; active: boolean } {
  const { status, refresh } = useVoiceStatus();
  const [panel, setPanel] = useState<Panel>();
  const [preparing, setPreparing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const [announcement, setAnnouncement] = useState('');
  /** Texte autour du curseur au début de la dictée, et texte d'origine (Échap). */
  const anchor = useRef<{ before: string; after: string; original: string } | undefined>(undefined);
  const pendingCursor = useRef<number | undefined>(undefined);
  /** Le champ a eu le focus : sa sélection est celle de l'utilisateur (sinon, fin du texte). */
  const touched = useRef(false);
  useEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const onFocus = (): void => {
      touched.current = true;
    };
    field.addEventListener('focus', onFocus);
    return () => {
      field.removeEventListener('focus', onFocus);
    };
  }, [textarea]);

  const dictation = useDictation({
    deviceId: voice?.settings.inputDeviceId,
    onLive: (text) => {
      const at = anchor.current;
      if (at) onChange(composeDictation(at.before, text, at.after).value);
    },
    onDone: (text, end) => {
      const at = anchor.current;
      anchor.current = undefined;
      if (!at) return;
      const composed = composeDictation(at.before, text, at.after);
      pendingCursor.current = composed.cursor;
      onChange(composed.value);
      setAnnouncement(
        end !== undefined
          ? END_ANNOUNCEMENTS[end]
          : text.trim() === ''
            ? 'Dictée terminée : aucun texte reconnu.'
            : 'Dictée terminée, texte inséré.',
      );
    },
    onCancelled: () => {
      const at = anchor.current;
      anchor.current = undefined;
      if (at) onChange(at.original);
      setAnnouncement('Dictée annulée, texte dicté retiré.');
    },
  });
  const { active, phase, start, stop, cancel } = dictation;

  // Curseur placé après le texte dicté, une fois le texte rendu.
  useEffect(() => {
    const cursor = pendingCursor.current;
    const field = textarea.current;
    if (cursor === undefined || !field) return;
    pendingCursor.current = undefined;
    field.focus();
    field.setSelectionRange(cursor, cursor);
  }, [value, textarea]);

  // Erreur au démarrage : micro refusé ou modèle absent ouvrent leur carte.
  const error = dictation.error;
  const errorPanel: Panel =
    error?.code === 'voice/mic_denied'
      ? 'mic_denied'
      : error?.code === 'voice/model_missing' || error?.code === 'voice/model_invalid'
        ? 'model'
        : undefined;
  const shownPanel = panel ?? errorPanel;

  const begin = async (): Promise<void> => {
    if (!voice) return;
    setPanel(undefined);
    setFailure(undefined);
    dictation.clearError();
    setPreparing(true);
    try {
      let current = await refresh();
      // Première fois : macOS demande l'autorisation, sur ce clic seulement.
      if (current.mic === 'not-determined') {
        current = { ...current, mic: await call('voice:request-mic') };
      }
      const blocker = dictationBlocker(current, voice.settings);
      if (blocker !== undefined) {
        setPanel(blocker);
        return;
      }
      if (!voice.settings.enabled) await voice.enable();
    } catch (e) {
      setFailure(voiceErrorText(toSerializedError(e)));
      return;
    } finally {
      setPreparing(false);
    }
    const field = textarea.current;
    const known = field !== null && (touched.current || document.activeElement === field);
    const selStart = known ? field.selectionStart : value.length;
    const selEnd = known ? field.selectionEnd : value.length;
    anchor.current = {
      before: value.slice(0, selStart),
      after: value.slice(selEnd),
      original: value,
    };
    const ok = await start();
    if (!ok) anchor.current = undefined;
  };

  const toggle = (): void => {
    if (active) void stop();
    else if (!preparing && !disabled) void begin();
  };
  // Le raccourci lit toujours la dernière version (valeur du champ, réglages).
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });

  // ⌘⇧D partout dans la vue ; Échap annule pendant la dictée.
  useEffect(() => {
    if (!voice) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && active) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (!isDictationShortcut(event)) return;
      // Une demande de permission attend une réponse : la voix n'y touche pas.
      if (document.querySelector('[role="alertdialog"]')) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [voice, active, cancel]);

  if (!voice) return { button: null, panel: null, active: false };

  const model = sttModelOf(status, voice.settings);
  const download = async (): Promise<void> => {
    if (!model) return;
    setInstalling(true);
    setFailure(undefined);
    try {
      if (!voice.settings.enabled) await voice.enable();
      await call('voice:install-model', { id: model.id });
      await refresh();
      dictation.clearError();
    } catch (e) {
      const serialized = toSerializedError(e);
      // Annulation : la carte revient à son état de départ, sans message.
      if (serialized.details?.['reason'] !== 'cancelled') setFailure(errorMessage(serialized));
      await refresh().catch(() => undefined);
    } finally {
      setInstalling(false);
    }
  };
  const dismiss = (): void => {
    setPanel(undefined);
    dictation.clearError();
  };

  const listening = phase === 'listening' || phase === 'starting';
  const busy = preparing || phase === 'opening' || phase === 'transcribing';
  const label = active
    ? `Terminer la dictée (${DICTATION_SHORTCUT_LABEL})`
    : `Dicter (${DICTATION_SHORTCUT_LABEL})`;

  const button = (
    <span className="flex items-center gap-2">
      {listening ? (
        <span className="flex items-center gap-1.5 text-xs tabular-nums text-destructive-text">
          <LevelMeter level={dictation.level} />
          <span data-testid="voice-timer">{formatElapsed(dictation.elapsedMs)}</span>
        </span>
      ) : null}
      <Button
        size="icon"
        variant={active ? 'destructive' : 'ghost'}
        aria-label={label}
        title={label}
        aria-pressed={active}
        disabled={(disabled && !active) || (preparing && !active)}
        onClick={toggle}
        className={cn('size-8 shrink-0', !active && 'text-muted-foreground')}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : active ? (
          <Square className="size-3.5 fill-current" aria-hidden />
        ) : (
          <Mic className="size-4" aria-hidden />
        )}
      </Button>
      <span className="sr-only" aria-live="polite" data-testid="voice-announcer">
        {phase !== 'idle' ? PHASE_ANNOUNCEMENTS[phase] : announcement}
      </span>
    </span>
  );

  let content: ReactNode = null;
  if (shownPanel === 'mic_denied') {
    content = <MicDeniedAlert onDismiss={dismiss} />;
  } else if (shownPanel === 'model') {
    content = (
      <ModelDownloadCard
        model={model}
        busy={installing}
        onDownload={() => void download()}
        onCancelDownload={() => {
          if (model) call('voice:cancel-install', { id: model.id }).catch(() => undefined);
        }}
        onDismiss={dismiss}
      />
    );
  } else if (error) {
    content = (
      <Alert tone="error">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {voiceErrorText(error)}
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Fermer
          </Button>
        </span>
      </Alert>
    );
  } else if (dictation.warning === 'silent_input' && listening) {
    content = (
      <Alert tone="warning">
        Aucun son ne parvient du micro. Vérifiez qu’il n’est pas coupé, ou choisissez-en un autre
        dans Réglages › Voix.
      </Alert>
    );
  }
  const panelNode =
    content !== null || failure !== undefined ? (
      <div className="space-y-2">
        {failure !== undefined ? <Alert tone="error">{failure}</Alert> : null}
        {content}
      </div>
    ) : null;

  return { button, panel: panelNode, active };
}
