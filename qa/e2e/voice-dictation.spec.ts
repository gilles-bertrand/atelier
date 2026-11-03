/**
 * Dictée, e2e mock (ADR-004 L5, ticket #31) : faux moteur de voix, faux micro
 * et faux LLM (voir `support/voice.ts`). Vérifie la chaîne complète de l'app :
 * bouton micro, capture et trames `voice:audio`, relais du main, session du
 * worker, texte en direct puis final inséré au curseur, envoi, réponse.
 *
 * Le mode réel (vrai Parakeet, micro simulé par un WAV) est dans
 * `voice-dictation.real.spec.ts`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './support/fixture.js';
import { IS_REAL, openWorkspace, waitForTurnEnd } from './support/app.js';
import { textOf } from './support/mock-llm.js';
import { VOICE_PROMPT, VOICE_REPLY } from './support/scenarios.js';
import {
  announcer,
  composer,
  fakeMicInPage,
  grantMicStatus,
  installFakeParakeet,
  MIC_START,
  stageBundledVad,
  startDictation,
  stopDictation,
  useFakeVoiceEngine,
  VOICE_MODE,
} from './support/voice.js';

test.skip(IS_REAL || VOICE_MODE === 'real', 'faux moteur de voix : mode mock seulement');

test.beforeAll(async () => {
  // Avant le lancement : l'app vérifie le Silero embarqué une fois, au premier état lu.
  await stageBundledVad();
});

test('dicte une phrase, l’insère, l’envoie et reçoit la réponse', async ({ atelier, llm }) => {
  const { app, page, userData } = atelier;
  await installFakeParakeet(userData);
  await grantMicStatus(app);
  await useFakeVoiceEngine(app, VOICE_PROMPT);
  await openWorkspace(page);
  await fakeMicInPage(page);

  await startDictation(page);
  // Premier segment, affiché en direct pendant l'écoute.
  await expect(composer(page)).toHaveValue(/^Résume en trois points/);
  const latencyMs = await stopDictation(page);
  await expect(composer(page)).toHaveValue(VOICE_PROMPT);
  await expect(announcer(page)).toHaveText('Dictée terminée, texte inséré.');
  test
    .info()
    .annotations.push({ type: 'stop → texte inséré (ms)', description: String(latencyMs) });

  // F1 : le texte dicté n'est jamais envoyé tout seul.
  await page.waitForTimeout(500);
  expect(llm.requests).toHaveLength(0);

  await page.getByRole('button', { name: 'Envoyer' }).click();
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText(VOICE_PROMPT, { exact: true }).first()).toBeVisible();
  await waitForTurnEnd(page);
  await expect(log.getByText(VOICE_REPLY)).toBeVisible();

  // Le modèle a reçu la phrase dictée comme un message tapé.
  const chat = llm.requests.find((r) => r.scenario === 'dictée');
  const lastUser = chat?.messages.filter((m) => m.role === 'user').at(-1);
  expect(textOf(lastUser?.content)).toBe(VOICE_PROMPT);

  // Première dictée : la voix est activée dans les réglages.
  const settings = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as {
    voice?: { enabled: boolean };
  };
  expect(settings.voice?.enabled).toBe(true);
});

test('Échap annule la dictée et rend le texte d’origine', async ({ atelier, llm }) => {
  const { app, page, userData } = atelier;
  await installFakeParakeet(userData);
  await grantMicStatus(app);
  await useFakeVoiceEngine(app, VOICE_PROMPT);
  await openWorkspace(page);
  await fakeMicInPage(page);

  await composer(page).fill('Bonjour,');
  await startDictation(page);
  await expect(composer(page)).toHaveValue(/^Bonjour, Résume en trois points/);
  await page.keyboard.press('Escape');
  await expect(announcer(page)).toHaveText('Dictée annulée, texte dicté retiré.');
  await expect(composer(page)).toHaveValue('Bonjour,');
  await expect(page.getByRole('button', { name: MIC_START })).toBeVisible();
  expect(llm.requests).toHaveLength(0);
});

test('sans modèle installé, le micro propose le téléchargement', async ({ atelier }) => {
  const { app, page } = atelier;
  await grantMicStatus(app);
  await useFakeVoiceEngine(app, VOICE_PROMPT);
  await openWorkspace(page);

  await page.getByRole('button', { name: MIC_START }).click();
  const card = page.getByRole('region', { name: 'Modèle de reconnaissance vocale' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Télécharger' })).toBeVisible();
  await expect(composer(page)).toHaveValue('');
});
