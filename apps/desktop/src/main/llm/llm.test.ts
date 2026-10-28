import { describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '@atelier/shared';
import { ServerMonitor } from './server-monitor.js';

const status = (health: ServerStatus['health'], latencyMs?: number): ServerStatus => ({
  health,
  checkedAt: '2026-10-28T10:00:00.000Z',
  ...(latencyMs !== undefined ? { latencyMs } : {}),
});

describe('ServerMonitor', () => {
  it('notifie les changements et replanifie plus vite hors ligne', async () => {
    const changes: string[] = [];
    const delays: number[] = [];
    let next = status('connected', 120);
    const monitor = new ServerMonitor({
      target: () => ({ baseUrl: 'https://x.fr', token: 't' }),
      probe: () => Promise.resolve(next),
      onChange: (s, prev) => changes.push(`${prev.health}→${s.health}`),
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return ms;
      },
      clearTimer: vi.fn(),
    });
    monitor.start();
    await vi.waitFor(() => {
      expect(changes).toHaveLength(1);
    });
    next = status('offline');
    await monitor.check();
    expect(changes).toEqual(['unknown→connected', 'connected→offline']);
    expect(delays).toEqual([30_000, 10_000]);
  });

  it('ne replanifie pas tant qu’il n’est pas démarré et traite un rejet comme hors ligne', async () => {
    const setTimer = vi.fn();
    const monitor = new ServerMonitor({
      target: () => ({ baseUrl: 'https://x.fr' }),
      probe: () => Promise.reject(new Error('down')),
      onChange: vi.fn(),
      setTimer,
    });
    expect((await monitor.check()).health).toBe('offline');
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('reste « inconnu » sans serveur configuré', async () => {
    const probe = vi.fn();
    const monitor = new ServerMonitor({ target: () => undefined, probe, onChange: vi.fn() });
    expect((await monitor.check()).health).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
  });
});
