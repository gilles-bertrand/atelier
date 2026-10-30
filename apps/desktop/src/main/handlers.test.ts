import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWorkspace,
  createHandlers,
  isWithin,
  tokenForConnectionTest,
  type HandlerServices,
} from './handlers.js';
import { InMemoryUsageStore } from './runtime/usage-store.js';

describe('isWithin', () => {
  it('reconnaît les chemins internes et refuse les sorties', () => {
    expect(isWithin('/w', '/w/a/b.txt')).toBe(true);
    expect(isWithin('/w', '/w')).toBe(true);
    expect(isWithin('/w', '/w/../etc/passwd')).toBe(false);
    expect(isWithin('/w', '/wx/a')).toBe(false);
    expect(isWithin('/w', '/w/..secret')).toBe(true);
  });
});

describe('assertWorkspace', () => {
  it('refuse la racine, le $HOME entier et un fichier', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-home-'));
    await expect(assertWorkspace('/', home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    await expect(assertWorkspace(home, home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    const file = join(home, 'f.txt');
    await writeFile(file, '');
    await expect(assertWorkspace(file, home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    await expect(assertWorkspace('relatif', home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    expect(await assertWorkspace(tmpdir(), home)).toBeTruthy();
  });
});

describe('llm:test-connection : le token enregistré ne quitte pas son serveur', () => {
  const setup = () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetchSpy = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return Promise.resolve(
        new Response(JSON.stringify({ version: '0.40.11', models: [], data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const s = {
      settings: {
        get: () => ({ llm: { baseUrl: 'https://llm.exemple.fr', model: 'm', thinking: true } }),
      },
      secrets: { get: () => 'jeton-enregistre' },
      fetch: fetchSpy,
    } as unknown as HandlerServices;
    return { handlers: createHandlers(s), seen };
  };

  it('autre origine sans token : aucun en-tête Authorization', async () => {
    const { handlers, seen } = setup();
    await handlers['llm:test-connection']?.({ baseUrl: 'https://attaquant.example' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.url.startsWith('https://attaquant.example'))).toBe(true);
    expect(seen.map((r) => r.authorization)).toEqual(seen.map(() => null));
  });

  it('même origine : token enregistré ; token fourni : toujours prioritaire', async () => {
    const same = setup();
    await same.handlers['llm:test-connection']?.({ baseUrl: 'https://LLM.exemple.fr/' });
    expect(same.seen[0]?.authorization).toBe('Bearer jeton-enregistre');
    const provided = setup();
    await provided.handlers['llm:test-connection']?.({
      baseUrl: 'https://autre.example',
      token: 'saisi',
    });
    expect(provided.seen[0]?.authorization).toBe('Bearer saisi');
  });

  it('tokenForConnectionTest compare les origines (schéma, hôte, port)', () => {
    const base = { providedToken: undefined, savedUrl: 'https://llm.fr', savedToken: 't' };
    expect(tokenForConnectionTest({ ...base, requestedUrl: 'https://llm.fr/v1' })).toBe('t');
    expect(tokenForConnectionTest({ ...base, requestedUrl: 'http://llm.fr' })).toBeUndefined();
    expect(
      tokenForConnectionTest({ ...base, requestedUrl: 'https://llm.fr:8443' }),
    ).toBeUndefined();
    expect(
      tokenForConnectionTest({ ...base, requestedUrl: 'https://llm.fr.evil.io' }),
    ).toBeUndefined();
    expect(tokenForConnectionTest({ ...base, requestedUrl: 'pas une url' })).toBeUndefined();
    expect(
      tokenForConnectionTest({ ...base, savedUrl: '', requestedUrl: 'https://llm.fr' }),
    ).toBeUndefined();
  });
});

describe('app:health', () => {
  it('relaie l’état de démarrage du main', async () => {
    const s = {
      health: () => ({ historyPersistent: false, historyError: 'disk I/O error' }),
    } as unknown as HandlerServices;
    expect(await createHandlers(s)['app:health']?.(undefined)).toEqual({
      historyPersistent: false,
      historyError: 'disk I/O error',
    });
    expect(await createHandlers({} as HandlerServices)['app:health']?.(undefined)).toEqual({
      historyPersistent: true,
    });
  });
});

describe('attachment:import', () => {
  it('copie les fichiers dans .atelier/uploads avec le type détecté', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'atelier-ws-'));
    const source = join(await mkdtemp(join(tmpdir(), 'atelier-src-')), 'facture.pdf');
    await writeFile(source, '%PDF-1.4\n%test\n');
    const s = {
      chats: {
        open: () => ({
          session: { id: 's', title: '', workspace, createdAt: '', updatedAt: '' },
          messages: [],
        }),
      },
    } as unknown as HandlerServices;
    const [attachment] =
      (await createHandlers(s)['attachment:import']?.({ sessionId: 's', hostPaths: [source] })) ??
      [];
    expect(attachment).toMatchObject({
      path: '.atelier/uploads/facture.pdf',
      name: 'facture.pdf',
      mimeType: 'application/pdf',
    });
  });
});

describe('usage:summary', () => {
  it('renvoie les agrégats du registre, ou des statistiques vides sans registre', async () => {
    const usage = new InMemoryUsageStore();
    usage.record({
      turnId: 't1',
      sessionId: 's1',
      model: 'qwen3.5:35b',
      outcome: 'stop',
      day: '2999-01-01',
      steps: 1,
      inputTokens: 100,
      outputTokens: 10,
      contextTokens: undefined,
      contextWindow: undefined,
      generationMs: 0,
      compactions: 0,
      relaunches: {},
      createdAt: '2999-01-01T00:00:00.000Z',
    });
    const withStore = createHandlers({ usage } as unknown as HandlerServices);
    expect(await withStore['usage:summary']?.({ period: 'all' })).toMatchObject({
      period: 'all',
      models: [{ model: 'qwen3.5:35b', turns: 1, inputTokens: 100 }],
    });
    const without = createHandlers({} as unknown as HandlerServices);
    expect(await without['usage:summary']?.({ period: '7d' })).toEqual({
      period: '7d',
      models: [],
      daily: [],
    });
  });
});
