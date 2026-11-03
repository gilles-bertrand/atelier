/**
 * Dictée, e2e réel (ADR-004 L5, ticket #31) : le vrai worker sherpa-onnx et
 * Parakeet v3, le micro simulé par un fichier WAV que Chromium lit comme un
 * périphérique (`--use-fake-device-for-media-stream`,
 * `--use-file-for-fake-audio-capture`). Ni Qwen ni VM : le LLM est le faux
 * serveur des e2e, l'app tourne sous `--user-data-dir` (ticket #41).
 *
 * Déroulé :
 * 1. import hors ligne de l'archive Parakeet (« Importer une archive… », même
 *    canal `voice:import-model`), avec un miroir injoignable dans les réglages :
 *    un téléchargement échouerait, l'installation est donc bien locale ;
 * 2. une dictée par phrase du jeu de S1 (10 FLEURS, 10 phrases de Gilles), l'app
 *    étant relancée sur le même `userData` avec le WAV de la phrase ;
 * 3. WER (même normalisation qu'en S1), délai entre « Terminer » et le texte
 *    inséré, mémoire du worker ; puis libération du worker après 1 min
 *    d'inactivité (`idleUnloadMinutes: 1`).
 *
 * Lancement (macOS arm64, ffmpeg sur le PATH) :
 *   pnpm --filter @atelier/desktop build
 *   cd qa && ATELIER_E2E_VOICE=real npx playwright test e2e/voice-dictation.real.spec.ts
 * Variables : `ATELIER_VOICE_PARAKEET_ARCHIVE` (archive officielle, défaut
 * `~/.cache/atelier-voice-spike/<archive>`), `ATELIER_E2E_VOICE_CORPUS`
 * (fichiers JSON `[{ id, file, ref }]` séparés par des virgules, défaut : le jeu
 * de S1 dans `~/.cache/atelier-voice-spike`). Rapport : `qa/reports/voice-real-<date>.json`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { launchAtelier, openWorkspace, type AtelierApp } from './support/app.js';
import { startMockLlm } from './support/mock-llm.js';
import { ALL_SCENARIOS } from './support/scenarios.js';
import {
  composer,
  grantMicStatus,
  PARAKEET,
  stageBundledVad,
  startDictation,
  stopDictation,
  VOICE_MODE,
  voiceWorkerMemory,
} from './support/voice.js';
import { wordErrors } from './support/wer.js';

const run = promisify(execFile);

const SPIKE_DIR = join(homedir(), '.cache', 'atelier-voice-spike');
const ARCHIVE =
  process.env['ATELIER_VOICE_PARAKEET_ARCHIVE'] ?? join(SPIKE_DIR, PARAKEET.archiveName);
const CORPUS = (
  process.env['ATELIER_E2E_VOICE_CORPUS'] ??
  [join(SPIKE_DIR, 'corpus-fleurs.json'), join(SPIKE_DIR, 'corpus-gilles.json')].join(',')
).split(',');

/** Silence ajouté avant et après chaque phrase dans le WAV du faux micro. */
const LEAD_MS = 1_000;
const TRAIL_MS = 2_000;
/** N3 : texte final en 1 s au plus après l'arrêt. */
const MAX_FINAL_MS = 1_000;

interface CorpusItem {
  id: string;
  file: string;
  ref: string;
}

interface PhraseResult {
  id: string;
  speechMs: number;
  ref: string;
  hyp: string;
  errors: number;
  words: number;
  finalMs: number;
  workerRssMiB?: number;
}

test.skip(
  VOICE_MODE !== 'real' || process.platform !== 'darwin' || process.arch !== 'arm64',
  'dictée réelle : ATELIER_E2E_VOICE=real sur macOS arm64',
);

/** Durée du bloc `data` d'un WAV PCM16 mono 48 kHz (en-têtes de ffmpeg compris). */
function wavDurationMs(wav: Buffer): number {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return (size / (48_000 * 2)) * 1000;
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV sans bloc data');
}

