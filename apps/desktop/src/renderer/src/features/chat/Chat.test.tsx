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
  const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
  await user.click(within(recent).getByText('Récap des ventes'));
  await screen.findByText('Que puis-je faire pour vous ?');
  return user;
}

beforeEach(() => {
  api = setup();
});

describe('accueil', () => {
  it('ne garde que « Choisir un dossier » ; les conversations sont dans la colonne', async () => {
    const user = userEvent.setup();
    render(<App />);
    const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
    expect(within(recent).getByText('Récap des ventes')).toBeInTheDocument();
    expect(within(recent).getByText(/Ventes ·/)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).queryByText('Récap des ventes')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choisir un dossier' }));
    expect(api.callsTo('session:create')).toEqual([{ workspace: '/Users/test/Projets' }]);
    expect(
      await screen.findByRole('heading', { name: 'Nouvelle conversation' }),
    ).toBeInTheDocument();
  });

  it('demande confirmation avant de supprimer (menu « … » de la conversation)', async () => {
    const user = userEvent.setup();
    api.handlers['session:delete'] = () => undefined;
    render(<App />);
    await user.click(
      await screen.findByRole('button', { name: 'Actions pour « Récap des ventes »' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Supprimer' }));
    expect(api.callsTo('session:delete')).toEqual([]);
    expect(screen.getByText(/Les fichiers du dossier sont conservés/)).toBeInTheDocument();
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

  it('affiche en cartes les fichiers produits dans la VM par une commande', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Fais le classeur{Enter}');
    emit({
      type: 'tool_start',
      toolCallId: 'b1',
      toolName: 'bash',
      input: { command: 'python x.py' },
    });
    emit({
      type: 'tool_result',
      toolCallId: 'b1',
      toolName: 'bash',
      ok: true,
      output: 'ok',
      display: { type: 'command', command: 'python x.py', exitCode: 0, output: 'ok' },
    });
    emit({
      type: 'tool_files',
      toolCallId: 'b1',
      files: [
        {
          path: 'recap.xlsx',
          absolutePath: '/Users/test/Ventes/recap.xlsx',
          action: 'created',
          size: 4096,
        },
      ],
    });
    const log = screen.getByRole('log');
    expect(
      within(log).getByRole('button', { name: 'Afficher recap.xlsx dans le Finder' }),
    ).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Ouvrir' }));
    expect(api.callsTo('file:open')).toEqual([{ absolutePath: '/Users/test/Ventes/recap.xlsx' }]);
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

  it('flux coupé sur une balise réservée : message clair, pas de « Réessayer », saisie prête', async () => {
    const user = await openSession();
    await user.type(
      screen.getByLabelText('Votre message'),
      'Écris un exemple de <tool_call>{Enter}',
    );
    emit({
      type: 'error',
      error: {
        code: 'llm/bad_response',
        message: 'technique',
        retryable: false,
        details: { reason: 'stream_cut' },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/balise réservée/);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument();
    expect(screen.getByText('Reformulez votre demande ci-dessous.')).toBeInTheDocument();
    const input = screen.getByLabelText('Votre message');
    expect(input).toBeEnabled();
    await user.type(input, 'Autrement{Enter}');
    expect(api.callsTo('agent:send').at(-1)).toEqual({ sessionId: 's1', text: 'Autrement' });
  });

  it('appel d’outil illisible (#69) : message d’agent-core, pas de « Réessayer »', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Écris le long rapport{Enter}');
    emit({
      type: 'error',
      error: {
        code: 'llm/bad_response',
        message:
          'Le serveur n’a pas pu lire un appel d’outil du modèle, même après une nouvelle tentative.',
        retryable: false,
        details: { reason: 'tool_call_parse' },
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/n’a pas pu lire un appel d’outil/);
    expect(alert).not.toHaveTextContent(/Ollama/);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument();
    expect(screen.getByText('Reformulez votre demande ci-dessous.')).toBeInTheDocument();
  });

  it('réponse finale vide (#73) : message d’agent-core, pas de « Réessayer »', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Résume le dossier{Enter}');
    emit({
      type: 'error',
      error: {
        code: 'llm/bad_response',
        message: 'Le modèle s’est arrêté sans répondre, même après une nouvelle tentative.',
        retryable: false,
        details: { reason: 'empty_final' },
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/arrêté sans répondre/);
    expect(alert).not.toHaveTextContent(/Ollama/);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument();
    expect(screen.getByText('Reformulez votre demande ci-dessous.')).toBeInTheDocument();
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

describe('icônes et couleurs', () => {
  it('les suggestions de la conversation vide préremplissent la saisie sans rien envoyer', async () => {
    const user = await openSession();
    await user.click(screen.getByRole('button', { name: 'Créer un tableau Excel' }));
    const field = screen.getByLabelText('Votre message');
    expect(field).toHaveValue('Crée un tableau Excel qui ');
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect(api.callsTo('agent:send')).toEqual([]);
  });

  it('le trombone importe les fichiers choisis comme un glisser-déposer', async () => {
    const user = await openSession();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('champ de fichiers absent');
    expect(screen.getByRole('button', { name: 'Joindre des fichiers' })).toBeEnabled();
    await user.upload(input, new File(['%PDF'], 'contrat-bail.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('contrat-bail.pdf')).toBeInTheDocument();
    expect(api.callsTo('attachment:import')).toEqual([
      { sessionId: 's1', hostPaths: ['/fake/contrat-bail.pdf'] },
    ]);
  });

  it('une suppression demande un accord en rouge, avec un bouton qui dit ce qu’il fait', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Fais le ménage{Enter}');
    emit({
      type: 'permission_request',
      request: {
        id: 'p3',
        sessionId: 's1',
        toolCallId: 'c3',
        toolName: 'mcp__fichiers__delete',
        kind: 'file_delete',
        title: 'Supprimer brouillon-v1.docx',
        input: {},
      },
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Supprimer brouillon-v1.docx' });
    expect(dialog.querySelector('[data-risk]')).toHaveAttribute('data-risk', 'high');
    expect(
      within(dialog).queryByRole('button', { name: 'Autoriser une fois' }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer une fois' }));
    expect(api.callsTo('permission:respond')).toEqual([
      { requestId: 'p3', decision: 'allow_once' },
    ]);
  });

  it('la colonne signale une conversation qui travaille, puis qui attend un accord', async () => {
    const user = await openSession();
    const recent = screen.getByRole('list', { name: 'Conversations récentes' });
    expect(within(recent).queryByText('L’assistant travaille')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Votre message'), 'Fais un récap{Enter}');
    expect(await within(recent).findByText('L’assistant travaille')).toBeInTheDocument();

    emit({
      type: 'permission_request',
      request: {
        id: 'p4',
        sessionId: 's1',
        toolCallId: 'c4',
        toolName: 'bash',
        kind: 'command',
        title: 'Exécuter python3 recap.py',
        input: {},
      },
    });
    expect(within(recent).getByText('En attente de votre accord')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog').querySelector('[data-risk]')).toHaveAttribute(
      'data-risk',
      'medium',
    );

    await user.click(screen.getByRole('button', { name: 'Autoriser une fois' }));
    expect(within(recent).getByText('L’assistant travaille')).toBeInTheDocument();

    emit({ type: 'done', reason: 'stop' });
    expect(within(recent).queryByText('L’assistant travaille')).not.toBeInTheDocument();
  });

  it('le bloc d’outil reconnaît la lecture d’un skill', async () => {
    const user = await openSession();
    await user.type(screen.getByLabelText('Votre message'), 'Fais le classeur{Enter}');
    emit({
      type: 'tool_start',
      toolCallId: 'c5',
      toolName: 'read_file',
      input: { path: '/opt/atelier/skills/xlsx/SKILL.md' },
    });
    expect(screen.getByText('Consultation du skill xlsx')).toBeInTheDocument();
  });
});
