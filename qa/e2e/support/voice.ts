/**
 * Aides des e2e de la dictée (ADR-004 L5, ticket #31).
 *
 * Deux moteurs :
 * - **mock** (CI) : le worker de reconnaissance est remplacé par
 *   `fake-voice-worker.mjs`, le modèle Parakeet est « installé » par un
 *   manifeste et des fichiers creux de la bonne taille, et le micro est une
 *   sinusoïde WebAudio injectée dans la page. Ni modèle, ni micro, ni invite
 *   macOS : le test tourne sur un runner sans carte son.
 * - **réel** (`ATELIER_E2E_VOICE=real`, local) : le vrai worker sherpa-onnx et
 *   Parakeet importé hors ligne depuis une archive locale ; le micro est un
 *   fichier WAV lu par Chromium (`--use-fake-device-for-media-stream`).
 *
 * Dans les deux cas, l'app lancée est `out/main` sous `--user-data-dir` : pas
 * de VM (ticket #41), et le vrai LLM n'est jamais appelé (faux serveur).
 *
 * Micro (macOS) : l'app lit l'autorisation par `systemPreferences` avant
 * d'ouvrir la capture. On fixe cette lecture à `granted` dans le process de
 * test : la base TCC n'est ni lue ni modifiée, et le vrai micro n'est jamais
 * ouvert (sinusoïde en mock, faux périphérique de Chromium en réel). Aucune
 * invite macOS ne s'affiche donc.
 */
import { copyFile, mkdir, truncate, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { DESKTOP_DIR, REPO_ROOT } from './app.js';

export const VOICE_MODE: 'mock' | 'real' =
  process.env['ATELIER_E2E_VOICE'] === 'real' ? 'real' : 'mock';

/** Parakeet TDT 0.6B v3 int8, tel qu'épinglé dans `packages/voice/src/catalog.ts`. */
export const PARAKEET = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  version: '2025-08-16',
  sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
  archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
  files: [
    { path: 'encoder.int8.onnx', bytes: 652_184_281 },
    { path: 'decoder.int8.onnx', bytes: 11_845_275 },
    { path: 'joiner.int8.onnx', bytes: 6_355_277 },
    { path: 'tokens.txt', bytes: 93_939 },
    { path: 'test_wavs/de.wav', bytes: 121_388 },
    { path: 'test_wavs/en.wav', bytes: 184_608 },
    { path: 'test_wavs/es.wav', bytes: 235_052 },
    { path: 'test_wavs/fr.wav', bytes: 219_180 },
  ],
} as const;

export const SILERO_FILE = 'silero_vad.onnx';
export const FAKE_WORKER = join(import.meta.dirname, 'fake-voice-worker.mjs');

/** Libellés du bouton micro du Composer (raccourci ⌘⇧D). */
export const MIC_START = /^Dicter \(/;
export const MIC_STOP = /^Terminer la dictée \(/;

/**
 * Silero VAD embarqué, là où l'app lancée depuis `out/main` le cherche
 * (`app.getAppPath()/resources/voice`). Le fichier vient de
 * `apps/desktop/resources/voice` (`pnpm fetch:voice`), téléchargé et vérifié
 * par SHA-256 s'il manque (CI) : 629 Kio.
 */
export async function stageBundledVad(): Promise<void> {
  const source = join(DESKTOP_DIR, 'resources', 'voice');
  if (!existsSync(join(source, SILERO_FILE))) {
    const script = join(REPO_ROOT, 'scripts', 'fetch-voice-models.ts');
    const { fetchVoiceModels } = (await import(script)) as {
      fetchVoiceModels: (dest: string) => Promise<void>;
    };
    await fetchVoiceModels(source);
  }
  const target = join(DESKTOP_DIR, 'out', 'main', 'resources', 'voice');
  await mkdir(target, { recursive: true });
  await copyFile(join(source, SILERO_FILE), join(target, SILERO_FILE));
}

/**
 * Mock : Parakeet « installé » sans ses 690 Mo. Le gestionnaire de modèles ne
 * relit que le manifeste et la taille des fichiers (l'empreinte est contrôlée
 * à l'installation) : des fichiers creux de la bonne taille suffisent, et le
 * faux worker ne les ouvre jamais.
 */
export async function installFakeParakeet(userData: string): Promise<void> {
  const dir = join(userData, 'models', 'voice', `${PARAKEET.id}@${PARAKEET.version}`);
  await mkdir(join(dir, 'test_wavs'), { recursive: true });
  for (const file of PARAKEET.files) {
    const path = join(dir, file.path);
    await writeFile(path, '');
    await truncate(path, file.bytes);
  }
  const manifest = {
    id: PARAKEET.id,
    version: PARAKEET.version,
    sha256: PARAKEET.sha256,
    origin: 'import',
    installedAt: new Date().toISOString(),
    files: PARAKEET.files,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Autorisation du micro lue par l'app : `granted` (voir l'en-tête). */
export async function grantMicStatus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ systemPreferences }) => {
    systemPreferences.getMediaAccessStatus = () => 'granted';
  });
}

