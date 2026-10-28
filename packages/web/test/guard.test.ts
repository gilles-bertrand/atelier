/**
 * Garde à la connexion TCP (sans msw) : même si la vérification préalable est
 * trompée (DNS rebinding), le `fetch` par défaut refuse de se connecter à une
 * adresse locale.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGuardedLookup, fetchPage } from '../src/index.js';

let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end('<html><body>secret local</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('garde réseau à la connexion', () => {
  it('le lookup filtré refuse localhost', async () => {
    const lookup = createGuardedLookup();
    const error = await new Promise<unknown>((resolve) => {
      lookup('localhost', {}, (err) => {
        resolve(err);
      });
    });
    expect(error).toMatchObject({ code: 'web/blocked_address' });
  });

  it('le fetch par défaut refuse un nom qui se résout en loopback (rebinding)', async () => {
    // La vérification préalable croit à une IP publique ; la connexion, elle, résout localhost.
    await expect(
      fetchPage(`http://localhost:${port}/`, {
        resolveHost: () => Promise.resolve(['93.184.216.34']),
      }),
    ).rejects.toMatchObject({ code: 'web/blocked_address' });
    expect(hits).toBe(0);
  });

  it('le fetch par défaut refuse une IP littérale locale', async () => {
    await expect(fetchPage(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: 'web/blocked_address',
    });
    expect(hits).toBe(0);
  });
});
