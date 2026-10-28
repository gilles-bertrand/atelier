// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage, SessionSummary } from '@atelier/shared';
import { App } from '@renderer/App';
import { errorMessage } from '@renderer/lib/error-messages';
import { defaultTestSettings, installFakeApi, type FakeApi } from '@renderer/test/fake-api';
import { changedFiles } from './SidePanel';

const session: SessionSummary = {
  id: 's1',
  title: 'Récap',
  workspace: '/Users/test/Ventes',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:30:00.000Z',
};

function setup(sandboxWorkspace = session.workspace): FakeApi {
  return installFakeApi({
    'settings:get': () =>
      defaultTestSettings({
        onboardingCompleted: true,
        llm: { baseUrl: 'https://llm.exemple.fr', model: 'qwen3.5:35b', thinking: true },
      }),
    'session:list': () => [session],
    'session:open': () => ({ session, messages: [] }),
    'agent:send': () => ({ turnId: 't1' }),
    'sandbox:status': () => ({
      state: 'ready',
      workspace: sandboxWorkspace,
      networkEnabled: false,
    }),
    'sandbox:set-network': () => undefined,
  });
}

async function open(api: FakeApi) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByText('Récap'));
  await screen.findByRole('complementary', { name: 'Suivi de la conversation' });
  const emit = (event: Partial<AgentEvent> & { type: AgentEvent['type'] }): void => {
    api.emit('agent:event', { sessionId: 's1', turnId: 't1', ...event } as AgentEvent);
  };
  return { user, emit };
}

describe('panneau latéral', () => {
  it('affiche les tâches et les fichiers du tour en direct', async () => {
    const api = setup();
    const { emit } = await open(api);
    const panel = screen.getByRole('complementary', { name: 'Suivi de la conversation' });
    expect(within(panel).getByText(/l’assistant affiche ici son plan/)).toBeInTheDocument();

    emit({
      type: 'todo_update',
      todos: [
        { id: '1', title: 'Lire les CSV', status: 'completed' },
        { id: '2', title: 'Créer recap.xlsx', status: 'in_progress' },
      ],
    });
    expect(within(panel).getByText('Lire les CSV')).toBeInTheDocument();
    expect(within(panel).getByText('(en cours)')).toBeInTheDocument();

    emit({ type: 'tool_start', toolCallId: 'c1', toolName: 'write_file', input: {} });
    emit({
      type: 'tool_result',
      toolCallId: 'c1',
      toolName: 'write_file',
      ok: true,
      output: 'ok',
      display: {
        type: 'file',
        file: {
          path: 'recap.xlsx',
          absolutePath: '/Users/test/Ventes/recap.xlsx',
          action: 'created',
        },
      },
    });
    expect(within(panel).getByText('recap.xlsx')).toBeInTheDocument();
    expect(within(panel).getByText(/Créé/)).toBeInTheDocument();
  });

  it('active internet pour les commandes de cette conversation', async () => {
    const api = setup();
    const { user } = await open(api);
    const toggle = screen.getByRole('switch', { name: 'Internet pour les commandes' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(api.callsTo('sandbox:set-network')).toEqual([{ sessionId: 's1', enabled: true }]);
    api.emit('sandbox:status', {
      state: 'ready',
      workspace: session.workspace,
      networkEnabled: true,
    });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Prêt')).toBeInTheDocument();
  });

  it('désactive l’interrupteur si la VM sert un autre dossier, et se masque', async () => {
    const api = setup('/Users/test/Autre');
    const { user } = await open(api);
    expect(screen.getByRole('switch', { name: 'Internet pour les commandes' })).toBeDisabled();
    expect(screen.getByText(/sera monté au prochain message/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Panneau de suivi' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});

describe('changedFiles', () => {
  const msg = (
    files: { path: string; action: 'created' | 'modified' | 'presented' }[],
  ): ChatMessage => ({
    id: Math.random().toString(),
    sessionId: 's1',
    role: 'assistant',
    createdAt: '',
    parts: files.map((f, i) => ({
      type: 'tool_call',
      toolCallId: `${f.path}-${String(i)}`,
      toolName: 'write_file',
      input: {},
      status: 'success',
      display: { type: 'file', file: { ...f, absolutePath: `/w/${f.path}` } },
    })),
  });

  it('garde le dernier état par fichier, le plus récent en tête, « Créé » prioritaire', () => {
    const files = changedFiles([
      msg([
        { path: 'a.md', action: 'created' },
        { path: 'b.md', action: 'modified' },
      ]),
      msg([{ path: 'a.md', action: 'modified' }]),
    ]);
    expect(files.map((f) => [f.path, f.action])).toEqual([
      ['a.md', 'created'],
      ['b.md', 'modified'],
    ]);
  });
});

describe('errorMessage', () => {
  it('explique un fichier non ouvrable par sécurité', () => {
    expect(errorMessage({ code: 'tool/failed', details: { kind: 'blocked_open' } })).toMatch(
      /Afficher dans le Finder/,
    );
    expect(errorMessage({ code: 'tool/failed' })).toBe('L’action a échoué.');
  });
});
