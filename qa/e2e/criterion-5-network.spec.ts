/**
 * Critère d'acceptation 5 (docs/BRIEF.md) : `curl https://example.com` lancé
 * par l'agent dans la VM échoue tant que le réseau n'est pas autorisé, puis
 * réussit une fois l'interrupteur « Internet pour les commandes » activé (pied de la
 * colonne de gauche, section Environnement).
 *
 * Mode réel uniquement : sans VM (CI), il n'y a rien à bloquer. En mock, on
 * vérifie seulement que la commande n'est jamais exécutée hors VM.
 */
import {
  autoApprove,
  describeCalls,
  IS_REAL,
  openWorkspace,
  sandboxStatus,
  send,
  sessionToolCalls,
  sidebar,
  waitForSandbox,
  waitForTurnEnd,
} from './support/app.js';
import { expect, test } from './support/fixture.js';
import { PROMPTS } from './support/scenarios.js';

test('critère 5 : curl échoue dans la VM tant que le réseau est coupé', async ({
  atelier,
}, testInfo) => {
  const { page, workspace } = atelier;
  await openWorkspace(page);

  if (!IS_REAL) {
    await send(page, PROMPTS.network);
    await waitForTurnEnd(page);
    const curl = (await sessionToolCalls(page)).find((c) => c.toolName === 'bash');
    // Pas de VM : refus explicite, jamais d'exécution sur l'hôte.
    expect(curl?.status).toBe('error');
    expect(curl?.output).toMatch(/machine virtuelle/);
    return;
  }

  await waitForSandbox(page);
  expect((await sandboxStatus(page)).networkEnabled).toBe(false);

  // 1. Réseau coupé : la commande échoue.
  let permissions = autoApprove(page, workspace);
  await send(page, PROMPTS.network);
  await waitForTurnEnd(page);
  await permissions.stop();
  let calls = await sessionToolCalls(page);
  await testInfo.attach('tool-calls-blocked.txt', {
    body: describeCalls(calls),
    contentType: 'text/plain',
  });
  const blocked = calls.filter(
    (c) => c.toolName === 'bash' && String(c.input['command']).includes('curl'),
  );
  expect(blocked.length).toBeGreaterThan(0);
  for (const call of blocked) expect(call.output ?? '').not.toContain('Example Domain');

  // 2. Interrupteur de l'Environnement (pied de la colonne de gauche, à déplier)
  //    activé : la même commande réussit.
  const environment = (await sidebar(page)).getByRole('button', { name: /Environnement/ });
  if ((await environment.getAttribute('aria-expanded')) !== 'true') await environment.click();
  const toggle = page.getByRole('switch', { name: 'Internet pour les commandes' });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  permissions = autoApprove(page, workspace);
  await send(page, `${PROMPTS.network} à nouveau, le réseau est maintenant autorisé`);
  await waitForTurnEnd(page);
  await permissions.stop();
  calls = await sessionToolCalls(page);
  await testInfo.attach('tool-calls-allowed.txt', {
    body: describeCalls(calls),
    contentType: 'text/plain',
  });
  const allowed = calls
    .filter((c) => c.toolName === 'bash' && String(c.input['command']).includes('curl'))
    .slice(blocked.length);
  expect(allowed.some((c) => (c.output ?? '').includes('Example Domain'))).toBe(true);

  // 3. Coupé de nouveau à la fin (pas d'effet de bord sur la VM partagée).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});
