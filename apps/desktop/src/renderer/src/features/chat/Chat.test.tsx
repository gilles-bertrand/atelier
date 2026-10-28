// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, SessionSummary } from '@atelier/shared';
import { App } from '@renderer/App';
import { defaultTestSettings, installFakeApi, type FakeApi } from '@renderer/test/fake-api';

const session: SessionSummary = {
  id: 's1',
  title: 'Récap des ventes',
  workspace: '/Users/test/Ventes',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:30:00.000Z',
};

let api: FakeApi;

function setup(): FakeApi {
  return installFakeApi({
    'settings:get': () =>
      defaultTestSettings({
        onboardingCompleted: true,
        llm: { baseUrl: 'https://llm.exemple.fr', model: 'qwen3.5:35b', thinking: true },
      }),
    'session:list': () => [session],
    'session:open': () => ({ session, messages: [] }),
    'session:create': ({ workspace }) => ({
      ...session,
      id: 's2',
      title: 'Nouvelle conversation',
      workspace,
    }),
    'workspace:choose': () => '/Users/test/Projets',
    'agent:send': () => ({ turnId: 't1' }),
    'agent:stop': () => undefined,
    'agent:retry': () => ({ turnId: 't2' }),
    'permission:respond': () => undefined,
    'file:open': () => undefined,
    'attachment:import': ({ hostPaths }) =>
      hostPaths.map((p) => ({
        path: `.atelier/uploads/${p.split('/').at(-1) ?? ''}`,
        name: p.split('/').at(-1) ?? '',
        size: 1200,
        mimeType: 'application/pdf',
      })),
  });
}

const emit = (event: Omit<AgentEvent, 'sessionId' | 'turnId'> & Partial<AgentEvent>): void => {
  api.emit('agent:event', { sessionId: 's1', turnId: 't1', ...event } as AgentEvent);
};

async function openSession(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByText('Récap des ventes'));
  await screen.findByText('Que puis-je faire pour vous ?');
  return user;
}

beforeEach(() => {
  api = setup();
});

