// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  ChatMessage,
  LlmModelInfo,
  SessionSummary,
  LlmServerConfig,
} from '@atelier/shared';
import { App } from '@renderer/App';
import {
  defaultTestSettings,
  FakeIpcFailure,
  installFakeApi,
  type FakeApi,
} from '@renderer/test/fake-api';

const session: SessionSummary = {
  id: 's1',
  title: 'Récap',
  workspace: '/Users/test/Ventes',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:30:00.000Z',
  model: 'qwen3.5:35b',
};

const MODELS: LlmModelInfo[] = [
  {
    name: 'qwen3.5:35b',
    family: 'qwen35moe',
    sizeBytes: 21_909_194_238,
    contextWindow: 32_768,
    capabilities: ['completion', 'vision', 'thinking', 'tools'],
    loaded: true,
  },
  {
    name: 'qwen3.5:9b',
    family: 'qwen35',
    capabilities: ['completion', 'vision', 'tools', 'thinking'],
    loaded: false,
  },
  {
    name: 'mistral-small:latest',
    family: 'llama',
    capabilities: ['completion', 'tools'],
    loaded: false,
  },
  { name: 'llama-texte', family: 'llama', capabilities: ['completion'], loaded: false },
  { name: 'mxbai-embed-large', family: 'bert', capabilities: ['embedding'] },
];

function setup(
  options: {
    messages?: ChatMessage[];
    settings?: Partial<LlmServerConfig>;
    summary?: SessionSummary;
  } = {},
): FakeApi {
  let current = options.summary ?? session;
  return installFakeApi({
    'settings:get': () =>
      defaultTestSettings({
        onboardingCompleted: true,
        llm: {
          baseUrl: 'https://llm.exemple.fr',
          model: 'qwen3.5:35b',
          thinking: true,
          ...options.settings,
        },
      }),
    'session:list': () => [current],
    'session:open': () => ({ session: current, messages: options.messages ?? [] }),
    'session:set-model': ({ model }) => {
      current = { ...current, model: model ?? 'qwen3.5:35b' };
      return current;
    },
    'llm:list-models': () => MODELS,
    'agent:send': () => ({ turnId: 't1' }),
    'agent:retry': () => ({ turnId: 't2' }),
    'attachment:import': ({ hostPaths }) =>
      hostPaths.map((p) => ({
        path: `.atelier/uploads/${p.split('/').at(-1) ?? ''}`,
        name: p.split('/').at(-1) ?? '',
        size: 1200,
        mimeType: 'image/png',
      })),
  });
}

async function openSession(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<App />);
  const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
  await user.click(within(recent).getByText('Récap'));
  await screen.findByRole('textbox', { name: 'Votre message' });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /^Modèle :/ })).toBeEnabled();
  });
  return user;
}

const picker = (): HTMLElement => screen.getByRole('button', { name: /^Modèle :/ });

async function openList(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(picker());
  const listbox = screen.getByRole('listbox', { name: 'Modèles du serveur' });
  await within(listbox).findAllByRole('option');
  return listbox;
}