/** WAV du faux micro : 48 kHz PCM16 mono (exigé par Chromium), silence autour de la phrase. */
async function fakeMicWav(source: string, target: string): Promise<number> {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    source,
    '-af',
    `adelay=${String(LEAD_MS)},apad=pad_dur=${String(TRAIL_MS / 1000)}`,
    '-ar',
    '48000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-map_metadata',
    '-1',
    '-bitexact',
    target,
  ]);
  return wavDurationMs(await readFile(target)) - LEAD_MS - TRAIL_MS;
}

/**
 * Faux micro : le WAV de la phrase, lu par Chromium.
 *
 * `--no-sandbox` est nécessaire avec l'Electron du dépôt : sans lui, le service
 * audio sandboxé ne lit pas le fichier (« Failed to read … as input to the fake
 * device »), même avec `--disable-features=AudioServiceSandbox` (suffisant au
 * spike S1, sur l'app packagée). Il ne vaut que pour cette instance de mesure :
 * la dictée (capture, relais du main, worker) ne dépend pas du sandbox.
 */
function micArgs(wav: string): string[] {
  return [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--disable-features=AudioServiceSandbox',
    '--no-sandbox',
  ];
}

/**
 * Garde-fou : le micro vu par la page doit être le faux périphérique de
 * Chromium. Sinon (commutateurs perdus), la dictée ouvrirait le vrai micro.
 * Lu par `enumerateDevices`, sans ouvrir de capture.
 */
async function assertFakeMic(page: Page): Promise<void> {
  const labels = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput')
      .map((d) => d.label),
  );
  expect(labels.length, 'aucun micro').toBeGreaterThan(0);
  for (const label of labels) expect(label, `micro réel présent : ${label}`).toMatch(/fake/i);
}