describe('accueil', () => {
  it('liste les conversations récentes et crée une conversation dans un dossier', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('Récap des ventes')).toBeInTheDocument();
    expect(screen.getByText(/Ventes ·/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choisir un dossier' }));
    expect(api.callsTo('session:create')).toEqual([{ workspace: '/Users/test/Projets' }]);
    expect(
      await screen.findByRole('heading', { name: 'Nouvelle conversation' }),
    ).toBeInTheDocument();
  });

  it('demande confirmation avant de supprimer', async () => {
    const user = userEvent.setup();
    api.handlers['session:delete'] = () => undefined;
    render(<App />);
    await user.click(
      await screen.findByRole('button', { name: 'Supprimer la conversation « Récap des ventes »' }),
    );
    expect(api.callsTo('session:delete')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(api.callsTo('session:delete')).toEqual([{ sessionId: 's1' }]);
    expect(await screen.findByText('Aucune conversation pour l’instant.')).toBeInTheDocument();
  });
});

describe('conversation', () => {
  it('envoie un message et affiche la réponse en streaming, l’outil et la carte de fichier', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Fais un récap{Enter}');
    expect(api.callsTo('agent:send')).toEqual([{ sessionId: 's1', text: 'Fais un récap' }]);
    expect(screen.getByRole('heading', { level: 1, name: 'Fais un récap' })).toBeInTheDocument();
    expect(within(screen.getByRole('log')).getByText('Fais un récap')).toBeInTheDocument();
    expect(await screen.findByText('L’assistant réfléchit…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrêter' })).toBeInTheDocument();

    emit({ type: 'text_delta', delta: 'Voici **le récap**.' });
    expect(screen.getByText('le récap').tagName).toBe('STRONG');
    emit({
      type: 'tool_start',
      toolCallId: 'c1',
      toolName: 'write_file',
      input: { path: 'recap.md' },
    });
    expect(screen.getByText('Écriture de recap.md')).toBeInTheDocument();
    expect(screen.getByText('(en cours)')).toBeInTheDocument();
    emit({
      type: 'tool_result',
      toolCallId: 'c1',
      toolName: 'write_file',
      ok: true,
      output: 'Fichier écrit.',
      display: {
        type: 'file',
        file: {
          path: 'recap.md',
          absolutePath: '/Users/test/Ventes/recap.md',
          action: 'created',
          size: 2048,
        },
      },
    });
    expect(screen.getByText('(terminé)')).toBeInTheDocument();
    await user.click(within(screen.getByRole('log')).getByRole('button', { name: 'Ouvrir' }));
    expect(api.callsTo('file:open')).toEqual([{ absolutePath: '/Users/test/Ventes/recap.md' }]);

    emit({
      type: 'sources',
      sources: [{ title: 'Node.js', url: 'https://nodejs.org/fr', snippet: 'LTS' }],
    });
    emit({ type: 'done', reason: 'stop' });
    const sources = screen.getByRole('button', { name: 'Sources (1)' });
    await user.click(sources);
    expect(sources).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /Node\.js/ })).toHaveAttribute(
      'href',
      'https://nodejs.org/fr',
    );
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeInTheDocument();
  });

  it('modale de permission : autoriser une fois, Échap refuse', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Écris{Enter}');
    emit({
      type: 'permission_request',
      request: {
        id: 'p1',
        sessionId: 's1',
        toolCallId: 'c1',
        toolName: 'write_file',
        kind: 'file_write',
        title: 'Écrire le fichier recap.xlsx',
        detail: 'recap.xlsx (12 Ko)',
        input: {},
      },
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Écrire le fichier recap.xlsx' });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Refuser' })).toHaveFocus();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Autoriser une fois' }));
    expect(api.callsTo('permission:respond')).toEqual([
      { requestId: 'p1', decision: 'allow_once' },
    ]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    emit({
      type: 'permission_request',
      request: {
        id: 'p2',
        sessionId: 's1',
        toolCallId: 'c2',
        toolName: 'bash',
        kind: 'command',
        title: 'Exécuter python3 build.py',
        input: {},
      },
    });
    await user.keyboard('{Escape}');
    expect(api.callsTo('permission:respond').at(-1)).toEqual({ requestId: 'p2', decision: 'deny' });
  });

  it('affiche la reconnexion, puis l’erreur avec « Réessayer »', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Question{Enter}');
    emit({ type: 'llm_retry', attempt: 1, maxAttempts: 4, delayMs: 500, reason: 'HTTP 503' });
    expect(screen.getByText(/Reconnexion au serveur… \(tentative 1\/4\)/)).toBeInTheDocument();
    emit({ type: 'error', error: { code: 'llm/unreachable', message: 'down', retryable: true } });
    expect(screen.getByRole('alert')).toHaveTextContent(/injoignable/);
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(api.callsTo('agent:retry')).toEqual([{ sessionId: 's1' }]);
  });

  it('arrête le tour en cours', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Long{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Arrêter' }));
    expect(api.callsTo('agent:stop')).toEqual([{ sessionId: 's1' }]);
    emit({ type: 'done', reason: 'aborted' });
    expect(screen.getByText('Arrêté.')).toBeInTheDocument();
  });

  it('importe les fichiers déposés et les joint au message', async () => {
    const user = await openSession();
    const zone = screen.getByLabelText('Votre message').closest('div.relative');
    const file = new File(['%PDF'], 'facture.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.drop(zone as Element, { dataTransfer: { files: [file], types: ['Files'] } });
      await Promise.resolve();
    });
    expect(await screen.findByText('facture.pdf')).toBeInTheDocument();
    expect(api.callsTo('attachment:import')).toEqual([
      { sessionId: 's1', hostPaths: ['/fake/facture.pdf'] },
    ]);
    await user.type(screen.getByLabelText('Votre message'), 'Résume{Enter}');
    await waitFor(() => {
      expect(api.callsTo('agent:send').at(-1)).toEqual({
        sessionId: 's1',
        text: 'Résume',
        attachments: [
          {
            path: '.atelier/uploads/facture.pdf',
            name: 'facture.pdf',
            size: 1200,
            mimeType: 'application/pdf',
          },
        ],
      });
    });
  });
});
