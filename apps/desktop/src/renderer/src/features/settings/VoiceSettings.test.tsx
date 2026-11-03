// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_SETTINGS, type AppSettings, type VoiceStatus } from '@atelier/shared';
import { App } from '@renderer/App';
import { MicCaptureContext } from '@renderer/features/voice/capture';
import {
  defaultTestSettings,
  installFakeApi,
  type FakeApi,
  type FakeHandlers,
} from '@renderer/test/fake-api';
import { fakeCapture, sttModel, voiceStatus, type FakeCapture } from '@renderer/test/fake-voice';

function setup({
  status = voiceStatus(),
  settings = {},
  handlers = {},
}: {
  status?: VoiceStatus;
  settings?: Partial<AppSettings>;
  handlers?: FakeHandlers;
} = {}): { api: FakeApi; capture: FakeCapture } {
  const api = installFakeApi({
    'settings:get': () =>
      defaultTestSettings({
        onboardingCompleted: true,
        llm: { baseUrl: 'https://llm.exemple.fr', model: 'qwen3.5:35b', thinking: true },
        ...settings,
      }),
    'voice:status': () => status,
    'voice:install-model': () => undefined,
    'voice:remove-model': () => undefined,
    'voice:import-model': () => undefined,
    'voice:request-mic': () => 'granted',
    'voice:open-mic-settings': () => undefined,
    'voice:start': () => ({ voiceSessionId: 'test' }),
    'voice:audio': () => undefined,
    'voice:stop': () => ({ text: 'Un, deux, trois.' }),
    'voice:cancel': () => undefined,
    ...handlers,
  });
  return { api, capture: fakeCapture() };
}

async function openVoice(capture: FakeCapture) {
  const user = userEvent.setup();
  render(
    <MicCaptureContext value={capture.start}>
      <App />
    </MicCaptureContext>,
  );
  await user.click(await screen.findByRole('button', { name: 'Réglages' }));
  await user.click(await screen.findByRole('button', { name: 'Voix' }));
  await screen.findByRole('heading', { name: 'Voix' });
  return user;
}

