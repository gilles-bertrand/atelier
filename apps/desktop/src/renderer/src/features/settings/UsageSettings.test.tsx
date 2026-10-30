// @vitest-environment jsdom
import { type ModelUsageStats, type UsagePeriod, type UsageSummary } from '@atelier/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@renderer/App';
import { FakeIpcFailure, defaultTestSettings, installFakeApi } from '@renderer/test/fake-api';
import { dailyBars, usageTotals, UsageSettings } from './UsageSettings';

const NOW = new Date(2026, 9, 30, 12);

const big: ModelUsageStats = {
  model: 'qwen3.5:35b',
  turns: 40,
  steps: 120,
  inputTokens: 1_200_000,
  outputTokens: 48_000,
  avgTokensPerTurn: 31_200,
  tokensPerSecond: 24,
  avgContextRatio: 0.31,
  peakContextRatio: 0.82,
  compactions: 3,
  relaunchedTurns: 6,
  relaunches: { continuation: 4, stream_cut: 2 },
  errorTurns: 2,
  lastUsedAt: '2026-10-30T10:00:00.000Z',
};

const small: ModelUsageStats = {
  model: 'qwen3.5:9b',
  turns: 10,
  steps: 12,
  inputTokens: 90_000,
  outputTokens: 12_000,
  avgTokensPerTurn: 10_200,
  tokensPerSecond: 60,
  compactions: 0,
  relaunchedTurns: 0,
  relaunches: {},
  errorTurns: 0,
  lastUsedAt: '2026-10-29T10:00:00.000Z',
};

const summary = (period: UsagePeriod, models = [big, small]): UsageSummary => ({
  period,
  models,
  daily: [
    {
      day: '2026-10-29',
      model: 'qwen3.5:9b',
      inputTokens: 90_000,
      outputTokens: 12_000,
      turns: 10,
    },
    {
      day: '2026-10-30',
      model: 'qwen3.5:35b',
      inputTokens: 1_200_000,
      outputTokens: 48_000,
      turns: 40,
    },
  ],
});

describe('Réglages › Utilisation', () => {
  it('affiche les tuiles, les barres et le tableau par modèle (30 jours par défaut)', async () => {
    const load = vi.fn((period: UsagePeriod) => Promise.resolve(summary(period)));
    render(<UsageSettings load={load} now={NOW} />);
    expect(screen.getByRole('status')).toHaveTextContent('Chargement…');
    expect(await screen.findByText('1,4 M')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('30d');
    expect(screen.getByRole('button', { name: '30 jours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expect(screen.getByText('1,3 M entrée · 60 k sortie')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    // Débit global : 60 000 tokens / (48 000/24 + 12 000/60) s = 27,3 tokens/s.
    expect(screen.getByText('27,3 tokens/s')).toBeInTheDocument();
    expect(screen.getByText('82 %')).toBeInTheDocument();
    expect(screen.getByText('3 compactions')).toBeInTheDocument();

    // 30 jours de barres, jours sans activité compris.
    const chart = screen.getByRole('figure', { name: /Tokens par jour/ });
    expect(within(chart).getAllByRole('listitem')).toHaveLength(30);
    expect(
      within(chart).getByText('30 oct. : 1,2 M en entrée, 48 k en sortie'),
    ).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Consommation par modèle' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const first = within(rows[1] as HTMLElement);
    expect(first.getByRole('rowheader')).toHaveTextContent('qwen3.5:35b');
    expect(first.getByText('31 % / 82 %')).toBeInTheDocument();
    expect(first.getByText(/6 \(15 %\)/)).toHaveAttribute(
      'title',
      'Suite demandée : 4 · Flux coupé : 2',
    );
    expect(first.getByText('2 (5 %)')).toBeInTheDocument();
    const second = within(rows[2] as HTMLElement);
    expect(second.getByText('—')).toBeInTheDocument();
    expect(second.getByTitle('Aucune relance')).toHaveTextContent('0 (0 %)');
  });

  it('relit les données au changement de période', async () => {
    const user = userEvent.setup();
    const load = vi.fn((period: UsagePeriod) =>
      Promise.resolve(period === '7d' ? summary('7d', [small]) : summary(period)),
    );
    render(<UsageSettings load={load} now={NOW} />);
    await screen.findByText('1,4 M');
    await user.click(screen.getByRole('button', { name: '7 jours' }));
    expect(load).toHaveBeenLastCalledWith('7d');
    expect(await screen.findByText('102 k')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 jours' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(screen.getByRole('figure', { name: /Tokens par jour/ })).getAllByRole('listitem'),
    ).toHaveLength(7);
  });

  it('état vide', async () => {
    render(<UsageSettings load={() => Promise.resolve(summary('30d', []))} now={NOW} />);
    expect(
      await screen.findByText('Aucune consommation enregistrée sur la période.'),
    ).toBeInTheDocument();
  });

  it('erreur de lecture en français', async () => {
    render(<UsageSettings load={() => Promise.reject(new Error('base illisible'))} now={NOW} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Une erreur inattendue est survenue.',
    );
  });

  it('rubrique accessible depuis les Réglages, après « Serveur et modèle »', async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
      'session:list': () => [],
    });
    api.handlers['usage:summary'] = ({ period }) => summary(period);
    render(<App />);
    const sidebar = await screen.findByRole('navigation', { name: 'Barre latérale' });
    await user.click(within(sidebar).getByRole('button', { name: 'Réglages' }));
    const nav = screen.getByRole('navigation', { name: 'Rubriques des réglages' });
    const labels = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels.slice(0, 2)).toEqual(['Serveur et modèle', 'Utilisation']);
    await user.click(within(nav).getByRole('button', { name: 'Utilisation' }));
    expect(await screen.findByText('1,4 M')).toBeInTheDocument();
    expect(api.calls.at(-1)).toEqual({ channel: 'usage:summary', request: { period: '30d' } });
  });

  it('erreur IPC : message lisible, pas de plantage', async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
      'session:list': () => [],
    });
    api.handlers['usage:summary'] = () => {
      throw new FakeIpcFailure({ code: 'internal', message: 'Canal interdit', retryable: false });
    };
    render(<App />);
    const sidebar = await screen.findByRole('navigation', { name: 'Barre latérale' });
    await user.click(within(sidebar).getByRole('button', { name: 'Réglages' }));
    await user.click(screen.getByRole('button', { name: 'Utilisation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Une erreur inattendue est survenue.',
    );
  });
});

describe('usageTotals / dailyBars', () => {
  it('additionne les modèles ; pas de débit ni de pic s’ils sont inconnus', () => {
    const totals = usageTotals([{ ...small, tokensPerSecond: undefined }]);
    expect(totals).toMatchObject({ turns: 10, inputTokens: 90_000, compactions: 0 });
    expect(totals.tokensPerSecond).toBeUndefined();
    expect(totals.peakContextRatio).toBeUndefined();
  });

  it('« Tout » : seulement les jours avec activité, tous modèles cumulés', () => {
    const bars = dailyBars(
      [
        { day: '2026-01-02', model: 'a', inputTokens: 1, outputTokens: 2, turns: 1 },
        { day: '2026-01-02', model: 'b', inputTokens: 10, outputTokens: 20, turns: 1 },
        { day: '2025-12-31', model: 'a', inputTokens: 5, outputTokens: 5, turns: 1 },
      ],
      'all',
      NOW,
    );
    expect(bars).toEqual([
      { day: '2025-12-31', inputTokens: 5, outputTokens: 5 },
      { day: '2026-01-02', inputTokens: 11, outputTokens: 22 },
    ]);
  });
});
