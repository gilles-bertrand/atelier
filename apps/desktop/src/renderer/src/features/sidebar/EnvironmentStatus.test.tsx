// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SandboxStatus, ServerStatus } from '@atelier/shared';
import { installFakeApi, type FakeApi } from '@renderer/test/fake-api';
import { EnvironmentStatus } from './EnvironmentStatus';

const LIMA_ERROR =
  'Impossible de démarrer la VM : exiting, status={Running:false Degraded:false Exiting:true}';
const server: ServerStatus = {
  health: 'connected',
  latencyMs: 67,
  checkedAt: '2026-10-31T11:00:00.000Z',
};

let api: FakeApi;
let release: () => void;

beforeEach(() => {
  api = installFakeApi({
    'sandbox:ensure-ready': () =>
      new Promise<undefined>((resolve) => {
        release = () => {
          resolve(undefined);
        };
      }),
  });
});

async function open(sandbox: SandboxStatus) {
  const user = userEvent.setup();
  render(
    <EnvironmentStatus session={undefined} sandbox={sandbox} server={server} model="qwen3.5:35b" />,
  );
  await user.click(screen.getByRole('button', { name: /Environnement/ }));
  return user;
}

describe('EnvironmentStatus : machine isolée indisponible', () => {
  it('message en français, détail technique replié, et relance', async () => {
    const user = await open({ state: 'error', networkEnabled: false, error: LIMA_ERROR });
    expect(screen.getByText('La machine isolée n’a pas pu démarrer.')).toBeInTheDocument();
    expect(screen.getByText(LIMA_ERROR)).not.toBeVisible();
    await user.click(screen.getByText('Détails techniques'));
    expect(screen.getByText(LIMA_ERROR)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Redémarrer la machine isolée' }));
    expect(api.callsTo('sandbox:ensure-ready')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Démarrage…' })).toBeDisabled();
    release();
    expect(
      await screen.findByRole('button', { name: 'Redémarrer la machine isolée' }),
    ).toBeEnabled();
  });

  it('relance aussi une machine arrêtée', async () => {
    await open({ state: 'stopped', networkEnabled: false });
    expect(
      screen.getByRole('button', { name: 'Redémarrer la machine isolée' }),
    ).toBeInTheDocument();
  });

  it('pas de relance quand la machine est prête ou démarre', async () => {
    await open({ state: 'ready', networkEnabled: false });
    expect(screen.queryByRole('button', { name: /Redémarrer/ })).not.toBeInTheDocument();
  });
});
