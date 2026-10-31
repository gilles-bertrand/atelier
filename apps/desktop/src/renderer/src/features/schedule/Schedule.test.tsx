// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  ScheduleDashboard,
  ScheduledRun,
  ScheduledTask,
  SessionSummary,
} from '@atelier/shared';
import { App } from '@renderer/App';
import {
  defaultTestSettings,
  FakeIpcFailure,
  installFakeApi,
  type FakeApi,
} from '@renderer/test/fake-api';

const task: ScheduledTask = {
  id: 't1',
  name: 'Rapport hebdo',
  prompt: 'Fais le rapport',
  workspace: '/Users/test/Ventes',
  schedule: { kind: 'weekly', days: [1], time: '08:00' },
  permissions: { fileWrite: false, commands: false, webDomains: [], mcpTools: ['mcp__jira__add'] },
  maxDurationMinutes: 20,
  enabled: true,
  nextRunAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  lastRun: { id: 'r1', status: 'success', scheduledFor: '2026-10-31T07:00:00.000Z' },
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const run: ScheduledRun = {
  id: 'r1',
  taskId: 't1',
  taskName: 'Rapport hebdo',
  sessionId: 'run-s1',
  trigger: 'schedule',
  status: 'success',
  scheduledFor: new Date(2026, 9, 31, 8, 0).toISOString(),
  durationMs: 125_000,
  totalTokens: 12_400,
  summary: 'Rapport prêt : rapport.xlsx',
  files: ['rapport.xlsx'],
  denied: [
    { toolName: 'write_file', kind: 'file_write', scopeKey: 'write_file', title: 'Écrire a.md' },
  ],
};

const dashboard = (overrides: Partial<ScheduleDashboard> = {}): ScheduleDashboard => ({
  period: '7d',
  activeTasks: 1,
  nextRunAt: task.nextRunAt,
  runs: 4,
  successRate: 0.75,
  avgDurationMs: 125_000,
  totalTokens: 48_000,
  deniedActions: 1,
  skippedRuns: 1,
  daily: [{ day: '2026-10-30', success: 2, error: 1, skipped: 1 }],
  tasks: [{ ...task, periodRuns: 4, periodSuccessRate: 0.75 }],
  ...overrides,
});

const runSession: SessionSummary = {
  id: 'run-s1',
  title: 'Rapport hebdo · 31/10 08:00',
  workspace: '/Users/test/Ventes',
  createdAt: '2026-10-31T07:00:00.000Z',
  updatedAt: '2026-10-31T07:02:00.000Z',
  scheduledTaskId: 't1',
};

function setup(board: ScheduleDashboard = dashboard()): FakeApi {
  const current = board;
  return installFakeApi({
    'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
    'schedule:dashboard': ({ period }) => ({ ...current, period }),
    'schedule:runs': () => (current.tasks.length > 0 ? [run] : []),
    'schedule:list': () => current.tasks,
    'schedule:save': ({ task: input }) => ({ ...task, ...input, id: 't2' }),
    'schedule:run-now': () => ({ ...run, id: 'r2', status: 'queued' }),
    'schedule:set-enabled': ({ enabled }) => ({ ...task, enabled }),
    'schedule:delete': () => undefined,
    'schedule:stop-run': () => undefined,
    'session:open': () => ({ session: runSession, messages: [] }),
    'llm:list-models': () => [{ name: 'qwen3.5:35b' }, { name: 'qwen3.5:9b' }],
    'dialog:choose-directory': () => '/Users/test/Rapports',
  });
}

async function openDashboard(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Tâches planifiées' }));
  await screen.findByRole('heading', { name: 'Tâches planifiées' });
  return user;
}

describe('tableau de bord des tâches planifiées', () => {
  it('tuiles, barres par statut, tableau des tâches et derniers runs', async () => {
    const api = setup();
    await openDashboard();
    const tiles = await screen.findByText('Tâches actives');
    const kpis = tiles.closest('dl') as HTMLElement;
    expect(within(kpis).getByText('Prochaine : dans 12 min')).toBeInTheDocument();
    expect(within(kpis).getByText('75 % de réussite')).toBeInTheDocument();
    expect(within(kpis).getByText('2 min 05 s')).toBeInTheDocument();
    expect(within(kpis).getByText('48 k tokens')).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: /Exécutions par jour/ })).toBeInTheDocument();
    expect(screen.getByText(/30 oct\. : 2 réussies, 1 en échec, 1 sautée/)).toBeInTheDocument();

    const tasks = screen.getByRole('region', { name: 'Tâches' });
    const row = within(tasks).getByRole('row', { name: /Rapport hebdo/ });
    expect(row).toHaveTextContent('Chaque lundi à 08:00');
    expect(row).toHaveTextContent('Ventes');
    expect(row).toHaveTextContent('75 % (4)');

    const runs = screen.getByRole('region', { name: 'Dernières exécutions' });
    expect(within(runs).getByText('Rapport prêt : rapport.xlsx')).toBeInTheDocument();
    expect(within(runs).getByText('12,4 k')).toBeInTheDocument();
    expect(api.callsTo('schedule:dashboard')).toEqual([{ period: '7d' }]);
  });

  it('période, exécuter maintenant, activer, supprimer après confirmation', async () => {
    const api = setup();
    const user = await openDashboard();
    await user.click(await screen.findByRole('button', { name: '30 jours' }));
    await waitFor(() => {
      expect(api.callsTo('schedule:dashboard').at(-1)).toEqual({ period: '30d' });
    });
    await user.click(screen.getByRole('button', { name: 'Exécuter « Rapport hebdo » maintenant' }));
    expect(api.callsTo('schedule:run-now')).toEqual([{ id: 't1' }]);
    await user.click(screen.getByRole('switch', { name: 'Activer « Rapport hebdo »' }));
    expect(api.callsTo('schedule:set-enabled')).toEqual([{ id: 't1', enabled: false }]);
    await user.click(screen.getByRole('button', { name: 'Supprimer « Rapport hebdo »' }));
    expect(api.callsTo('schedule:delete')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Supprimer la tâche' }));
    expect(api.callsTo('schedule:delete')).toEqual([{ id: 't1' }]);
  });

  it('état vide', async () => {
    setup(dashboard({ tasks: [], activeTasks: 0, runs: 0, daily: [] }));
    await openDashboard();
    expect(await screen.findByText('Aucune tâche planifiée')).toBeInTheDocument();
    expect(screen.getByText('Aucune exécution pour l’instant.')).toBeInTheDocument();
  });

  it('se relit sur `schedule:changed` (run en cours visible)', async () => {
    const api = setup();
    await openDashboard();
    await screen.findByText('Tâches actives');
    const before = api.callsTo('schedule:dashboard').length;
    act(() => {
      api.emit('schedule:changed', { taskId: 't1', run: { ...run, status: 'running' } });
    });
    await waitFor(() => {
      expect(api.callsTo('schedule:dashboard').length).toBe(before + 1);
    });
  });

  it('un clic sur un run ouvre sa conversation, avec le bandeau et « Autoriser pour cette tâche »', async () => {
    setup();
    const user = await openDashboard();
    const runs = await screen.findByRole('region', { name: 'Dernières exécutions' });
    await user.click(within(runs).getByRole('button', { name: /31\/10 à 08:00/ }));
    const banner = await screen.findByRole('note', { name: 'Exécution planifiée' });
    expect(banner).toHaveTextContent('Exécution planifiée de « Rapport hebdo » du 31/10 à 08:00');
    expect(banner).toHaveTextContent('1 action refusée');
    await user.click(within(banner).getByRole('button', { name: 'Autoriser pour cette tâche' }));
    // Formulaire de la tâche, case des fichiers pré-cochée.
    await screen.findByRole('heading', { name: 'Modifier « Rapport hebdo »' });
    expect(
      screen.getByRole('checkbox', { name: 'Créer et modifier des fichiers dans le dossier' }),
    ).toBeChecked();
    expect(screen.getByText(/Les cases correspondant aux actions refusées/)).toBeInTheDocument();
  });
});

