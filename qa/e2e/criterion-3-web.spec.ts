/**
 * Critère d'acceptation 3 (docs/BRIEF.md) : à « Quelle est la dernière version
 * LTS de Node.js ? », l'agent fait web_search, lit au moins une source
 * (web_fetch, permission par domaine) et cite l'URL.
 *
 * Mock : faux modèle + faux SearXNG ; la lecture de la page passe par le vrai
 * web_fetch (réseau public), mais les assertions n'en dépendent pas.
 * Réel : qwen3.5 + SearXNG de la VM + Internet.
 */
import {
  autoApprove,
  conversationText,
  describeCalls,
  IS_REAL,
  openWorkspace,
  send,
  sessionToolCalls,
  waitForSandbox,
  waitForTurnEnd,
} from './support/app.js';
import { expect, test } from './support/fixture.js';
import { PROMPTS } from './support/scenarios.js';

test('critère 3 : recherche web, lecture d’une source et citation de l’URL', async ({
  atelier,
}, testInfo) => {
  const { page, workspace } = atelier;
  await openWorkspace(page);
  // SearXNG tourne dans la VM : en réel, on attend qu'elle soit prête.
  if (IS_REAL) await waitForSandbox(page);

  const permissions = autoApprove(page, workspace);
  await send(page, PROMPTS.node);
  await waitForTurnEnd(page);
  await permissions.stop();

  const calls = await sessionToolCalls(page);
  await testInfo.attach('tool-calls.txt', {
    body: describeCalls(calls),
    contentType: 'text/plain',
  });

  const search = calls.find((c) => c.toolName === 'web_search');
  expect(search, 'web_search doit être appelé').toBeDefined();
  expect(search?.status).toBe('success');

  const fetches = calls.filter((c) => c.toolName === 'web_fetch');
  expect(fetches.length, 'au moins une source lue avec web_fetch').toBeGreaterThan(0);
  // Permission demandée une fois par domaine (pas à chaque page du même domaine).
  const hosts = new Set(fetches.map((c) => new URL(String(c.input['url'])).hostname));
  const fetchAsks = permissions.records.filter((r) => /web|page|site|domaine/i.test(r.description));
  expect(fetchAsks.length).toBeGreaterThan(0);
  expect(fetchAsks.length).toBeLessThanOrEqual(hosts.size);

  // La réponse cite l'URL d'une source lue (ou au moins une URL de la recherche).
  const answer = await conversationText(page);
  const fetchedUrls = fetches.map((c) => String(c.input['url']));
  const cited = fetchedUrls.some((url) => answer.includes(new URL(url).hostname));
  expect(cited, `URL non citée. Réponse : ${answer.slice(-600)}`).toBe(true);
  await expect(page.getByText(/Sources/).first()).toBeVisible();

  if (IS_REAL) {
    expect(fetches.some((c) => c.status === 'success')).toBe(true);
    // Version paire, active LTS en octobre 2026 : 24 (Krypton) ; 26 n'entre en LTS qu'en octobre 2026.
    expect(answer).toMatch(/\b(v?2[46])(\.\d+)*/);
  }
});
