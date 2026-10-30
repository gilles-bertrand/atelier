// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, SessionSummary } from '@atelier/shared';
import { App } from '@renderer/App';
import { defaultTestSettings, installFakeApi, type FakeApi } from '@renderer/test/fake-api';
import type { TurnUsage, UsageEvent } from '../../../../common/usage';
import { gaugeState } from './ContextGauge';

const session: SessionSummary = {
  id: 's1',
  title: 'Récap',
  workspace: '/Users/test/Ventes',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:30:00.000Z',
};

const usage = (contextTokens: number | undefined, contextWindow?: number): TurnUsage => ({
  inputTokens: 1,
  outputTokens: 1,
  ...(contextTokens !== undefined ? { contextTokens } : {}),
  ...(contextWindow !== undefined ? { contextWindow } : {}),
});

describe('gaugeState', () => {
  it('vert sous 50 %, orange jusqu’à la compaction (75 %), rouge au-delà', () => {
    expect(gaugeState(usage(1966, 32_768))).toMatchObject({ tone: 'ok', percent: 6, label: '6 %' });
    expect(gaugeState(usage(16_000, 32_000)).tone).toBe('warning');
    expect(gaugeState(usage(23_999, 32_000)).tone).toBe('warning');
    expect(gaugeState(usage(24_000, 32_000))).toMatchObject({ tone: 'danger', percent: 75 });
    expect(gaugeState(usage(40_000, 32_000)).percent).toBe(100);
  });

  it('infobulle avec les tokens au format français', () => {
    expect(gaugeState(usage(12_400, 32_000)).tooltip).toBe(
      'Contexte : 12,4 k / 32 k tokens · compaction automatique à 75 %',
    );
  });

  it('états inconnus : avant la première réponse, fenêtre inconnue', () => {
    expect(gaugeState(undefined)).toEqual({
      tone: 'unknown',
      label: '—',
      tooltip: 'Le remplissage s’affichera après la première réponse',
    });
    expect(gaugeState(usage(undefined, 32_000)).label).toBe('—');
    expect(gaugeState(usage(5000))).toMatchObject({
      tone: 'unknown',
      tooltip: 'Fenêtre de contexte inconnue',
    });
  });
});

function setup(openUsage?: TurnUsage): FakeApi {
  return installFakeApi({
    'settings:get': () => defaultTestSettings({ onboardingCompleted: true }),
    'session:list': () => [session],
    // `usage` n'est pas encore dans le type de shared (L0) : réponse élargie.
    'session:open': () => ({
      session,
      messages: [],
      ...(openUsage ? { usage: openUsage } : {}),
    }),
    'agent:send': () => ({ turnId: 't1' }),
  });
}

async function open(): Promise<void> {
  const user = userEvent.setup();
  render(<App />);
  const recent = await screen.findByRole('list', { name: 'Conversations récentes' });
  await user.click(within(recent).getByText('Récap'));
  await screen.findByText('Que puis-je faire pour vous ?');
}

describe('jauge de contexte dans la saisie', () => {
  it('inconnue avant la première réponse, puis suit les events `usage` de la conversation', async () => {
    const api = setup();
    await open();
    const gauge = screen.getByRole('meter', { name: 'Remplissage du contexte' });
    expect(gauge).toHaveTextContent('—');
    expect(gauge).not.toHaveAttribute('aria-valuenow');
    expect(gauge).toHaveAttribute('title', 'Le remplissage s’affichera après la première réponse');

    const emitUsage = (sessionId: string, contextTokens: number): void => {
      const event: UsageEvent = {
        type: 'usage',
        sessionId,
        turnId: 't1',
        usage: usage(contextTokens, 32_000),
      };
      act(() => {
        api.emit('agent:event', event as unknown as AgentEvent);
      });
    };
    emitUsage('s1', 3200);
    expect(gauge).toHaveAttribute('aria-valuenow', '10');
    expect(gauge).toHaveAttribute('data-tone', 'ok');
    emitUsage('s1', 25_000);
    expect(gauge).toHaveAttribute('aria-valuenow', '78');
    expect(gauge).toHaveAttribute('data-tone', 'danger');
    // Une autre conversation ne touche pas cette jauge.
    emitUsage('autre', 1000);
    expect(gauge).toHaveAttribute('aria-valuenow', '78');
    // L'event n'ajoute rien au fil de la conversation.
    expect(screen.getByText('Que puis-je faire pour vous ?')).toBeInTheDocument();
  });

  it('reprend le dernier usage connu à la réouverture d’une conversation', async () => {
    setup(usage(16_384, 32_768));
    await open();
    const gauge = screen.getByRole('meter', { name: 'Remplissage du contexte' });
    expect(gauge).toHaveAttribute('aria-valuenow', '50');
    expect(gauge).toHaveTextContent('50 %');
    expect(gauge).toHaveAttribute('data-tone', 'warning');
  });
});
