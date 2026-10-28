import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchPage, webFetchTool, type ResolveHost, type WebFetchOptions } from '../src/index.js';
import { fixture, makeContext } from './helpers.js';

const PUBLIC_IP = '93.184.216.34';
const DNS: Record<string, string[]> = {
  'journal.example': [PUBLIC_IP],
  'www.journal.example': [PUBLIC_IP],
  'rebind.example': ['192.168.1.1'],
  'mixed.example': [PUBLIC_IP, '10.0.0.1'],
};
const resolveHost: ResolveHost = (host) => {
  const found = DNS[host];
  return found ? Promise.resolve(found) : Promise.reject(new Error(`ENOTFOUND ${host}`));
};

const server = setupServer(
  http.get('https://journal.example/article', () =>
    HttpResponse.html(fixture('article.html'), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  ),
  http.get('https://journal.example/ua', ({ request }) =>
    HttpResponse.text(request.headers.get('user-agent') ?? ''),
  ),
  http.get('https://journal.example/old', () =>
    HttpResponse.redirect('https://www.journal.example/new', 301),
  ),
  http.get('https://www.journal.example/new', () =>
    HttpResponse.html(
      '<html><head><title>Nouvelle</title></head><body><p>Arrivé.</p></body></html>',
    ),
  ),
  http.get('https://journal.example/to-private', () =>
    HttpResponse.redirect('http://rebind.example/admin', 302),
  ),
  http.get('https://journal.example/to-file', () =>
    HttpResponse.redirect('file:///etc/passwd', 302),
  ),
  http.get('https://journal.example/loop', () =>
    HttpResponse.redirect('https://journal.example/loop', 302),
  ),
  http.get('https://journal.example/huge', () =>
    HttpResponse.html(
      `<html><body><article><h1>Gros</h1>${'<p>Lorem ipsum dolor sit amet. </p>'.repeat(4000)}</article></body></html>`,
    ),
  ),
  http.get(
    'https://journal.example/doc.pdf',
    () =>
      new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: { 'content-type': 'application/pdf' },
      }),
  ),
  http.get('https://journal.example/data.json', () => HttpResponse.json({ version: '24.11.0' })),
  http.get(
    'https://journal.example/latin1',
    () =>
      new HttpResponse(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
      }),
  ),
  http.get('https://journal.example/missing', () => new HttpResponse('nope', { status: 404 })),
  http.get('https://journal.example/slow', async () => {
    await new Promise((r) => setTimeout(r, 500));
    return HttpResponse.text('trop tard');
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const options: WebFetchOptions = { fetch: (input, init) => fetch(input, init), resolveHost };

describe('fetchPage', () => {
  it('extrait une page HTML en markdown', async () => {
    const page = await fetchPage('https://journal.example/article', options);
    expect(page.title).toMatch(/Node\.js 24/);
    expect(page.markdown).toContain('**Node.js 24**');
    expect(page.contentType).toBe('text/html');
  });

  it('envoie un User-Agent explicite', async () => {
    const page = await fetchPage('https://journal.example/ua', options);
    expect(page.markdown).toMatch(/Atelier\//);
  });

  it('suit les redirections publiques', async () => {
    const page = await fetchPage('https://journal.example/old', options);
    expect(page.url).toBe('https://www.journal.example/new');
    expect(page.markdown).toContain('Arrivé.');
  });

  it('refuse une redirection vers une adresse privée', async () => {
    await expect(fetchPage('https://journal.example/to-private', options)).rejects.toMatchObject({
      code: 'web/blocked_address',
    });
  });

  it('refuse une redirection vers un autre schéma', async () => {
    await expect(fetchPage('https://journal.example/to-file', options)).rejects.toMatchObject({
      code: 'web/blocked_address',
    });
  });

  it('borne le nombre de redirections', async () => {
    await expect(fetchPage('https://journal.example/loop', options)).rejects.toThrow(
      /Trop de redirections/,
    );
  });

  it.each([
    'http://127.0.0.1/',
    'http://localhost.example.invalid/',
    'http://[::1]:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://rebind.example/',
    'http://mixed.example/',
  ])('refuse %s sans le contacter', async (url) => {
    const spy = vi.fn(options.fetch);
    await expect(fetchPage(url, { ...options, fetch: spy })).rejects.toMatchObject({
      code: expect.stringMatching(/^web\/(blocked_address|fetch_failed)$/) as unknown,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuse les types non textuels', async () => {
    await expect(fetchPage('https://journal.example/doc.pdf', options)).rejects.toThrow(
      /application\/pdf/,
    );
  });

  it('accepte le JSON et décode le latin-1', async () => {
    expect((await fetchPage('https://journal.example/data.json', options)).markdown).toContain(
      '24.11.0',
    );
    expect((await fetchPage('https://journal.example/latin1', options)).markdown).toBe('café');
  });

  it('signale les erreurs HTTP', async () => {
    await expect(fetchPage('https://journal.example/missing', options)).rejects.toMatchObject({
      code: 'web/fetch_failed',
      message: expect.stringContaining('404') as unknown,
    });
  });

  it('applique le délai', async () => {
    await expect(
      fetchPage('https://journal.example/slow', { ...options, timeoutMs: 50 }),
    ).rejects.toThrow(/Délai dépassé/);
  });
});

describe('web_fetch', () => {
  const tool = webFetchTool(options);

  it('demande la permission par domaine puis renvoie le markdown', async () => {
    const { context, requestPermission } = makeContext('allow_session');
    const out = await tool.execute({ url: 'https://www.journal.example/new' }, context);
    expect(out.ok).toBe(true);
    expect(out.content).toMatch(/^# Nouvelle\nURL : https:\/\/www\.journal\.example\/new/);
    expect(out.display).toEqual({
      type: 'web_page',
      url: 'https://www.journal.example/new',
      title: 'Nouvelle',
    });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'web_fetch',
      kind: 'network',
      title: 'Consulter le site journal.example',
      scopeKey: 'web_fetch:journal.example',
      sessionId: 'session-1',
      toolCallId: 'call-1',
    });
  });

  it('tronque le contenu à 20 ko', async () => {
    const { context } = makeContext();
    const out = await tool.execute({ url: 'https://journal.example/huge' }, context);
    expect(out.ok).toBe(true);
    expect(new TextEncoder().encode(out.content).length).toBeLessThanOrEqual(20 * 1024 + 64);
    expect(out.content).toMatch(/contenu tronqué à 20 ko\]$/);
  });

  it('un refus renvoie denied sans requête réseau', async () => {
    const spy = vi.fn(options.fetch);
    const { context } = makeContext('deny');
    const out = await webFetchTool({ ...options, fetch: spy }).execute(
      { url: 'https://journal.example/article' },
      context,
    );
    expect(out).toMatchObject({ ok: false, denied: true });
    expect(out.content).toMatch(/refusé/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('un gestionnaire de permission en échec vaut refus', async () => {
    const { context } = makeContext(() => Promise.reject(new Error('fenêtre fermée')));
    const out = await tool.execute({ url: 'https://journal.example/article' }, context);
    expect(out).toMatchObject({ ok: false, denied: true });
  });

  it('refuse un schéma non http sans demander la permission', async () => {
    const { context, requestPermission } = makeContext();
    const out = await tool.execute({ url: 'file:///etc/passwd' }, context);
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/Schéma refusé/);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('renvoie les erreurs au modèle sans lever', async () => {
    const { context } = makeContext();
    const out = await tool.execute({ url: 'http://rebind.example/' }, context);
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/adresse locale ou privée/);
  });

  it('propage l’annulation du tour', async () => {
    const { context, controller } = makeContext();
    const pending = tool.execute({ url: 'https://journal.example/slow' }, context);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('décrit la permission pour l’UI', () => {
    expect(tool.describePermission?.({ url: 'https://www.example.org/x' })).toMatchObject({
      kind: 'network',
      scopeKey: 'web_fetch:example.org',
    });
  });
});
