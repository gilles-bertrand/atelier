// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, FileCard, SessionSummary } from '@atelier/shared';
import { App } from '@renderer/App';
import type { WorkbookPreview } from '../../../../common/file-preview';
import { PREVIEW_WIDTH_KEY } from './ResizeHandle';
import { defaultTestSettings, installFakeApi, type FakeApi } from '@renderer/test/fake-api';

const session: SessionSummary = {
  id: 's1',
  title: 'Récap des ventes',
  workspace: '/Users/test/Ventes',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:30:00.000Z',
};

const WORKBOOK: WorkbookPreview = {
  sheets: [
    {
      name: 'Récap',
      rows: [
        ['Mois', 'Total'],
        ['Janvier', '15211.4'],
      ],
      totalRows: 2,
      totalColumns: 2,
      hidden: false,
    },
    {
      name: 'Détail',
      rows: [
        ['Magasin', 'Ventes'],
        ['Namur', '980'],
      ],
      totalRows: 900,
      totalColumns: 2,
      hidden: false,
    },
  ],
};

let api: FakeApi;
const fetchMock = vi.fn<(url: string) => Promise<Response>>();

// jsdom n'implémente pas la capture du pointeur (poignée de redimensionnement).
Object.assign(HTMLElement.prototype, {
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  hasPointerCapture: () => false,
});

