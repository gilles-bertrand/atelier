import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchAtelier, openWorkspace } from './support/app.js';
import { startMockLlm } from './support/mock-llm.js';

test('démarre sur l’accueil avec les réglages de test et ouvre une conversation', async () => {
  const llm = await startMockLlm([]);
  const atelier = await launchAtelier({ llmUrl: llm.url, model: 'atelier' });
  try {
    const { page } = atelier;
    await expect(page.getByRole('heading', { name: 'Sur quoi travaille-t-on ?' })).toBeVisible();
    const userData = await atelier.app.evaluate(({ app }) => app.getPath('userData'));
    expect(userData).toBe(atelier.userData);
    const settings = JSON.parse(
      await readFile(join(atelier.userData, 'settings.json'), 'utf8'),
    ) as {
      llm: { baseUrl: string };
    };
    expect(settings.llm.baseUrl).toBe(llm.url);
    await openWorkspace(page);
  } finally {
    await atelier.close();
    await llm.close();
  }
});