describe('sélecteur de modèle', () => {
  it('liste relue à chaque ouverture, sans embeddings, avec pastille, badge et entrée grisée', async () => {
    const api = setup();
    const user = await openSession();
    expect(picker()).toHaveAccessibleName('Modèle : qwen3.5:35b');
    expect(picker()).toHaveAttribute('aria-haspopup', 'listbox');

    const listbox = await openList(user);
    expect(picker()).toHaveAttribute('aria-expanded', 'true');
    const options = within(listbox).getAllByRole('option');
    expect(options.map((o) => o.querySelector('.font-medium')?.textContent)).toEqual([
      'qwen3.5:35b',
      'qwen3.5:9b',
      'llama-texte',
      'mistral-small:latest',
    ]);
    const [current, cold, noTools, untested] = options as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(current).toHaveAttribute('aria-selected', 'true');
    expect(current).toHaveTextContent('prêt');
    expect(current).toHaveTextContent('Recommandé (32 Go et plus)');
    expect(current).toHaveTextContent(/contexte 32\s768 tokens/);
    expect(within(current).getByText('outils')).toBeInTheDocument();
    expect(within(current).getByText('images')).toBeInTheDocument();
    expect(within(current).getByText('réflexion')).toBeInTheDocument();
    expect(within(current).queryByText('non testé')).not.toBeInTheDocument();
    expect(cold).toHaveTextContent('à froid');
    // Sans outils : grisé, avec la raison.
    expect(noTools).toHaveAttribute('aria-disabled', 'true');
    expect(noTools).toHaveTextContent(
      'Indisponible : ne sait pas utiliser les outils : lecture de fichiers, commandes',
    );
    expect(within(untested).getByText('non testé')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(picker());
    await within(screen.getByRole('listbox')).findAllByRole('option');
    expect(api.callsTo('llm:list-models')).toHaveLength(2);
  });

  it('clavier : flèches, Entrée sur une entrée grisée sans effet, Échap rend le focus', async () => {
    const api = setup();
    const user = await openSession();
    const listbox = await openList(user);
    expect(listbox).toHaveFocus();
    const active = (): string | null =>
      document.getElementById(listbox.getAttribute('aria-activedescendant') ?? '')?.textContent ??
      null;
    expect(active()).toContain('qwen3.5:35b');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(active()).toContain('llama-texte');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(api.callsTo('session:set-model')).toEqual([]);
    await user.keyboard('{End}');
    expect(active()).toContain('mistral-small');
    await user.keyboard('{Home}');
    expect(active()).toContain('qwen3.5:35b');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(picker()).toHaveFocus();
    expect(picker()).toHaveAttribute('aria-expanded', 'false');
  });

  it('choix d’un modèle à froid : enregistré, avertissement, encart et « Chargement du modèle… »', async () => {
    const api = setup();
    const user = await openSession();
    await openList(user);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(api.callsTo('session:set-model')).toEqual([{ sessionId: 's1', model: 'qwen3.5:9b' }]);
    await waitFor(() => {
      expect(picker()).toHaveAccessibleName('Modèle : qwen3.5:9b');
    });
    expect(picker()).toHaveFocus();
    expect(
      screen.getByText(/Premier message plus lent : le serveur doit charger qwen3\.5:9b/),
    ).toBeInTheDocument();

    // L'encart Environnement suit le modèle de la conversation ouverte.
    await user.click(screen.getByRole('button', { name: /Environnement/ }));
    const env = screen.getByRole('region', { name: 'Environnement' });
    expect(within(env).getByTitle('qwen3.5:9b')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Votre message' }), 'Bonjour{Enter}');
    expect(await screen.findByText('Chargement du modèle sur le serveur…')).toBeInTheDocument();
    expect(screen.queryByText(/Premier message plus lent/)).not.toBeInTheDocument();
    // Pendant le tour, le modèle ne change pas (D1).
    expect(picker()).toBeDisabled();

    const emit = (event: Partial<AgentEvent>): void => {
      act(() => {
        api.emit('agent:event', { sessionId: 's1', turnId: 't1', ...event } as AgentEvent);
      });
    };
    emit({ type: 'text_delta', delta: 'Bonjour !' });
    expect(screen.queryByText('Chargement du modèle sur le serveur…')).not.toBeInTheDocument();
    // La réponse en cours porte le modèle de la conversation.
    expect(screen.getByText('Bonjour !').closest('[title]')).toHaveAttribute(
      'title',
      'Modèle : qwen3.5:9b',
    );
    emit({ type: 'done', reason: 'stop' });
    expect(picker()).toBeEnabled();
  });

  it('refus du main (modèle sans outils) : message lisible, modèle inchangé', async () => {
    const api = setup();
    api.handlers['session:set-model'] = () => {
      throw new FakeIpcFailure({
        code: 'llm/model_unsupported',
        message: 'no tools',
        retryable: false,
        details: { missing: 'tools' },
      });
    };
    const user = await openSession();
    await openList(user);
    await user.keyboard('{End}{Enter}');
    expect(
      await screen.findByText(/Ce modèle ne sait pas utiliser les outils d’Atelier/),
    ).toBeInTheDocument();
    expect(picker()).toHaveAccessibleName('Modèle : qwen3.5:35b');
  });

  it('conversation antérieure à #13 : suit le modèle par défaut des Réglages', async () => {
    const { model: _model, ...legacy } = session;
    setup({ summary: legacy, settings: { model: 'qwen3.5:9b' } });
    await openSession();
    expect(picker()).toHaveAccessibleName('Modèle : qwen3.5:9b');
  });
});

describe('fil de la conversation', () => {
  const answer = (id: string, model: string | undefined, text: string): ChatMessage => ({
    id,
    sessionId: 's1',
    role: 'assistant',
    parts: [{ type: 'text', text }],
    createdAt: '2026-10-28T09:00:00.000Z',
    ...(model !== undefined ? { model } : {}),
  });
  const question = (id: string): ChatMessage => ({
    id,
    sessionId: 's1',
    role: 'user',
    parts: [{ type: 'text', text: `Question ${id}` }],
    createdAt: '2026-10-28T09:00:00.000Z',
  });

  it('séparateur « Modèle : X » au changement, modèle en infobulle de chaque réponse', async () => {
    setup({
      messages: [
        question('q0'),
        answer('a0', undefined, 'Réponse ancienne'),
        question('q1'),
        answer('a1', 'qwen3.5:35b', 'Réponse une'),
        question('q2'),
        answer('a2', 'qwen3.5:35b', 'Réponse deux'),
        question('q3'),
        answer('a3', 'qwen3.5:9b', 'Réponse trois'),
      ],
    });
    await openSession();
    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(1);
    expect(separators[0]).toHaveAccessibleName('Modèle : qwen3.5:9b');
    expect(screen.getByText('Réponse trois').closest('[title]')).toHaveAttribute(
      'title',
      'Modèle : qwen3.5:9b',
    );
    expect(screen.getByText('Réponse ancienne').closest('[title]')).toBeNull();
  });

  it('modèle introuvable pendant un tour : « Choisir un autre modèle » ouvre le sélecteur', async () => {
    const api = setup();
    const user = await openSession();
    await user.type(screen.getByRole('textbox', { name: 'Votre message' }), 'Salut{Enter}');
    act(() => {
      api.emit('agent:event', {
        type: 'error',
        sessionId: 's1',
        turnId: 't1',
        error: { code: 'llm/model_not_found', message: 'absent', retryable: false },
      });
    });
    expect(screen.getByText('Ce modèle n’est pas installé sur le serveur.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choisir un autre modèle' }));
    expect(await screen.findByRole('listbox', { name: 'Modèles du serveur' })).toBeInTheDocument();
  });
});

describe('image jointe', () => {
  const dropImage = async (): Promise<void> => {
    URL.createObjectURL = () => 'blob:vignette';
    URL.revokeObjectURL = () => undefined;
    const zone = screen.getByRole('textbox', { name: 'Votre message' }).closest('div.relative');
    const file = new File(['png'], 'photo.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.drop(zone as Element, { dataTransfer: { files: [file], types: ['Files'] } });
      await Promise.resolve();
    });
    await screen.findByText('photo.png');
  };

  it('avertit si le modèle ne lit pas les images et qu’aucun modèle vision n’est réglé', async () => {
    setup({ summary: { ...session, model: 'mistral-small:latest' } });
    await openSession();
    await dropImage();
    expect(
      await screen.findByText(/Le modèle mistral-small:latest ne lit pas les images/),
    ).toBeInTheDocument();
  });

  it('pas d’avertissement avec un modèle vision réglé ou un modèle qui lit les images', async () => {
    const api = setup({
      summary: { ...session, model: 'mistral-small:latest' },
      settings: { visionModel: 'qwen3.5:9b' },
    });
    await openSession();
    await dropImage();
    expect(screen.queryByText(/ne lit pas les images/)).not.toBeInTheDocument();
    // Modèle vision réglé : la liste n'est même pas lue.
    expect(api.callsTo('llm:list-models')).toEqual([]);
  });

  it('pas d’avertissement quand le modèle de la conversation lit les images', async () => {
    const api = setup();
    await openSession();
    await dropImage();
    await waitFor(() => {
      expect(api.callsTo('llm:list-models')).toHaveLength(1);
    });
    expect(screen.queryByText(/ne lit pas les images/)).not.toBeInTheDocument();
  });
});
