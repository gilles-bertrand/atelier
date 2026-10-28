// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '@renderer/App';
import { defaultTestSettings, installFakeApi } from '@renderer/test/fake-api';

const done = () => defaultTestSettings({ onboardingCompleted: true });

describe('bandeau historique', () => {
  it('prévient quand l’historique ne sera pas conservé', async () => {
    installFakeApi({
      'settings:get': done,
      'app:health': () => ({ historyPersistent: false, historyError: 'SQLITE_CANTOPEN' }),
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'L’historique ne sera pas conservé.',
    );
    // Le détail technique n'est pas affiché tel quel.
    expect(screen.queryByText(/SQLITE_CANTOPEN/)).not.toBeInTheDocument();
  });

  it('ne s’affiche pas quand l’historique est enregistré', async () => {
    installFakeApi({ 'settings:get': done });
    render(<App />);
    expect(await screen.findByText('Sur quoi travaille-t-on ?')).toBeInTheDocument();
    expect(screen.queryByText(/ne sera pas conservé/)).not.toBeInTheDocument();
  });
});
