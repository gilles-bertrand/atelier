// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '@renderer/App';
import { defaultTestSettings, installFakeApi } from '@renderer/test/fake-api';
import { ServerStatusBadge, serverStatusText } from './ServerStatusBadge';

describe('ServerStatusBadge', () => {
  it('affiche santé et latence', () => {
    render(<ServerStatusBadge status={{ health: 'slow', latencyMs: 2400, checkedAt: '' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Serveur lent (2400 ms)');
    expect(serverStatusText({ health: 'offline', latencyMs: 10, checkedAt: '' })).toBe(
      'Serveur hors ligne',
    );
  });

  it('suit les événements llm:status une fois l’onboarding fait', async () => {
    const api = installFakeApi({
      'settings:get': () =>
        defaultTestSettings({
          onboardingCompleted: true,
          llm: { baseUrl: 'https://x.fr', model: 'm', thinking: true },
        }),
    });
    render(<App />);
    expect(await screen.findByText('Serveur : vérification…')).toBeInTheDocument();
    api.emit('llm:status', { health: 'connected', latencyMs: 90, checkedAt: '' });
    expect(screen.getByText('Serveur connecté (90 ms)')).toBeInTheDocument();
  });
});
