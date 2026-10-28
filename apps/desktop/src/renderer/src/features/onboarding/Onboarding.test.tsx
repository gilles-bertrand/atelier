// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ConnectionTestResult } from '@atelier/shared';
import { App } from '@renderer/App';
import { FakeIpcFailure, installFakeApi } from '@renderer/test/fake-api';
import { chatModels, initialModel } from './ModelStep';
import { sandboxPhase } from './SandboxStep';
import { validateServerUrl } from './ServerStep';

const connected: ConnectionTestResult = {
  ok: true,
  latencyMs: 84,
  serverVersion: '0.40.11',
  models: [
    { name: 'qwen3.5:35b', sizeBytes: 24e9 },
    { name: 'qwen3.5:9b', sizeBytes: 6e9 },
  ],
  contextWindow: 65_536,
};

describe('onboarding', () => {
  it('va du serveur à la préparation de la VM et termine la configuration', async () => {
    const user = userEvent.setup();
    let resolveVm: () => void = () => undefined;
    const api = installFakeApi({
      'llm:test-connection': () => connected,
      'sandbox:ensure-ready': () =>
        new Promise<undefined>((resolve) => {
          resolveVm = () => {
            resolve(undefined);
          };
        }),
    });
    render(<App />);

    // 1. Serveur
    const url = await screen.findByLabelText('Adresse du serveur');
    expect(screen.getByRole('heading', { name: 'Connexion au serveur' })).toHaveFocus();
    await user.type(url, 'https://llm.exemple.fr');
    await user.type(screen.getByLabelText('Jeton d’accès (token)'), 'secret-token');
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    const success = await screen.findByText('Connexion réussie');
    expect(within(success.parentElement as HTMLElement).getByText(/84 ms/)).toBeInTheDocument();
    expect(api.callsTo('llm:test-connection')[0]).toEqual({
      baseUrl: 'https://llm.exemple.fr',
      token: 'secret-token',
    });
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    expect(api.callsTo('secrets:set')).toEqual([{ id: 'llm_token', value: 'secret-token' }]);

    // 2. Modèle
    await screen.findByRole('heading', { name: 'Choix du modèle' });
    expect(screen.getByRole('radio', { name: /qwen3\.5:35b/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /qwen3\.5:9b/ }));
    await user.click(screen.getByLabelText('Réflexion approfondie'));
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    expect(api.callsTo('settings:update')).toContainEqual({
      llm: { model: 'qwen3.5:9b', thinking: false },
    });

    // 3. Confidentialité
    await screen.findByRole('heading', { name: 'Où vont vos données' });
    expect(screen.getAllByText(/llm\.exemple\.fr/).length).toBeGreaterThan(0);
    const next = screen.getByRole('button', { name: 'Continuer' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(next);

    // 4. VM
    await screen.findByRole('heading', { name: 'Environnement d’exécution' });
    await user.click(screen.getByRole('button', { name: 'Préparer l’environnement' }));
    api.emit('sandbox:progress', {
      phase: 'downloading_image',
      progress: 0.4,
      message: 'Téléchargement de l’image Ubuntu…',
    });
    expect(await screen.findByText('Téléchargement de l’image Ubuntu…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    api.emit('sandbox:status', { state: 'ready', networkEnabled: false });
    resolveVm();
    await screen.findByText('L’environnement est prêt.');
    await user.click(screen.getByRole('button', { name: 'Commencer' }));

    expect(api.callsTo('settings:update')).toContainEqual({ onboardingCompleted: true });
    expect(await screen.findByText('Sur quoi travaille-t-on ?')).toBeInTheDocument();
  });

  it('valide l’URL localement et traduit un token refusé', async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      'llm:test-connection': () => ({ ok: false, models: [], errorCode: 'llm/unauthorized' }),
    });
    render(<App />);
    const url = await screen.findByLabelText('Adresse du serveur');
    await user.type(url, 'http://llm.exemple.fr');
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/http:\/\/ n’est accepté que pour localhost/)).toBeInTheDocument();
    expect(api.callsTo('llm:test-connection')).toEqual([]);

    await user.clear(url);
    await user.type(url, 'https://llm.exemple.fr');
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/refuse le jeton/);
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeDisabled();
  });

  it('propose de continuer sans VM si la préparation échoue', async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ 'llm:test-connection': () => connected });
    api.handlers['sandbox:ensure-ready'] = () => {
      throw new FakeIpcFailure({
        code: 'sandbox/disk_full',
        message: 'disk',
        retryable: false,
      });
    };
    render(<App />);
    await user.type(await screen.findByLabelText('Adresse du serveur'), 'https://x.fr');
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    await screen.findByText('Connexion réussie');
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continuer' }));
    await user.click(await screen.findByRole('button', { name: 'Préparer l’environnement' }));
    expect(await screen.findByText(/Espace disque insuffisant/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Terminer sans l’environnement' }));
    await waitFor(() => {
      expect(api.callsTo('settings:update')).toContainEqual({ onboardingCompleted: true });
    });
  });
});

describe('fonctions de l’onboarding', () => {
  it('validateServerUrl', () => {
    expect(validateServerUrl('')).toMatch(/Indiquez/);
    expect(validateServerUrl('pas une url')).toMatch(/invalide/);
    expect(validateServerUrl('http://localhost:11434')).toBeUndefined();
    expect(validateServerUrl('http://100.100.1.1:11434')).toBeUndefined();
    expect(validateServerUrl('http://llm.fr')).toMatch(/https/);
  });

  it('initialModel préfère les Réglages, puis le défaut', () => {
    const models = [{ name: 'a' }, { name: 'qwen3.5:35b' }];
    expect(initialModel(models, 'a')).toBe('a');
    expect(initialModel(models, 'absent')).toBe('qwen3.5:35b');
    expect(initialModel([{ name: 'b' }], 'absent')).toBe('b');
    expect(initialModel([], 'x')).toBeUndefined();
  });

  it('chatModels met le recommandé en tête et écarte les embeddings', () => {
    const sorted = chatModels([
      { name: 'llama3.1:8b' },
      { name: 'mxbai-embed-large:latest' },
      { name: 'qwen3.5:9b' },
      { name: 'qwen3.5:35b' },
      { name: 'gemma4:12b' },
    ]).map((m) => m.name);
    expect(sorted).toEqual(['qwen3.5:35b', 'qwen3.5:9b', 'gemma4:12b', 'llama3.1:8b']);
  });

  it('sandboxPhase', () => {
    expect(sandboxPhase({ state: 'ready', networkEnabled: false }, false)).toBe('ready');
    expect(sandboxPhase({ state: 'provisioning', networkEnabled: false }, false)).toBe('preparing');
    expect(sandboxPhase({ state: 'absent', networkEnabled: false }, true)).toBe('preparing');
    expect(sandboxPhase({ state: 'stopped', networkEnabled: false }, false)).toBe('idle');
  });
});
