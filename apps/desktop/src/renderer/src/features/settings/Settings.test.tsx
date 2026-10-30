// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '@renderer/App';
import { defaultTestSettings, installFakeApi, type FakeApi } from '@renderer/test/fake-api';
import { jsonError } from './ExtensionsSettings';

function setup(defaultModel = 'qwen3.5:35b'): FakeApi {
  return installFakeApi({
    'settings:get': () =>
      defaultTestSettings({
        onboardingCompleted: true,
        llm: {
          baseUrl: 'https://llm.exemple.fr',
          model: defaultModel,
          thinking: true,
          visionModel: 'qwen3-vl:8b',
          numCtx: 65536,
        },
      }),
    'secrets:presence': () => ({
      llm_token: true,
      ollama_search_key: false,
      brave_search_key: false,
    }),
    'llm:list-models': () => [
      { name: 'qwen3.5:35b' },
      { name: 'qwen3.5:9b' },
      { name: 'qwen3-vl:8b' },
      { name: 'atelier:latest' },
      { name: 'llama-texte', capabilities: ['completion'] },
      { name: 'nomic-embed-text' },
    ],
    'llm:test-connection': () => ({ ok: true, latencyMs: 40, models: [{ name: 'm' }] }),
    'sandbox:status': () => ({ state: 'ready', networkEnabled: false }),
    'sandbox:reset': () => undefined,
    'sandbox:diagnostics': () => ({
      limaHome: '/Users/test/Library/Application Support/Atelier/lima',
      resources: { cpus: 4, memoryGiB: 4 },
      limaVersion: '2.2.1',
    }),
    'skills:list': () => [
      { name: 'xlsx', description: 'Créer des classeurs Excel', path: '/s/xlsx/SKILL.md' },
    ],
    'dialog:choose-directory': () => '/Users/test/MesSkills',
    'mcp:read-config': () => '{\n  "mcpServers": {}\n}\n',
    'mcp:status': () => ({
      servers: [
        {
          name: 'notes',
          transport: 'stdio',
          state: 'failed',
          toolCount: 0,
          error: 'spawn npx ENOENT',
          reconnectAttempts: 5,
        },
      ],
      issues: [{ server: 'ancien', message: '« type: sse » n’est pas pris en charge.' }],
    }),
    'mcp:write-config': () => undefined,
  });
}

async function openSettings(section?: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Réglages' }));
  await waitFor(() => {
    expect(screen.getByRole('heading', { level: 1, name: 'Réglages' })).toHaveFocus();
  });
  if (section) await user.click(screen.getByRole('button', { name: section }));
  return user;
}

describe('réglages : serveur et modèle', () => {
  it('teste puis enregistre un nouveau jeton', async () => {
    const api = setup();
    const user = await openSettings();
    const token = screen.getByLabelText('Jeton d’accès (token)');
    expect(token).toHaveAttribute('placeholder', 'Jeton enregistré');
    await user.type(token, 'nouveau');
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByText('Connexion réussie')).toBeInTheDocument();
    expect(api.callsTo('llm:test-connection')).toEqual([
      { baseUrl: 'https://llm.exemple.fr', token: 'nouveau' },
    ]);
    await user.click(screen.getAllByRole('button', { name: 'Enregistrer' })[0] as HTMLElement);
    expect(api.callsTo('secrets:set')).toEqual([{ id: 'llm_token', value: 'nouveau' }]);
    expect(await screen.findByText('Connexion enregistrée.')).toBeInTheDocument();
  });

  it('prévient qu’un nouveau serveur demande son propre jeton', async () => {
    setup();
    const user = await openSettings();
    const url = screen.getByLabelText('Adresse du serveur');
    await user.clear(url);
    await user.type(url, 'https://autre.exemple.fr');
    expect(screen.getByText(/Nouveau serveur : ressaisissez son jeton/)).toBeInTheDocument();
  });

  it('change de modèle, revient à la vision et au contexte automatiques', async () => {
    const api = setup();
    const user = await openSettings();
    const model = screen.getByLabelText('Modèle par défaut des nouvelles conversations');
    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: 'qwen3.5:9b' }).length).toBeGreaterThan(0);
    });
    // Sans outils : grisé, avec la raison.
    expect(
      within(model).getByRole('option', {
        name: 'llama-texte (ne sait pas utiliser les outils : lecture de fichiers, commandes)',
      }),
    ).toBeDisabled();
    // Les modèles d'embedding ne sont pas proposés.
    expect(screen.queryByRole('option', { name: 'nomic-embed-text' })).not.toBeInTheDocument();
    await user.selectOptions(model, 'qwen3.5:9b');
    await user.selectOptions(screen.getByLabelText('Modèle pour les images'), '');
    await user.clear(screen.getByLabelText('Fenêtre de contexte (tokens)'));
    await user.click(screen.getAllByRole('button', { name: 'Enregistrer' })[1] as HTMLElement);
    expect(api.callsTo('settings:update')).toContainEqual({
      llm: { model: 'qwen3.5:9b', visionModel: '', numCtx: 0 },
    });
  });

  it('« atelier » enregistré : l’entrée « atelier:latest » du serveur est sélectionnée, sans doublon', async () => {
    setup('atelier');
    await openSettings();
    const model = screen.getByLabelText('Modèle par défaut des nouvelles conversations');
    await waitFor(() => {
      expect(model).toHaveValue('atelier:latest');
    });
    expect(within(model).queryByRole('option', { name: 'atelier' })).not.toBeInTheDocument();
  });

  it('refuse un contexte trop petit', async () => {
    setup();
    const user = await openSettings();
    const ctx = screen.getByLabelText('Fenêtre de contexte (tokens)');
    await user.clear(ctx);
    await user.type(ctx, '512');
    expect(screen.getByText('Indiquez au moins 2048, ou laissez vide.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Enregistrer' })[1]).toBeDisabled();
  });
});

