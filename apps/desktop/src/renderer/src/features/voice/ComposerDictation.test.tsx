// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_SETTINGS, MAX_DICTATION_MS, type VoiceSettings } from '@atelier/shared';
import { Composer } from '@renderer/features/chat/Composer';
import {
  FakeIpcFailure,
  installFakeApi,
  type FakeApi,
  type FakeHandlers,
} from '@renderer/test/fake-api';
import { fakeCapture, sttModel, voiceStatus, type FakeCapture } from '@renderer/test/fake-voice';
import { MicCaptureContext, MicCaptureError } from './capture';
import type { ComposerVoice } from './ComposerDictation';

interface Setup {
  api: FakeApi;
  capture: FakeCapture;
  enable: ReturnType<typeof vi.fn>;
  onSend: ReturnType<typeof vi.fn>;
  textarea: () => HTMLTextAreaElement;
  micButton: () => HTMLElement;
}

function setup({
  initial = '',
  handlers = {},
  settings = { ...DEFAULT_VOICE_SETTINGS, enabled: true },
  running = false,
}: {
  initial?: string;
  handlers?: FakeHandlers;
  settings?: VoiceSettings;
  running?: boolean;
} = {}): Setup {
  const api = installFakeApi({
    'voice:status': () => voiceStatus(),
    'voice:start': () => ({ voiceSessionId: 'v1' }),
    'voice:audio': () => undefined,
    'voice:stop': () => ({ text: '' }),
    'voice:cancel': () => undefined,
    ...handlers,
  });
  const capture = fakeCapture();
  const enable = vi.fn(() => Promise.resolve());
  const onSend = vi.fn();
  const voice: ComposerVoice = { settings, enable };

  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <MicCaptureContext value={capture.start}>
        <Composer
          value={value}
          onChange={setValue}
          attachments={[]}
          onRemoveAttachment={() => undefined}
          onSend={onSend}
          onStop={() => undefined}
          running={running}
          disabled={false}
          importing={false}
          voice={voice}
        />
      </MicCaptureContext>
    );
  }
  render(<Harness />);
  return {
    api,
    capture,
    enable,
    onSend,
    textarea: () => screen.getByLabelText<HTMLTextAreaElement>('Votre message'),
    micButton: () => screen.getByRole('button', { name: /dict/i }),
  };
}

/** Démarre une dictée et attend l'ouverture du micro. */
async function startDictation(s: Setup): Promise<void> {
  await userEvent.click(s.micButton());
  await waitFor(() => {
    expect(s.capture.opened).toBe(1);
  });
}

function listening(api: FakeApi): void {
  api.emit('voice:state', { voiceSessionId: 'v1', state: 'listening' });
}

function segment(api: FakeApi, index: number, text: string): void {
  api.emit('voice:transcript', {
    voiceSessionId: 'v1',
    index,
    text,
    final: true,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
  });
}

