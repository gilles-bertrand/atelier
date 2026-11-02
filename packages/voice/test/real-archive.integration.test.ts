/**
 * Import de la vraie archive de Parakeet v3 int8 (464,6 Mo), extraite par le
 * `tar` du système. Skippé par défaut ; pour le lancer :
 *
 *   ATELIER_VOICE_IT=1 ATELIER_VOICE_PARAKEET_ARCHIVE=/chemin/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 \
 *     pnpm --filter @atelier/voice test
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARAKEET_TDT_V3_INT8, VoiceModelManager } from '../src/index.js';

const archive = process.env['ATELIER_VOICE_PARAKEET_ARCHIVE'];
const enabled = process.env['ATELIER_VOICE_IT'] === '1' && archive !== undefined;

describe.skipIf(!enabled)('archive réelle de Parakeet (ATELIER_VOICE_IT=1)', () => {
  it('importe, vérifie et résout le modèle', async () => {
    const work = await mkdtemp(join(tmpdir(), 'atelier-voice-it-'));
    try {
      const manager = new VoiceModelManager({
        rootDir: join(work, 'voice'),
        bundledDir: join(work, 'res'),
      });
      await manager.init();
      await manager.importArchive(PARAKEET_TDT_V3_INT8.id, archive ?? '');
      const resolved = await manager.resolve(PARAKEET_TDT_V3_INT8.id);
      expect(Object.keys(resolved.files)).toContain('encoder.int8.onnx');
      expect((await manager.info(PARAKEET_TDT_V3_INT8.id)).state).toBe('installed');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});