/**
 * Mock : chaque lancement du worker de reconnaissance (`utilityProcess.fork`)
 * lance le faux worker, qui rendra `text` si l'audio arrive bien.
 */
export async function useFakeVoiceEngine(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(
    ({ utilityProcess }, { script, text: spoken }) => {
      const fork = utilityProcess.fork.bind(utilityProcess);
      utilityProcess.fork = (_modulePath, _args, options) => fork(script, [spoken], options);
    },
    { script: FAKE_WORKER, text },
  );
}

/**
 * Mock : `getUserMedia` rend une sinusoïde de 440 Hz (WebAudio) au lieu du
 * micro. Le reste de la chaîne est le vrai : `AudioContext` à 16 kHz, worklet
 * de capture, trames `voice:audio`, relais du main.
 */
export async function fakeMicInPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const devices = navigator.mediaDevices;
    devices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 16_000 });
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const gain = context.createGain();
      gain.gain.value = 0.2;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
}

export function composer(page: Page) {
  return page.getByRole('textbox', { name: 'Votre message' });
}

/** Annonce de la dictée (lecteur d'écran) : phase en cours, puis bilan. */
export function announcer(page: Page) {
  return page.getByTestId('voice-announcer');
}

/** Démarre la dictée au bouton micro et attend l'écoute (chronomètre affiché). */
export async function startDictation(page: Page): Promise<void> {
  await page.getByRole('button', { name: MIC_START }).click();
  await expect(page.getByRole('button', { name: MIC_STOP })).toBeVisible();
  await expect(page.getByTestId('voice-timer')).toBeVisible();
}

/**
 * Termine la dictée et attend le texte final dans le champ. Rend le délai entre
 * le clic sur « Terminer » et l'annonce « texte inséré », en ms.
 */
export async function stopDictation(page: Page, timeout = 10_000): Promise<number> {
  const stopButton = page.getByRole('button', { name: MIC_STOP });
  const t0 = Date.now();
  await stopButton.click();
  await expect(announcer(page)).toHaveText(/Dictée terminée/, { timeout });
  const elapsed = Date.now() - t0;
  await expect(page.getByRole('button', { name: MIC_START })).toBeVisible();
  return elapsed;
}

/**
 * Mémoire du worker de reconnaissance (`app.getAppMetrics`), ou `undefined`
 * s'il ne tourne pas. Il s'y nomme « YodAI Voice » (`serviceName` du fork ;
 * le champ `serviceName` de la métrique vaut `node.mojom.NodeService`).
 */
export async function voiceWorkerMemory(
  app: ElectronApplication,
): Promise<{ pid: number; workingSetBytes: number } | undefined> {
  return app.evaluate(({ app: electronApp }) => {
    const metric = electronApp
      .getAppMetrics()
      .find((m) => m.type === 'Utility' && m.name === 'YodAI Voice');
    if (!metric) return undefined;
    // `workingSetSize` est en Kio.
    return { pid: metric.pid, workingSetBytes: metric.memory.workingSetSize * 1024 };
  });
}
