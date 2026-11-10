import { describe, expect, it } from 'vitest';
import { DEFAULT_STT_MODEL, DEFAULT_TTS_VOICE } from '@atelier/shared';
import {
  PARAKEET_TDT_V3_INT8,
  SILERO_VAD,
  SUPERTONIC_3_INT8,
  SUPERTONIC_FALLBACK_NUM_STEPS,
  SUPERTONIC_NUM_STEPS,
  TTS_VOICES,
  findTtsVoice,
  VOICE_MODEL_CATALOG,
  checkArchiveEntries,
  entryDiskBytes,
  findCatalogEntry,
  formatBytes,
  modelDirName,
  tarExtractArgs,
  toModelInfo,
  voiceModelLicenses,
} from '../src/index.js';

describe('catalogue des modèles de voix', () => {
  it('épingle une empreinte, une taille et une URL officielle pour chaque modèle', () => {
    const ids = new Set<string>();
    for (const entry of VOICE_MODEL_CATALOG) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.id).toMatch(/^[a-z0-9.-]+$/);
      expect(entry.version).toMatch(/^[A-Za-z0-9.-]+$/);
      expect(entry.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.source.bytes).toBeGreaterThan(0);
      expect(entry.source.url).toMatch(
        /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//,
      );
      expect(entry.license).not.toMatch(/NC/);
    }
  });

  it('le modèle de reconnaissance par défaut est Parakeet v3 int8, téléchargé', () => {
    const entry = findCatalogEntry(DEFAULT_STT_MODEL);
    expect(entry).toBe(PARAKEET_TDT_V3_INT8);
    expect(entry?.source.kind).toBe('download');
    expect(entry?.languages).toEqual(expect.arrayContaining(['fr', 'nl', 'en']));
    expect(entry?.languages).toHaveLength(25);
    if (entry?.source.kind !== 'download') throw new Error('download attendu');
    expect(entry.source.url.endsWith(`/${entry.source.archiveName}`)).toBe(true);
    expect(entry.source.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'encoder.int8.onnx',
        'decoder.int8.onnx',
        'joiner.int8.onnx',
        'tokens.txt',
      ]),
    );
  });

  it('la voix par défaut est Supertonic 3 M4 à 8 étapes, épinglée (S2)', () => {
    const voice = findTtsVoice(DEFAULT_TTS_VOICE);
    expect(voice).toMatchObject({ id: 'supertonic-3-m4', sid: 8, lang: 'fr', numSteps: 8 });
    expect(SUPERTONIC_NUM_STEPS).toBe(8);
    expect(SUPERTONIC_FALLBACK_NUM_STEPS).toBe(5);
    expect(findCatalogEntry(voice?.modelId ?? '')).toBe(SUPERTONIC_3_INT8);
    expect(SUPERTONIC_3_INT8).toMatchObject({
      role: 'tts',
      license: 'OpenRAIL-M',
      languages: ['fr'],
      upstream: {
        repo: 'Supertone/supertonic-3',
        revision: '3cadd1ee6394adea1bd021217a0e650ede09a323',
      },
    });
    if (SUPERTONIC_3_INT8.source.kind !== 'download') throw new Error('download attendu');
    expect(SUPERTONIC_3_INT8.source).toMatchObject({
      archiveName: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2',
      sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
      bytes: 128_774_318,
      rootDir: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    });
    expect(SUPERTONIC_3_INT8.source.url).toMatch(/\/releases\/download\/tts-models\//);
    // Chaque voix porte un modèle du catalogue ; aucune ne dépend d'un phonémiseur.
    for (const v of TTS_VOICES) expect(findCatalogEntry(v.modelId)?.role).toBe('tts');
  });

  it('livre l’attribution OpenRAIL-M de Supertonic, voix signalée synthétique', () => {
    const st = voiceModelLicenses().find((l) => l.id === SUPERTONIC_3_INT8.id);
    expect(st?.license).toBe('OpenRAIL-M');
    expect(st?.attribution).toMatch(/Supertone/);
    expect(st?.attribution).toMatch(/3cadd1ee6394adea1bd021217a0e650ede09a323/);
    expect(st?.attribution).toMatch(/fichiers modifiés/);
    expect(st?.attribution).toMatch(/[Vv]oix synthétique/);
  });

  it('Silero est embarqué dans l’app', () => {
    expect(SILERO_VAD.source.kind).toBe('bundled');
    expect(toModelInfo(SILERO_VAD, 'installed')).toMatchObject({
      bundled: true,
      downloadBytes: 0,
      role: 'vad',
    });
  });

  it("prévoit l'attribution CC-BY de Parakeet pour « À propos › Licences »", () => {
    const parakeet = voiceModelLicenses().find((l) => l.id === PARAKEET_TDT_V3_INT8.id);
    expect(parakeet?.license).toBe('CC-BY-4.0');
    expect(parakeet?.attribution).toMatch(/NVIDIA/);
    expect(parakeet?.attribution).toMatch(/CC-BY-4\.0/);
    expect(parakeet?.homepage).toMatch(/^https:\/\//);
  });

  it('décrit un modèle au format VoiceModelInfo', () => {
    const info = toModelInfo(PARAKEET_TDT_V3_INT8, 'downloading', {
      progress: { receivedBytes: 1, totalBytes: 2 },
    });
    expect(info).toMatchObject({
      id: 'parakeet-tdt-0.6b-v3-int8',
      downloadBytes: 487_170_055,
      diskBytes: entryDiskBytes(PARAKEET_TDT_V3_INT8),
      bundled: false,
      state: 'downloading',
      progress: { receivedBytes: 1, totalBytes: 2 },
    });
    expect(modelDirName(PARAKEET_TDT_V3_INT8)).toBe('parakeet-tdt-0.6b-v3-int8@2025-08-16');
  });
});

describe('checkArchiveEntries', () => {
  const files = [
    { path: 'a.onnx', bytes: 1 },
    { path: 'sub/b.wav', bytes: 1 },
  ];
  const ok = ['root/', 'root/a.onnx', 'root/sub/', 'root/sub/b.wav'];

  it('accepte la liste exacte, avec ou sans ./', () => {
    expect(checkArchiveEntries(ok, 'root', files)).toBeUndefined();
    expect(
      checkArchiveEntries(
        ok.map((e) => `./${e}`),
        'root',
        files,
      ),
    ).toBeUndefined();
    expect(
      checkArchiveEntries(['root/a.onnx', 'root/sub/b.wav', ''], 'root', files),
    ).toBeUndefined();
  });

  it.each([
    [[...ok, 'root/../x'], /interdit/],
    [[...ok, '../x'], /interdit/],
    [[...ok, '/etc/x'], /absolu/],
    [[...ok, 'root/c.onnx'], /inattendu/],
    [[...ok, 'root/a.onnx/'], /inattendu/],
    [['root/', 'root/a.onnx'], /manquant/],
    [[...ok, 'root\\..\\x'], /inattendu|interdit/],
  ])('refuse %j', (entries, message) => {
    expect(checkArchiveEntries(entries, 'root', files)).toMatch(message);
  });

  it('extrait sans shell, sans propriétaire ni droits d’origine', () => {
    expect(tarExtractArgs('/a.tar', '/d')).toEqual([
      '-xf',
      '/a.tar',
      '-C',
      '/d',
      '--no-same-owner',
      '--no-same-permissions',
    ]);
  });

  it('formate une taille en français', () => {
    expect(formatBytes(487_170_055)).toBe('464,6 Mo');
    expect(formatBytes(12)).toBe('12 octets');
  });
});
