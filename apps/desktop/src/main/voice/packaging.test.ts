/**
 * Packaging de la voix (ADR-004 D2, D8) : relu dans les fichiers de build, pour
 * qu'un oubli (entitlement, Info.plist, asarUnpack) casse la CI plutôt que le
 * micro de l'app signée.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SILERO_VAD } from '@atelier/voice';
import { BUNDLED_VOICE_MODELS } from '../../../../../scripts/fetch-voice-models.js';

const desktop = join(import.meta.dirname, '..', '..', '..');
const read = (path: string): string => readFileSync(join(desktop, path), 'utf8');

describe('packaging de la voix', () => {
  it('le script fetch:voice épingle la même empreinte que le catalogue', () => {
    if (SILERO_VAD.source.kind !== 'bundled') throw new Error('Silero doit être embarqué');
    expect(BUNDLED_VOICE_MODELS).toEqual([
      {
        file: SILERO_VAD.source.file,
        url: SILERO_VAD.source.url,
        bytes: SILERO_VAD.source.bytes,
        sha256: SILERO_VAD.source.sha256,
      },
    ]);
  });

  it('entitlement micro dans les deux profils de signature', () => {
    for (const file of ['build/entitlements.mac.plist', 'build/entitlements.adhoc.plist']) {
      expect(read(file)).toMatch(
        /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
      );
    }
  });

  it('Info.plist, ressources embarquées et module natif hors de l’asar', () => {
    const builder = read('electron-builder.yml');
    expect(builder).toMatch(/NSMicrophoneUsageDescription: .*micro.*ni envoyé ni conservé/);
    expect(builder).toContain("'**/node_modules/sherpa-onnx-*/**'");
    expect(builder).toMatch(/from: resources\/voice\s+to: voice/);
  });

  it('sherpa-onnx est une dépendance externe de l’app, en version épinglée', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['sherpa-onnx-node']).toBe('2.0.1');
    expect(pkg.dependencies['sherpa-onnx-darwin-arm64']).toBe('2.0.1');
    const vite = read('electron.vite.config.ts');
    expect(vite).toContain("'voice-worker': resolve(");
    expect(vite).toContain("'@atelier/voice'");
  });
});