describe('Réglages › Voix', () => {
  it('active la dictée et explique la confidentialité', async () => {
    const { api, capture } = setup();
    const user = await openVoice(capture);
    expect(screen.getByText(/l’audio n’est ni envoyé ni conservé/)).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Activer la dictée' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(api.callsTo('settings:update')).toEqual([{ voice: { enabled: true } }]);
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
    expect(await screen.findByText('autorisé')).toBeInTheDocument();
  });

  it('micro refusé : lien vers Réglages Système', async () => {
    const { api, capture } = setup({ status: voiceStatus('denied') });
    const user = await openVoice(capture);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Micro refusé');
    await user.click(within(alert).getByRole('button', { name: /Réglages Système/ }));
    expect(api.callsTo('voice:open-mic-settings')).toHaveLength(1);
  });

  it('modèle absent : téléchargement, progression, import', async () => {
    const { api, capture } = setup({ status: voiceStatus('granted', { state: 'absent' }) });
    const user = await openVoice(capture);
    const row = await screen.findByRole('listitem', { name: /Parakeet v3/ });
    expect(row).toHaveTextContent('Non téléchargé');
    expect(row).toHaveTextContent('licence CC-BY-4.0');
    await user.click(within(row).getByRole('button', { name: 'Télécharger' }));
    expect(api.callsTo('voice:install-model')).toEqual([{ id: sttModel().id }]);

    api.emit(
      'voice:model',
      sttModel({ state: 'downloading', progress: { receivedBytes: 1, totalBytes: 4 } }),
    );
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');

    api.emit('voice:model', sttModel({ state: 'absent' }));
    await user.click(within(row).getByRole('button', { name: 'Importer une archive…' }));
    expect(api.callsTo('voice:import-model')).toEqual([{ id: sttModel().id }]);
    // Le modèle de détection de parole est embarqué : aucune action.
    const vad = screen.getByRole('listitem', { name: /Silero/ });
    expect(vad).toHaveTextContent('Intégré à l’app');
    expect(within(vad).queryByRole('button')).toBeNull();
  });

  it('supprime un modèle installé après confirmation', async () => {
    const { api, capture } = setup();
    const user = await openVoice(capture);
    const row = await screen.findByRole('listitem', { name: /Parakeet v3/ });
    expect(row).toHaveTextContent('Installé');
    await user.click(within(row).getByRole('button', { name: 'Supprimer' }));
    expect(api.callsTo('voice:remove-model')).toEqual([]);
    await user.click(within(row).getByRole('button', { name: 'Confirmer la suppression' }));
    expect(api.callsTo('voice:remove-model')).toEqual([{ id: sttModel().id }]);
    expect(await within(row).findByText('Modèle supprimé.')).toBeInTheDocument();
  });

  it('miroir : refuse http hors localhost, enregistre https, revient à l’officielle', async () => {
    const { api, capture } = setup();
    const user = await openVoice(capture);
    await user.click(screen.getByRole('radio', { name: /Miroir interne/ }));
    const url = screen.getByLabelText('Adresse du miroir');
    await user.type(url, 'http://miroir.exemple.fr');
    const section = url.closest('section') as HTMLElement;
    await user.click(within(section).getByRole('button', { name: 'Enregistrer' }));
    expect(screen.getByRole('alert')).toHaveTextContent('https://');
    expect(api.callsTo('settings:update')).toEqual([]);

    await user.clear(url);
    await user.type(url, 'https://miroir.exemple.fr/voice/');
    await user.click(within(section).getByRole('button', { name: 'Enregistrer' }));
    expect(api.callsTo('settings:update')).toEqual([
      { voice: { modelSourceUrl: 'https://miroir.exemple.fr/voice/' } },
    ]);

    await user.click(screen.getByRole('radio', { name: /Officielle/ }));
    expect(api.callsTo('settings:update').at(-1)).toEqual({ voice: { modelSourceUrl: '' } });
  });

  it('règle la libération de la mémoire', async () => {
    const { api, capture } = setup({
      settings: { voice: { ...DEFAULT_VOICE_SETTINGS, enabled: true } },
    });
    const user = await openVoice(capture);
    const minutes = screen.getByLabelText('Libérer la mémoire après (minutes)');
    expect(minutes).toHaveValue(10);
    await user.clear(minutes);
    await user.type(minutes, '0');
    const section = minutes.closest('section') as HTMLElement;
    await user.click(within(section).getByRole('button', { name: 'Enregistrer' }));
    expect(api.callsTo('settings:update')).toEqual([{ voice: { idleUnloadMinutes: 0 } }]);
  });

  it('teste le micro choisi pendant 5 s et affiche la transcription', async () => {
    const { api, capture } = setup({
      settings: { voice: { ...DEFAULT_VOICE_SETTINGS, enabled: true, inputDeviceId: 'usb-1' } },
    });
    const user = await openVoice(capture);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await user.click(screen.getByRole('button', { name: 'Tester le micro (5 s)' }));
      await waitFor(() => {
        expect(capture.opened).toBe(1);
      });
      expect(capture.options?.deviceId).toBe('usb-1');
      api.emit('voice:state', { voiceSessionId: 'test', state: 'listening' });
      expect(screen.getByText('Parlez… 5 s')).toBeInTheDocument();
      capture.frame();
      expect(api.callsTo('voice:audio')).toHaveLength(1);

      clock.mockReturnValue(now + 5_000);
      expect(
        await screen.findByTestId('mic-test-result', {}, { timeout: 2_000 }),
      ).toHaveTextContent('Transcription : « Un, deux, trois. »');
      expect(api.callsTo('voice:stop')).toEqual([{ voiceSessionId: 'test' }]);
    } finally {
      clock.mockRestore();
    }
  });

  it('test du micro sans modèle : renvoie au téléchargement', async () => {
    const { api, capture } = setup({ status: voiceStatus('granted', { state: 'absent' }) });
    const user = await openVoice(capture);
    await user.click(screen.getByRole('button', { name: 'Tester le micro (5 s)' }));
    expect(await screen.findByText(/Le test a besoin du modèle/)).toBeInTheDocument();
    expect(api.callsTo('voice:start')).toEqual([]);
  });
});