beforeEach(() => {
  api = installFakeApi({
    'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
    'session:list': () => [session],
    'session:open': () => ({ session, messages: [] }),
    'agent:send': () => ({ turnId: 't1' }),
    'file:open': () => undefined,
    'file:reveal': () => undefined,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) =>
    Promise.resolve(
      url.includes('ventes.csv')
        ? new Response('Mois;Total\nJanvier;1200\nFévrier;980\n')
        : url.includes('recap.xlsx')
          ? new Response(JSON.stringify(WORKBOOK))
          : url.includes('lettre.docx')
            ? new Response('## Objet\n\nMadame, Monsieur,')
            : new Response('# Synthèse\n\nTout va **bien**.'),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const emit = (event: Omit<AgentEvent, 'sessionId' | 'turnId'> & Partial<AgentEvent>): void => {
  api.emit('agent:event', { sessionId: 's1', turnId: 't1', ...event } as AgentEvent);
};

const file = (path: string, action: FileCard['action'] = 'created'): FileCard => ({
  path,
  absolutePath: `/Users/test/Ventes/${path}`,
  action,
  size: 996,
});

async function conversationWithFiles(...files: FileCard[]) {
  const user = userEvent.setup();
  render(<App />);
  const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
  await user.click(within(recent).getByText('Récap des ventes'));
  await screen.findByText('Que puis-je faire pour vous ?');
  await user.type(screen.getByLabelText('Votre message'), 'Fais la synthèse{Enter}');
  files.forEach((f, i) => {
    const id = `c${String(i)}`;
    emit({ type: 'tool_start', toolCallId: id, toolName: 'write_file', input: { path: f.path } });
    emit({
      type: 'tool_result',
      toolCallId: id,
      toolName: 'write_file',
      ok: true,
      output: 'Fichier écrit.',
      display: { type: 'file', file: f },
    });
  });
  emit({ type: 'text_delta', delta: 'C’est prêt.' });
  emit({ type: 'done', reason: 'stop' });
  return user;
}

describe('aperçu des fichiers', () => {
  it('regroupe les fichiers en fin de réponse et ouvre l’aperçu markdown à droite', async () => {
    const user = await conversationWithFiles(file('synthese.md'));
    const group = within(screen.getByRole('log')).getByRole('list', {
      name: 'Fichiers de la réponse',
    });
    const card = within(group).getByRole('button', { name: 'Aperçu de synthese.md' });
    expect(card).toHaveAttribute('aria-pressed', 'false');

    await user.click(card);
    const panel = screen.getByRole('complementary', { name: 'synthese.md' });
    // Le panneau de suivi cède la place à l'aperçu.
    expect(screen.queryByRole('complementary', { name: 'Suivi de la conversation' })).toBeNull();
    expect(await within(panel).findByRole('heading', { name: 'Synthèse' })).toBeInTheDocument();
    expect(within(panel).getByText('bien').tagName).toBe('STRONG');
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(
      /^atelier-file:\/\/preview\/\?path=%2FUsers%2Ftest%2FVentes%2Fsynthese\.md&v=\d+$/,
    );
    expect(within(group).getByRole('button', { name: 'Aperçu de synthese.md' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Source brute, puis fermeture au clavier : retour au suivi.
    await user.click(within(panel).getByRole('button', { name: 'Source' }));
    expect(within(panel).getByText(/# Synthèse/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Ouvrir synthese.md' }));
    expect(api.callsTo('file:open')).toEqual([{ absolutePath: '/Users/test/Ventes/synthese.md' }]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'synthese.md' })).toBeNull();
    expect(
      screen.getByRole('complementary', { name: 'Suivi de la conversation' }),
    ).toBeInTheDocument();
  });

  it('affiche un CSV en tableau, depuis le panneau de suivi aussi', async () => {
    const user = await conversationWithFiles(file('ventes.csv'));
    const side = screen.getByRole('complementary', { name: 'Suivi de la conversation' });
    await user.click(within(side).getByRole('button', { name: 'Aperçu de ventes.csv' }));
    const panel = screen.getByRole('complementary', { name: 'ventes.csv' });
    expect(await within(panel).findByRole('columnheader', { name: 'Mois' })).toBeInTheDocument();
    expect(within(panel).getByRole('cell', { name: 'Février' })).toBeInTheDocument();
  });

  it('montre l’erreur du main (fichier hors dossier, supprimé…)', async () => {
    fetchMock.mockResolvedValue(new Response('Fichier introuvable.', { status: 403 }));
    const user = await conversationWithFiles(file('synthese.md'));
    await user.click(
      within(screen.getByRole('log')).getByRole('button', { name: 'Aperçu de synthese.md' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Fichier introuvable.');
  });

  it('propose « Ouvrir » pour un format sans aperçu, et bascule d’un fichier à l’autre', async () => {
    const user = await conversationWithFiles(file('recap.pptx'), file('synthese.md'));
    const log = within(screen.getByRole('log'));
    await user.click(log.getByRole('button', { name: 'Aperçu de recap.pptx' }));
    expect(screen.getByText('Pas d’aperçu pour ce type de fichier.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(log.getByRole('button', { name: 'Aperçu de synthese.md' }));
    await waitFor(() => {
      expect(screen.getByRole('complementary', { name: 'synthese.md' })).toBeInTheDocument();
    });
    // Un second clic sur la carte affichée referme l'aperçu.
    await user.click(log.getByRole('button', { name: 'Aperçu de synthese.md' }));
    expect(screen.queryByRole('complementary', { name: 'synthese.md' })).toBeNull();
  });

  it('affiche un classeur Excel feuille par feuille', async () => {
    const user = await conversationWithFiles(file('recap.xlsx'));
    await user.click(
      within(screen.getByRole('log')).getByRole('button', { name: 'Aperçu de recap.xlsx' }),
    );
    const panel = screen.getByRole('complementary', { name: 'recap.xlsx' });
    const tabs = await within(panel).findByRole('tablist', { name: 'Feuilles du classeur' });
    expect(within(tabs).getByRole('tab', { name: 'Récap' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(panel).getByRole('cell', { name: 'Janvier' })).toBeInTheDocument();
    // Flèche droite : feuille suivante, avec la mention de troncature.
    within(tabs).getByRole('tab', { name: 'Récap' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(within(tabs).getByRole('tab', { name: 'Détail' })).toHaveFocus();
    expect(within(panel).getByRole('cell', { name: 'Namur' })).toBeInTheDocument();
    expect(within(panel).getByText('2 premières lignes sur 900.')).toBeInTheDocument();
  });

  it('affiche un document Word converti, avec la mention d’aperçu simplifié', async () => {
    const user = await conversationWithFiles(file('lettre.docx'));
    await user.click(
      within(screen.getByRole('log')).getByRole('button', { name: 'Aperçu de lettre.docx' }),
    );
    const panel = screen.getByRole('complementary', { name: 'lettre.docx' });
    expect(await within(panel).findByRole('heading', { name: 'Objet' })).toBeInTheDocument();
    expect(within(panel).getByText(/Aperçu simplifié/)).toBeInTheDocument();
  });

  it('se redimensionne au clavier et mémorise la largeur', async () => {
    const user = await conversationWithFiles(file('synthese.md'));
    await user.click(
      within(screen.getByRole('log')).getByRole('button', { name: 'Aperçu de synthese.md' }),
    );
    const panel = screen.getByRole('complementary', { name: 'synthese.md' });
    const handle = within(panel).getByRole('separator', { name: 'Redimensionner l’aperçu' });
    // jsdom ne fait pas de mise en page : conteneur de 1200 px, panneau de 400 px.
    const container = panel.parentElement;
    if (!container) throw new Error('conteneur absent');
    container.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);
    panel.getBoundingClientRect = () => new DOMRect(800, 0, 400, 800);
    handle.focus();
    await user.keyboard('{ArrowLeft}');
    expect(handle).toHaveAttribute('aria-valuenow', '424');
    expect(window.localStorage.getItem(PREVIEW_WIDTH_KEY)).toBe('424');
    expect(panel.style.width).toContain('424px');
    // Double-clic : retour à la largeur par défaut.
    await user.dblClick(handle);
    expect(panel.style.width).toBe('');
  });
});
