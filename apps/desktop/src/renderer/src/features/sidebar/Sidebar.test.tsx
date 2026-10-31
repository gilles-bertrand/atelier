// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@atelier/shared';
import { App } from '@renderer/App';
import { defaultTestSettings, installFakeApi, type FakeApi } from '@renderer/test/fake-api';
import { SESSION_LIST_LIMIT } from '../Workspace';
import { groupByFolder, normalizeTitle, RECENT_COUNT } from './Sidebar';
import { COLLAPSED_KEY, HIDDEN_FOLDERS_KEY } from './useSidebarState';

function summary(id: string, title: string, workspace: string, minute: number): SessionSummary {
  const at = `2026-10-28T09:${String(minute).padStart(2, '0')}:00.000Z`;
  return { id, title, workspace, createdAt: at, updatedAt: at };
}

const VENTES = '/Users/test/Ventes';
const COMPTA = '/Users/test/Compta';

// Plus récente en tête, comme `session:list`.
const sessions: SessionSummary[] = [
  summary('s1', 'Récap des ventes', VENTES, 59),
  summary('s2', 'Bilan trimestriel', COMPTA, 50),
  summary('s3', 'Relances clients', VENTES, 40),
  summary('s4', 'Notes de frais', COMPTA, 30),
  summary('s5', 'Écart de caisse', COMPTA, 20),
  summary('s6', 'Archive 2025', VENTES, 10),
];

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi({
    'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
    'session:list': () => sessions,
    'session:open': ({ sessionId }) => ({
      session: sessions.find((s) => s.id === sessionId) ?? summary(sessionId, '?', VENTES, 0),
      messages: [],
    }),
    'session:create': ({ workspace }) => ({
      ...summary('new', 'Nouvelle conversation', workspace, 59),
      updatedAt: '2026-10-28T10:00:00.000Z',
    }),
    'session:delete': () => undefined,
    'workspace:choose': () => '/Users/test/Projets',
    'agent:send': () => ({ turnId: 't1' }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function start() {
  const user = userEvent.setup();
  render(<App />);
  const sidebar = await screen.findByRole('navigation', { name: 'Barre latérale' });
  await within(sidebar).findByRole('list', { name: 'Conversations récentes' });
  return { user, sidebar };
}

async function openConversation(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
): Promise<void> {
  const recent = screen.getByRole('list', { name: 'Conversations récentes' });
  await user.click(within(recent).getByText(title));
  await screen.findByText('Que puis-je faire pour vous ?');
}

const press = (key: string): void => {
  fireEvent.keyDown(window, { key, metaKey: true });
};

describe('colonne de gauche : contenu', () => {
  it(`charge ${String(SESSION_LIST_LIMIT)} conversations et n’en montre que ${String(RECENT_COUNT)} en Récentes`, async () => {
    await start();
    expect(api.callsTo('session:list')).toEqual([{ limit: SESSION_LIST_LIMIT }]);
    const recent = screen.getByRole('list', { name: 'Conversations récentes' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(RECENT_COUNT);
    expect(within(recent).queryByText('Archive 2025')).not.toBeInTheDocument();
  });

  it('regroupe par dossier, dépliable, le dossier de la conversation ouverte déplié', async () => {
    const { user } = await start();
    const folders = screen.getByRole('list', { name: 'Dossiers' });
    const ventes = within(folders).getByRole('button', { name: 'Ventes' });
    const compta = within(folders).getByRole('button', { name: 'Compta' });
    expect(ventes).toHaveAttribute('aria-expanded', 'false');
    expect(compta).toHaveAttribute('aria-expanded', 'false');

    await user.click(compta);
    expect(compta).toHaveAttribute('aria-expanded', 'true');
    const comptaList = within(folders).getByRole('list', {
      name: 'Conversations du dossier Compta',
    });
    expect(within(comptaList).getAllByRole('listitem')).toHaveLength(3);

    await openConversation(user, 'Récap des ventes');
    expect(ventes).toHaveAttribute('aria-expanded', 'true');
    const ventesList = within(folders).getByRole('list', {
      name: 'Conversations du dossier Ventes',
    });
    expect(within(ventesList).getByRole('button', { name: 'Récap des ventes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Archive 2025 n'est pas dans Récentes, mais reste dans son dossier.
    expect(within(ventesList).getByText('Archive 2025')).toBeInTheDocument();
  });

  it('recherche par titre, sans tenir compte des accents ni de la casse ; Échap efface', async () => {
    const { user } = await start();
    const search = screen.getByRole('searchbox', { name: 'Rechercher une conversation' });
    await user.type(search, 'ecart');
    const results = screen.getByRole('list', { name: 'Résultats de la recherche' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(1);
    expect(within(results).getByText('Écart de caisse')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Conversations récentes' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'introuvable');
    expect(screen.getByText('Aucune conversation ne correspond.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(screen.getByRole('list', { name: 'Conversations récentes' })).toBeInTheDocument();
  });

  it('ouvre les réglages depuis le pied de colonne', async () => {
    const { user, sidebar } = await start();
    const settings = within(sidebar).getByRole('button', { name: 'Réglages' });
    await user.click(settings);
    expect(screen.getByRole('heading', { name: 'Réglages' })).toBeInTheDocument();
    expect(settings).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Fermer les réglages' }));
    expect(screen.getByRole('heading', { name: 'Sur quoi travaille-t-on ?' })).toBeInTheDocument();
  });

  it('environnement depuis l’accueil : interrupteur Internet désactivé, avec explication', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: /Environnement/ }));
    expect(screen.getByRole('switch', { name: 'Internet pour les commandes' })).toBeDisabled();
    expect(screen.getByText('Ouvrez une conversation pour l’autoriser.')).toBeInTheDocument();
  });

  it('reprend le titre du premier message, puis la liste à jour à la fin du tour', async () => {
    const { user, sidebar } = await start();
    await user.click(within(sidebar).getByRole('button', { name: 'Nouvelle conversation' }));
    const recent = screen.getByRole('list', { name: 'Conversations récentes' });
    expect(await within(recent).findByText('Nouvelle conversation')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Votre message'), 'Prépare la facture{Enter}');
    expect(within(recent).getByText('Prépare la facture')).toBeInTheDocument();

    const before = api.callsTo('session:list').length;
    act(() => {
      api.emit('agent:event', {
        sessionId: 'new',
        turnId: 't1',
        type: 'done',
        reason: 'stop',
      });
    });
    expect(api.callsTo('session:list').length).toBe(before + 1);
  });
});

describe('colonne de gauche : actions', () => {
  it('Nouvelle conversation depuis l’accueil ouvre le choix du dossier', async () => {
    const { user, sidebar } = await start();
    await user.click(within(sidebar).getByRole('button', { name: 'Nouvelle conversation' }));
    expect(api.callsTo('workspace:choose')).toHaveLength(1);
    expect(api.callsTo('session:create')).toEqual([{ workspace: '/Users/test/Projets' }]);
  });

  it('⌘N crée une conversation dans le dossier de la conversation ouverte', async () => {
    const { user } = await start();
    await openConversation(user, 'Bilan trimestriel');
    press('n');
    await screen.findByRole('heading', { level: 1, name: 'Nouvelle conversation' });
    expect(api.callsTo('workspace:choose')).toEqual([]);
    expect(api.callsTo('session:create')).toEqual([{ workspace: COMPTA }]);
  });

  it('« + » de Dossiers ouvre un autre dossier', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'Ouvrir un dossier' }));
    expect(api.callsTo('session:create')).toEqual([{ workspace: '/Users/test/Projets' }]);
  });

  it('menu d’un dossier : Nouvelle conversation ici', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'Actions pour le dossier « Compta »' }));
    await user.click(screen.getByRole('menuitem', { name: 'Nouvelle conversation ici' }));
    expect(api.callsTo('session:create')).toEqual([{ workspace: COMPTA }]);
  });

  it('menu d’un dossier : Retirer de la liste, mémorisé, sans rien supprimer', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'Actions pour le dossier « Compta »' }));
    await user.click(screen.getByRole('menuitem', { name: 'Retirer de la liste' }));
    const folders = screen.getByRole('list', { name: 'Dossiers' });
    expect(within(folders).queryByRole('button', { name: 'Compta' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(HIDDEN_FOLDERS_KEY) ?? '[]')).toEqual([COMPTA]);
    expect(api.callsTo('session:delete')).toEqual([]);
    // Ses conversations restent dans Récentes.
    const recent = screen.getByRole('list', { name: 'Conversations récentes' });
    expect(within(recent).getByText('Bilan trimestriel')).toBeInTheDocument();

    // Une nouvelle conversation dans ce dossier le fait revenir.
    await openConversation(user, 'Bilan trimestriel');
    press('n');
    await screen.findByRole('heading', { level: 1, name: 'Nouvelle conversation' });
    expect(within(folders).getByRole('button', { name: 'Compta' })).toBeInTheDocument();
  });

  it('supprimer la conversation ouverte ramène à l’accueil', async () => {
    const { user } = await start();
    await openConversation(user, 'Récap des ventes');
    const recent = screen.getByRole('list', { name: 'Conversations récentes' });
    await user.click(
      within(recent).getByRole('button', { name: 'Actions pour « Récap des ventes »' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Supprimer' }));
    await user.click(within(recent).getByRole('button', { name: 'Supprimer' }));
    expect(api.callsTo('session:delete')).toEqual([{ sessionId: 's1' }]);
    expect(
      await screen.findByRole('heading', { name: 'Sur quoi travaille-t-on ?' }),
    ).toBeInTheDocument();
  });

  it('menu « … » : flèches, Échap rend le focus au bouton, Annuler garde la conversation', async () => {
    const { user } = await start();
    const trigger = screen.getByRole('button', { name: 'Actions pour le dossier « Ventes »' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Nouvelle conversation ici' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('menuitem', { name: 'Créer un projet à partir de ce dossier' }),
    ).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Retirer de la liste' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Actions pour « Récap des ventes »' }));
    await user.click(screen.getByRole('menuitem', { name: 'Supprimer' }));
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(api.callsTo('session:delete')).toEqual([]);
    expect(
      within(screen.getByRole('list', { name: 'Conversations récentes' })).getByText(
        'Récap des ventes',
      ),
    ).toBeInTheDocument();
  });

  it('l’en-tête de la conversation n’a plus retour, Nouvelle conversation ni Réglages', async () => {
    const { user } = await start();
    await openConversation(user, 'Récap des ventes');
    const header = screen
      .getByRole('heading', { level: 1, name: 'Récap des ventes' })
      .closest('header');
    if (!header) throw new Error('en-tête introuvable');
    expect(within(header).queryByRole('button', { name: 'Retour à l’accueil' })).toBeNull();
    expect(within(header).queryByRole('button', { name: /Nouvelle conversation/ })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Réglages' })).toBeNull();
    expect(within(header).getByRole('button', { name: 'Panneau de suivi' })).toBeInTheDocument();
  });
});

describe('colonne de gauche : masquage', () => {
  it('⌘B la masque, l’état est mémorisé, ⇥ la rouvre', async () => {
    const { user } = await start();
    press('b');
    expect(screen.queryByRole('navigation', { name: 'Barre latérale' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Afficher la barre latérale' }));
    expect(screen.getByRole('navigation', { name: 'Barre latérale' })).toBeInTheDocument();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('false');
  });

  it('reste masquée au redémarrage si elle l’était', async () => {
    window.localStorage.setItem(COLLAPSED_KEY, 'true');
    render(<App />);
    expect(
      await screen.findByRole('button', { name: 'Afficher la barre latérale' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Barre latérale' })).not.toBeInTheDocument();
  });

  it('bouton ⇤ de la colonne et ⌘K qui la rouvre avec le focus sur la recherche', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'Masquer la barre latérale' }));
    expect(screen.queryByRole('navigation', { name: 'Barre latérale' })).not.toBeInTheDocument();
    press('k');
    expect(
      await screen.findByRole('searchbox', { name: 'Rechercher une conversation' }),
    ).toHaveFocus();
  });

  it('se masque d’elle-même en fenêtre étroite, reste rouvrable sans changer la préférence', async () => {
    window.innerWidth = 1000;
    const user = userEvent.setup();
    render(<App />);
    const reopen = await screen.findByRole('button', { name: 'Afficher la barre latérale' });
    expect(screen.queryByRole('navigation', { name: 'Barre latérale' })).not.toBeInTheDocument();
    await user.click(reopen);
    expect(screen.getByRole('navigation', { name: 'Barre latérale' })).toBeInTheDocument();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBeNull();

    // Fenêtre élargie : la préférence (affichée) reprend la main.
    act(() => {
      window.innerWidth = 1280;
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('navigation', { name: 'Barre latérale' })).toBeInTheDocument();
    act(() => {
      window.innerWidth = 1000;
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.queryByRole('navigation', { name: 'Barre latérale' })).not.toBeInTheDocument();
  });

  it('fonctionne sans stockage local (accès refusé)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('refusé');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('refusé');
    });
    await start();
    press('b');
    expect(screen.queryByRole('navigation', { name: 'Barre latérale' })).not.toBeInTheDocument();
    press('b');
    expect(screen.getByRole('navigation', { name: 'Barre latérale' })).toBeInTheDocument();
  });

  it('ignore les raccourcis pendant une demande de permission', async () => {
    const { user } = await start();
    await openConversation(user, 'Récap des ventes');
    act(() => {
      api.emit('agent:event', {
        sessionId: 's1',
        turnId: 't1',
        type: 'permission_request',
        request: {
          id: 'p1',
          sessionId: 's1',
          toolCallId: 'c1',
          toolName: 'bash',
          kind: 'command',
          title: 'Exécuter ls',
          input: {},
        },
      });
    });
    expect(screen.getByRole('alertdialog', { name: 'Exécuter ls' })).toBeInTheDocument();
    press('b');
    press('n');
    expect(screen.getByRole('navigation', { name: 'Barre latérale' })).toBeInTheDocument();
    expect(api.callsTo('session:create')).toEqual([]);
  });
});

describe('groupByFolder / normalizeTitle', () => {
  it('regroupe par dossier, le plus actif en tête, sans les dossiers retirés', () => {
    const groups = groupByFolder(sessions, [VENTES]);
    expect(groups.map((g) => g.workspace)).toEqual([COMPTA]);
    expect(groupByFolder(sessions).map((g) => [g.workspace, g.sessions.length])).toEqual([
      [VENTES, 3],
      [COMPTA, 3],
    ]);
  });

  it('normalise accents et casse', () => {
    expect(normalizeTitle('Écart DE Caisse')).toBe('ecart de caisse');
  });
});