test('dictée réelle : import hors ligne, WER du jeu de S1, délai, mémoire, libération', async () => {
  const testInfo = test.info();
  test.setTimeout(45 * 60_000);
  expect(existsSync(ARCHIVE), `archive Parakeet absente : ${ARCHIVE}`).toBe(true);
  const items: CorpusItem[] = [];
  for (const path of CORPUS) {
    items.push(...(JSON.parse(await readFile(path, 'utf8')) as CorpusItem[]));
  }
  expect(items.length).toBeGreaterThan(0);

  await stageBundledVad();
  const wavRoot = process.env['ATELIER_E2E_VOICE_WAV_DIR'] ?? tmpdir();
  await mkdir(wavRoot, { recursive: true });
  const wavDir = await mkdtemp(join(wavRoot, 'atelier-voice-wav-'));
  const speech = new Map<string, { wav: string; ms: number }>();
  for (const item of items) {
    const wav = join(wavDir, `${item.id}.wav`);
    speech.set(item.id, { wav, ms: await fakeMicWav(item.file, wav) });
  }

  const llm = await startMockLlm(ALL_SCENARIOS);
  const results: PhraseResult[] = [];
  let atelier: AtelierApp | undefined;
  let root: string | undefined;
  const report: Record<string, unknown> = { date: new Date().toISOString(), archive: ARCHIVE };
  try {
    for (const [index, item] of items.entries()) {
      const take = speech.get(item.id);
      if (!take) throw new Error(item.id);
      atelier = await launchAtelier({
        llmUrl: llm.url,
        model: 'atelier',
        extraArgs: micArgs(take.wav),
        ...(root !== undefined
          ? { root }
          : {
              extraSettings: {
                voice: {
                  enabled: true,
                  sttModel: PARAKEET.id,
                  idleUnloadMinutes: 1,
                  // Miroir injoignable : toute tentative de téléchargement échouerait.
                  modelSourceUrl: 'http://127.0.0.1:9/',
                },
              },
            }),
      });
      root = atelier.root;
      const { app, page } = atelier;
      await grantMicStatus(app);

      if (index === 0) {
        // 1. Import hors ligne de l'archive (sélecteur de fichier remplacé).
        await app.evaluate(({ dialog }, archive) => {
          dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [archive] });
        }, ARCHIVE);
        const t0 = Date.now();
        const imported = await page.evaluate(async (id) => {
          const api = (
            window as unknown as {
              atelier: { invoke: (c: string, r?: unknown) => Promise<{ ok: boolean }> };
            }
          ).atelier;
          return api.invoke('voice:import-model', { id });
        }, PARAKEET.id);
        report['importMs'] = Date.now() - t0;
        expect(imported.ok, JSON.stringify(imported)).toBe(true);
        const manifest = JSON.parse(
          await readFile(
            join(
              atelier.userData,
              'models',
              'voice',
              `${PARAKEET.id}@${PARAKEET.version}`,
              'manifest.json',
            ),
            'utf8',
          ),
        ) as { origin: string; sha256: string };
        expect(manifest).toMatchObject({ origin: 'import', sha256: PARAKEET.sha256 });
        // Le sélecteur de dossier retrouve le dossier de travail.
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
        }, atelier.workspace);
      }

      await openWorkspace(page);
      await assertFakeMic(page);
      await startDictation(page);
      const listeningAt = Date.now();
      // Le faux micro lit le WAV depuis l'ouverture de la capture : on s'arrête
      // au milieu du silence final, avant que le fichier ne reboucle.
      await page.waitForTimeout(
        Math.max(0, take.ms + LEAD_MS + TRAIL_MS / 2 - (Date.now() - listeningAt)),
      );
      const finalMs = await stopDictation(page, 30_000);
      const hyp = await composer(page).inputValue();
      const memory = await voiceWorkerMemory(app);
      const { errors, words } = wordErrors(item.ref, hyp);
      results.push({
        id: item.id,
        speechMs: Math.round(take.ms),
        ref: item.ref,
        hyp,
        errors,
        words,
        finalMs,
        ...(memory ? { workerRssMiB: Math.round(memory.workingSetBytes / 2 ** 20) } : {}),
      });
      console.log(
        `${item.id} ${String(Math.round(take.ms))} ms de parole, final ${String(finalMs)} ms, ` +
          `${String(errors)}/${String(words)} erreurs, worker ${String(memory ? Math.round(memory.workingSetBytes / 2 ** 20) : '?')} Mio`,
      );

      await writeFile(testInfo.outputPath(`main-${item.id}.log`), atelier.logs.join(''));
      if (index < items.length - 1) {
        await atelier.close({ keep: true });
        atelier = undefined;
      }
    }

    // 3. Libération après 1 min d'inactivité (`idleUnloadMinutes: 1`).
    if (atelier) {
      const app = atelier.app;
      const idleSince = Date.now();
      await expect
        .poll(async () => (await voiceWorkerMemory(app)) === undefined, {
          timeout: 3 * 60_000,
          intervals: [5_000],
        })
        .toBe(true);
      report['unloadedAfterMs'] = Date.now() - idleSince;
    }
  } finally {
    await atelier?.close();
    await llm.close();
    await rm(wavDir, { recursive: true, force: true });
    const total = results.reduce((a, r) => ({ e: a.e + r.errors, n: a.n + r.words }), {
      e: 0,
      n: 0,
    });
    const byPrefix = (prefix: string) => {
      const subset = results.filter((r) => r.id.startsWith(prefix));
      const e = subset.reduce((a, r) => a + r.errors, 0);
      const n = subset.reduce((a, r) => a + r.words, 0);
      return n > 0 ? +((100 * e) / n).toFixed(2) : undefined;
    };
    Object.assign(report, {
      werPercent: total.n > 0 ? +((100 * total.e) / total.n).toFixed(2) : undefined,
      werFleursPercent: byPrefix('fleurs'),
      werGillesPercent: byPrefix('gilles'),
      maxFinalMs: Math.max(0, ...results.map((r) => r.finalMs)),
      maxWorkerRssMiB: Math.max(0, ...results.map((r) => r.workerRssMiB ?? 0)),
      phrases: results,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const day = new Date().toISOString().slice(0, 10);
    await writeFile(join(import.meta.dirname, '..', 'reports', `voice-real-${day}.json`), json);
    await testInfo.attach('voice-real.json', { body: json, contentType: 'application/json' });
  }

  expect(results).toHaveLength(items.length);
  for (const r of results) {
    expect(r.hyp, `${r.id} : aucun texte reconnu`).not.toBe('');
    expect(r.finalMs, `${r.id} : texte final trop lent`).toBeLessThanOrEqual(MAX_FINAL_MS);
  }
  expect(report['unloadedAfterMs']).toBeDefined();
});
