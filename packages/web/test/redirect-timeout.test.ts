/**
 * Le délai de téléchargement est suspendu pendant la demande de permission
 * d'une redirection (faux timers, `fetch` injecté : pas de réseau, pas de msw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionHandler } from '@atelier/shared';
import { PausableTimeout, webFetchTool, type FetchLike } from '../src/index.js';
import { makeContext } from './helpers.js';

const fakeFetch: FetchLike = (input, init) => {
  // Comme un vrai fetch : un signal déjà annulé (délai ou stop) fait échouer la requête.
  if (init?.signal?.aborted) return Promise.reject(init.signal.reason as Error);
  if (input === 'https://depart.example/') {
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: 'https://arrivee.example/' } }),
    );
  }
  return Promise.resolve(
    new Response('<html><head><title>Arrivée</title></head><body><p>Bonjour.</p></body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  );
};
const tool = webFetchTool({
  fetch: fakeFetch,
  resolveHost: () => Promise.resolve(['93.184.216.34']),
  timeoutMs: 20_000,
});

/** Modale qui accepte le domaine de départ tout de suite et répond à l'autre après `delayMs`. */
function slowModal(delayMs: number): PermissionHandler {
  return (request, signal) => {
    if (request.scopeKey === 'web_fetch:depart.example') return Promise.resolve('allow_once');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve('allow_once');
      }, delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      });
    });
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('délai et permission de redirection', () => {
  it('une modale de 30 s ne fait pas échouer la lecture', async () => {
    const { context } = makeContext(slowModal(30_000));
    const pending = tool.execute({ url: 'https://depart.example/' }, context);
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(out.content).toContain('Bonjour.');
  });

  it('le bouton stop reste actif pendant la modale', async () => {
    const { context, controller } = makeContext(slowModal(30_000));
    const pending = tool.execute({ url: 'https://depart.example/' }, context);
    const settled = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await settled;
  });
});

describe('PausableTimeout', () => {
  it('ne décompte pas pendant la pause', async () => {
    const timeout = new PausableTimeout(1_000);
    await vi.advanceTimersByTimeAsync(600);
    timeout.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timeout.signal.aborted).toBe(false);
    timeout.resume();
    await vi.advanceTimersByTimeAsync(399);
    expect(timeout.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timeout.signal.aborted).toBe(true);
  });

  it('clear() arrête le décompte', async () => {
    const timeout = new PausableTimeout(100);
    timeout.clear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timeout.signal.aborted).toBe(false);
  });
});