describe('formulaire : connecteurs en écriture', () => {
  it('cases par serveur pour les outils en écriture ; outil enregistré indisponible signalé', async () => {
    const api = setup();
    api.handlers['mcp:status'] = () => ({
      servers: [
        {
          name: 'github',
          transport: 'stdio',
          state: 'connected',
          toolCount: 2,
          reconnectAttempts: 0,
          tools: [
            { name: 'mcp__github__create_issue', title: 'Créer un ticket', readOnly: false },
            { name: 'mcp__github__list_issues', readOnly: true },
          ],
        },
      ],
      issues: [],
    });
    const user = await openDashboard();
    // Tâche existante qui autorisait un outil d'un connecteur retiré depuis.
    await user.click(await screen.findByRole('button', { name: 'Modifier « Rapport hebdo »' }));
    const group = await screen.findByRole('group', { name: 'Connecteurs en écriture' });
    expect(within(group).queryByText(/list_issues/)).not.toBeInTheDocument();
    await user.click(within(group).getByRole('checkbox', { name: 'Créer un ticket' }));
    expect(within(group).getByRole('checkbox', { name: 'mcp__jira__add' })).toBeChecked();
    expect(
      within(group).getByText('connecteur absent de Réglages › Connecteurs'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(api.callsTo('schedule:save')[0]?.task.permissions.mcpTools).toEqual([
      'mcp__jira__add',
      'mcp__github__create_issue',
    ]);
  });
});

describe('notification de fin de run', () => {
  it('`app:open-session` ouvre la conversation du run, même hors des « Récentes »', async () => {
    const api = setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Tâches planifiées' });
    act(() => {
      api.emit('app:open-session', { sessionId: 'run-s1' });
    });
    expect(await screen.findByRole('note', { name: 'Exécution planifiée' })).toBeInTheDocument();
    expect(api.callsTo('session:open')).toContainEqual({ sessionId: 'run-s1' });
  });
});

describe('formulaire de tâche', () => {
  it('aperçu des prochaines exécutions, validation, cases, enregistrement', async () => {
    const api = setup();
    const user = await openDashboard();
    await user.click(await screen.findByRole('button', { name: 'Nouvelle tâche' }));
    await screen.findByRole('heading', { name: 'Nouvelle tâche' });

    await user.type(screen.getByLabelText('Nom'), 'Synthèse');
    await user.click(screen.getByRole('button', { name: 'Choisir…' }));
    expect(await screen.findByText('/Users/test/Rapports')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Demande'), 'Résume les nouveautés.');

    // Chaque jour à 08:00 par défaut : trois exécutions annoncées.
    expect(
      within(screen.getByRole('list', { name: 'Prochaines exécutions' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    // Intervalle sous le plancher : message de validation, enregistrement impossible.
    await user.selectOptions(screen.getByLabelText('Fréquence'), 'interval');
    await user.clear(screen.getByLabelText('Toutes les'));
    await user.type(screen.getByLabelText('Toutes les'), '5');
    expect(screen.getByText(/15 minutes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Toutes les'));
    await user.type(screen.getByLabelText('Toutes les'), '30');

    // Permissions : fichiers cochés par défaut, commandes non ; sites nommés.
    expect(
      screen.getByRole('checkbox', { name: 'Créer et modifier des fichiers dans le dossier' }),
    ).toBeChecked();
    await user.click(
      screen.getByRole('checkbox', { name: 'Exécuter des commandes dans la machine isolée' }),
    );
    await user.click(screen.getByRole('radio', { name: 'Seulement ces sites' }));
    expect(screen.getByText(/sous-domaines/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Sites autorisés'), 'example.com');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(api.callsTo('schedule:save')).toEqual([
      {
        task: {
          name: 'Synthèse',
          prompt: 'Résume les nouveautés.',
          workspace: '/Users/test/Rapports',
          schedule: { kind: 'interval', every: 30, unit: 'minutes' },
          permissions: {
            fileWrite: true,
            commands: true,
            webDomains: ['example.com'],
            mcpTools: [],
          },
          maxDurationMinutes: 20,
          enabled: true,
        },
      },
    ]);
    // Première tâche : proposition d'ouvrir Atelier à la connexion.
    expect(
      await screen.findByText('Les tâches ne tournent que si Atelier est ouvert'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ouvrir à la connexion' }));
    expect(api.callsTo('settings:update')).toContainEqual({ openAtLogin: true });
  });

  it('erreur du main sous le bon champ (schedule/invalid, details.field)', async () => {
    const api = setup();
    api.handlers['schedule:save'] = () => {
      throw new FakeIpcFailure({
        code: 'schedule/invalid',
        message: 'Donnez un nom à la tâche.',
        retryable: false,
        details: { field: 'name' },
      });
    };
    const user = await openDashboard();
    await user.click(await screen.findByRole('button', { name: 'Nouvelle tâche' }));
    await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Donnez un nom à la tâche.')).toBeInTheDocument();
    expect(screen.getByLabelText('Nom')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('machine isolée occupée', () => {
  const chat: SessionSummary = {
    id: 's1',
    title: 'Récap',
    workspace: '/Users/test/Ventes',
    createdAt: '2026-10-28T09:00:00.000Z',
    updatedAt: '2026-10-28T09:30:00.000Z',
  };

  it('« Une tâche planifiée utilise la machine isolée » et « Arrêter la tâche »', async () => {
    const api = installFakeApi({
      'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
      'session:list': () => [chat],
      'session:open': () => ({ session: chat, messages: [] }),
      'agent:send': () => ({ turnId: 't1' }),
      'schedule:stop-run': () => undefined,
      'sandbox:status': () => ({
        state: 'ready',
        networkEnabled: false,
        heldBy: { workspace: '/Users/test/Rapports', runId: 'r9', taskName: 'Rapport hebdo' },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
    await user.click(within(recent).getByText('Récap'));
    await user.type(await screen.findByRole('textbox', { name: 'Votre message' }), 'Salut{Enter}');
    expect(
      await screen.findByText(/Une tâche planifiée utilise la machine isolée/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Arrêter la tâche' }));
    expect(api.callsTo('schedule:stop-run')).toEqual([{ runId: 'r9' }]);
    // Dès que le modèle répond, le message disparaît.
    act(() => {
      api.emit('agent:event', {
        type: 'text_delta',
        sessionId: 's1',
        turnId: 't1',
        delta: 'Bonjour',
      });
    });
    expect(screen.queryByText(/utilise la machine isolée/)).not.toBeInTheDocument();
  });

  it('une autre conversation : message sans bouton ; même dossier : rien', async () => {
    installFakeApi({
      'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
      'session:list': () => [chat],
      'session:open': () => ({ session: chat, messages: [] }),
      'agent:send': () => ({ turnId: 't1' }),
      'sandbox:status': () => ({
        state: 'ready',
        networkEnabled: false,
        heldBy: { workspace: '/Users/test/Autre', sessionId: 's9' },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
    await user.click(within(recent).getByText('Récap'));
    await user.type(await screen.findByRole('textbox', { name: 'Votre message' }), 'Salut{Enter}');
    expect(
      await screen.findByText(/Une autre conversation utilise la machine isolée/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Arrêter la tâche' })).not.toBeInTheDocument();
  });
});

describe('Réglages › Tâches planifiées', () => {
  it('« Ouvrir Atelier à la connexion »', async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Réglages' }));
    const sections = screen.getByRole('navigation', { name: 'Rubriques des réglages' });
    await user.click(within(sections).getByRole('button', { name: 'Tâches planifiées' }));
    const toggle = screen.getByRole('switch', { name: 'Ouvrir Atelier à la connexion' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(api.callsTo('settings:update')).toContainEqual({ openAtLogin: true });
  });
});