describe('réglages : machine isolée', () => {
  it('enregistre les ressources et réinitialise après confirmation', async () => {
    const api = setup();
    const user = await openSettings('Machine isolée');
    const cpus = screen.getByLabelText('Processeurs');
    await user.clear(cpus);
    await user.type(cpus, '6');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(api.callsTo('settings:update')).toContainEqual({
      sandbox: { cpus: 6, memoryGiB: 4 },
    });
    await user.click(screen.getByRole('button', { name: 'Réinitialiser…' }));
    expect(api.callsTo('sandbox:reset')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Confirmer la réinitialisation' }));
    expect(api.callsTo('sandbox:reset')).toHaveLength(1);
    expect(await screen.findByText('Machine réinitialisée.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Afficher le diagnostic' }));
    expect(await screen.findByText(/"limaVersion": "2.2.1"/)).toBeInTheDocument();
  });
});

describe('réglages : recherche, skills, connecteurs', () => {
  it('choisit Brave et enregistre sa clé', async () => {
    const api = setup();
    const user = await openSettings('Recherche web');
    await user.click(screen.getByRole('radio', { name: /Brave Search/ }));
    expect(api.callsTo('settings:update')).toContainEqual({ search: { provider: 'brave' } });
    expect(await screen.findByText(/a besoin d’une clé/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Clé Brave Search'), 'BSA-123');
    await user.click(screen.getAllByRole('button', { name: 'Enregistrer' })[0] as HTMLElement);
    expect(api.callsTo('secrets:set')).toEqual([{ id: 'brave_search_key', value: 'BSA-123' }]);
  });

  it('liste les skills et change de dossier', async () => {
    const api = setup();
    const user = await openSettings('Skills');
    expect(await screen.findByText('Créer des classeurs Excel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Changer…' }));
    expect(api.callsTo('settings:update')).toContainEqual({ skillsDir: '/Users/test/MesSkills' });
  });

  it('affiche l’état des connecteurs et valide mcp.json avant d’enregistrer', async () => {
    const api = setup();
    const user = await openSettings('Connecteurs');
    expect(await screen.findByText('notes')).toBeInTheDocument();
    expect(screen.getByText('spawn npx ENOENT')).toBeInTheDocument();
    expect(screen.getByText(/n’est pas pris en charge/)).toBeInTheDocument();
    const editor = await screen.findByLabelText('mcp.json');
    fireEvent.change(editor, { target: { value: '{ "mcpServers": ' } });
    expect(screen.getByText(/JSON invalide/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Enregistrer' });
    expect(save).toBeDisabled();
    const valid = '{ "mcpServers": { "fs": { "command": "npx", "args": [] } } }';
    fireEvent.change(editor, { target: { value: valid } });
    await user.click(save);
    expect(api.callsTo('mcp:write-config')).toEqual([{ json: valid }]);
    api.emit('mcp:status', {
      servers: [
        { name: 'fs', transport: 'stdio', state: 'connected', toolCount: 4, reconnectAttempts: 0 },
      ],
      issues: [],
    });
    expect(screen.getByText(/connecté · 4 outil\(s\)/)).toBeInTheDocument();
  });

  it('jsonError', () => {
    expect(jsonError('')).toBeUndefined();
    expect(jsonError('[]')).toMatch(/objet JSON/);
    expect(jsonError('{"mcpServers":{}}')).toBeUndefined();
  });
});