describe('Dictée dans le Composer', () => {
  it('passe par les états du bouton : repos, écoute (rouge, vu-mètre, chronomètre), fin', async () => {
    const s = setup();
    expect(s.micButton()).toHaveAccessibleName('Dicter (⌘⇧D)');
    expect(s.micButton()).toHaveAttribute('aria-pressed', 'false');

    await startDictation(s);
    expect(s.api.callsTo('voice:start')).toEqual([{ mode: 'dictation' }]);
    expect(s.micButton()).toHaveAccessibleName('Terminer la dictée (⌘⇧D)');
    expect(s.micButton()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('voice-announcer')).toHaveTextContent('Ouverture du micro');

    listening(s.api);
    expect(screen.getByTestId('voice-announcer')).toHaveTextContent('Micro ouvert : parlez.');
    expect(screen.getByTestId('voice-timer')).toHaveTextContent('0:00');
    expect(screen.getByTestId('voice-level')).toBeInTheDocument();

    // Trames de 100 ms numérotées, envoyées par `voice:audio`.
    s.capture.frame();
    s.capture.frame();
    const frames = s.api.callsTo('voice:audio');
    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(frames[0]?.voiceSessionId).toBe('v1');
    expect(frames[0]?.pcm).toBeInstanceOf(Float32Array);

    await userEvent.click(s.micButton());
    await waitFor(() => {
      expect(s.micButton()).toHaveAccessibleName('Dicter (⌘⇧D)');
    });
    expect(s.api.callsTo('voice:stop')).toEqual([{ voiceSessionId: 'v1' }]);
    expect(s.capture.stopped).toBe(1);
    expect(screen.getByTestId('voice-announcer')).toHaveTextContent('aucun texte reconnu');
  });

  it('insère le texte au curseur à chaque pause, puis le texte final, sans l’envoyer', async () => {
    const s = setup({
      initial: 'Bonjour monde',
      handlers: { 'voice:stop': () => ({ text: 'cher : ami' }) },
    });
    s.textarea().focus();
    s.textarea().setSelectionRange(8, 8);
    await startDictation(s);
    listening(s.api);

    segment(s.api, 0, 'cher');
    expect(s.textarea()).toHaveValue('Bonjour cher monde');
    expect(s.textarea()).toHaveAttribute('readonly');
    // Pendant la dictée, Entrée n'envoie rien.
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();

    segment(s.api, 1, 'ami');
    expect(s.textarea()).toHaveValue('Bonjour cher ami monde');

    await userEvent.click(s.micButton());
    await waitFor(() => {
      expect(s.textarea()).toHaveValue('Bonjour cher : ami monde');
    });
    expect(s.textarea()).not.toHaveAttribute('readonly');
    expect(s.textarea().selectionStart).toBe('Bonjour cher : ami'.length);
    expect(s.onSend).not.toHaveBeenCalled();
    // Le texte reste modifiable et s'envoie comme d'habitude.
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeEnabled();
  });

  it('Échap annule et retire le texte dicté', async () => {
    const s = setup({ initial: 'Début' });
    await startDictation(s);
    listening(s.api);
    segment(s.api, 0, 'texte à retirer');
    expect(s.textarea()).toHaveValue('Début texte à retirer');

    await userEvent.keyboard('{Escape}');
    expect(s.textarea()).toHaveValue('Début');
    expect(s.api.callsTo('voice:cancel')).toEqual([{ voiceSessionId: 'v1' }]);
    expect(s.api.callsTo('voice:stop')).toEqual([]);
    expect(s.capture.stopped).toBe(1);
    expect(screen.getByTestId('voice-announcer')).toHaveTextContent('Dictée annulée');
  });

  it('⌘⇧D démarre puis termine la dictée', async () => {
    const s = setup({ handlers: { 'voice:stop': () => ({ text: 'Bonjour.' }) } });
    await userEvent.keyboard('{Meta>}{Shift>}D{/Shift}{/Meta}');
    await waitFor(() => {
      expect(s.capture.opened).toBe(1);
    });
    listening(s.api);
    await userEvent.keyboard('{Meta>}{Shift>}D{/Shift}{/Meta}');
    await waitFor(() => {
      expect(s.textarea()).toHaveValue('Bonjour.');
    });
  });

  it('reste disponible pendant un tour de l’agent', async () => {
    const s = setup({ running: true, handlers: { 'voice:stop': () => ({ text: 'Suite.' }) } });
    expect(s.micButton()).toBeEnabled();
    await startDictation(s);
    await userEvent.click(s.micButton());
    await waitFor(() => {
      expect(s.textarea()).toHaveValue('Suite.');
    });
  });

  it('garde le texte reçu quand le main arrête la dictée au bout de 5 min', async () => {
    const s = setup();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await startDictation(s);
    listening(s.api);
    segment(s.api, 0, 'Longue dictée.');
    spy.mockReturnValue(now + MAX_DICTATION_MS);
    s.api.emit('voice:state', { voiceSessionId: 'v1', state: 'idle' });
    spy.mockRestore();
    expect(s.textarea()).toHaveValue('Longue dictée.');
    expect(s.micButton()).toHaveAccessibleName('Dicter (⌘⇧D)');
    expect(screen.getByTestId('voice-announcer')).toHaveTextContent('au bout de 5 minutes');
    expect(s.api.callsTo('voice:stop')).toEqual([]);
  });

  it('active la voix au premier usage', async () => {
    const s = setup({ settings: { ...DEFAULT_VOICE_SETTINGS } });
    await startDictation(s);
    expect(s.enable).toHaveBeenCalledTimes(1);
  });

  it('signale un micro muet (alerte silent_input)', async () => {
    const s = setup();
    await startDictation(s);
    s.api.emit('voice:state', {
      voiceSessionId: 'v1',
      state: 'listening',
      warning: 'silent_input',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Aucun son ne parvient du micro');
  });
});

describe('Premier usage et erreurs', () => {
  it('affiche la carte de téléchargement du modèle, avec progression', async () => {
    let status = voiceStatus('granted', { state: 'absent' });
    const s = setup({
      settings: { ...DEFAULT_VOICE_SETTINGS },
      handlers: {
        'voice:status': () => status,
        'voice:install-model': () =>
          new Promise<undefined>(() => {
            // Le téléchargement se termine par les événements `voice:model`.
          }),
        'voice:cancel-install': () => undefined,
      },
    });
    await userEvent.click(s.micButton());
    const card = await screen.findByRole('region', { name: 'Modèle de reconnaissance vocale' });
    expect(card).toHaveTextContent(
      'La dictée a besoin du modèle de reconnaissance (environ 490 Mo, téléchargé une fois, traité sur ce Mac).',
    );
    expect(s.api.callsTo('voice:start')).toEqual([]);

    await userEvent.click(within(card).getByRole('button', { name: 'Télécharger' }));
    expect(s.enable).toHaveBeenCalledTimes(1);
    expect(s.api.callsTo('voice:install-model')).toEqual([{ id: sttModel().id }]);

    s.api.emit(
      'voice:model',
      sttModel({
        state: 'downloading',
        progress: { receivedBytes: 243_500_000, totalBytes: 487_000_000 },
      }),
    );
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    await userEvent.click(within(card).getByRole('button', { name: 'Annuler le téléchargement' }));
    expect(s.api.callsTo('voice:cancel-install')).toEqual([{ id: sttModel().id }]);

    status = voiceStatus('granted');
    s.api.emit('voice:model', sttModel({ state: 'installed' }));
    expect(card).toHaveTextContent('Modèle installé. Cliquez sur le micro pour dicter.');
  });

  it('micro refusé : alerte avec le lien vers Réglages Système › Micro', async () => {
    const s = setup({
      handlers: {
        'voice:status': () => voiceStatus('denied'),
        'voice:open-mic-settings': () => undefined,
      },
    });
    await userEvent.click(s.micButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Micro refusé');
    expect(alert).toHaveTextContent('Confidentialité et sécurité › Micro');
    await userEvent.click(within(alert).getByRole('button', { name: /Réglages Système/ }));
    expect(s.api.callsTo('voice:open-mic-settings')).toHaveLength(1);
    expect(s.api.callsTo('voice:start')).toEqual([]);
  });

  it('demande l’autorisation macOS au premier clic', async () => {
    const s = setup({
      handlers: {
        'voice:status': () => voiceStatus('not-determined'),
        'voice:request-mic': () => 'denied',
      },
    });
    await userEvent.click(s.micButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Micro refusé');
    expect(s.api.callsTo('voice:request-mic')).toHaveLength(1);

    s.api.handlers['voice:request-mic'] = () => 'granted';
    await startDictation(s);
  });

  it('aucun micro : message en français et session abandonnée', async () => {
    const s = setup();
    s.capture.failWith = new MicCaptureError('no_device', 'Aucun micro disponible.');
    await userEvent.click(s.micButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Aucun micro n’est disponible');
    expect(s.api.callsTo('voice:cancel')).toEqual([{ voiceSessionId: 'v1' }]);
    expect(s.micButton()).toHaveAccessibleName('Dicter (⌘⇧D)');
  });

  it('modèle corrompu au démarrage : la carte du modèle revient', async () => {
    const s = setup({
      handlers: {
        'voice:start': () => {
          throw new FakeIpcFailure({
            code: 'voice/model_invalid',
            message: 'empreinte',
            retryable: false,
          });
        },
      },
    });
    await userEvent.click(s.micButton());
    expect(
      await screen.findByRole('region', { name: 'Modèle de reconnaissance vocale' }),
    ).toBeInTheDocument();
  });

  it('moteur arrêté : message en français', async () => {
    const s = setup({
      handlers: {
        'voice:start': () => {
          throw new FakeIpcFailure({
            code: 'voice/engine_failed',
            message: 'crash',
            retryable: true,
          });
        },
      },
    });
    await userEvent.click(s.micButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La reconnaissance vocale s’est arrêtée. Réessayez.',
    );
  });

  it('n’affiche pas le micro quand la voix est désactivée', () => {
    installFakeApi();
    render(
      <Composer
        value=""
        onChange={() => undefined}
        attachments={[]}
        onRemoveAttachment={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        running={false}
        disabled={false}
        importing={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /dict/i })).toBeNull();
  });
});
