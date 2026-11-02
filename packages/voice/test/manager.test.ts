import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAtelierError, type AtelierErrorCode, type VoiceModelInfo } from '@atelier/shared';
import {
  VoiceModelManager,
  modelDownloadUrl,
  voiceModelsDir,
  type VoiceCatalogEntry,
  type VoiceInstallStep,
  type VoiceModelManagerOptions,
} from '../src/index.js';
import { makeTar, type TarEntry } from './helpers/tar.js';

const ROOT = 'model-x';
const FILES = {
  'encoder.onnx': 'E'.repeat(3000),
  'tokens.txt': 'a\nb\nc\n',
  'wavs/fr.wav': 'RIFF',
};

function goodEntries(): TarEntry[] {
  return [
    { name: `${ROOT}/` },
    ...Object.entries(FILES).flatMap(([path, data]) =>
      path.includes('/')
        ? [{ name: `${ROOT}/wavs/` }, { name: `${ROOT}/${path}`, data }]
        : [{ name: `${ROOT}/${path}`, data }],
    ),
  ];
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

function entryFor(
  archive: Buffer,
  overrides: Partial<VoiceCatalogEntry> = {},
  sha = sha256(archive),
): VoiceCatalogEntry {
  return {
    id: 'test-stt',
    role: 'stt',
    label: 'Modèle de test',
    version: '1',
    languages: ['fr'],
    memoryEstimateBytes: 1000,
    license: 'CC-BY-4.0',
    attribution: 'Test',
    homepage: 'https://example.com',
    source: {
      kind: 'download',
      archiveName: 'model-x.tar',
      url: 'https://example.com/releases/model-x.tar',
      sha256: sha,
      bytes: archive.length,
      rootDir: ROOT,
      files: Object.entries(FILES).map(([path, data]) => ({
        path,
        bytes: Buffer.byteLength(data),
      })),
    },
    ...overrides,
  };
}

const BUNDLED_DATA = Buffer.from('silero');
const bundledEntry: VoiceCatalogEntry = {
  id: 'test-vad',
  role: 'vad',
  label: 'VAD de test',
  version: '1',
  languages: [],
  memoryEstimateBytes: 10,
  license: 'MIT',
  homepage: 'https://example.com',
  source: {
    kind: 'bundled',
    file: 'vad.onnx',
    sha256: sha256(BUNDLED_DATA),
    bytes: BUNDLED_DATA.length,
    url: 'https://example.com/vad.onnx',
  },
};

/** Faux serveur : sert l'archive, gère `Range`, peut couper la connexion après N octets. */
function fakeServer(archive: Buffer, opts: { cutAfter?: number; ignoreRange?: boolean } = {}) {
  const calls: { url: string; range: string | null }[] = [];
  let cutAfter = opts.cutAfter;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    const range = headers.get('range');
    calls.push({ url, range });
    let start = 0;
    let status = 200;
    const respHeaders = new Headers();
    if (range && !opts.ignoreRange) {
      start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      status = 206;
      respHeaders.set(
        'content-range',
        `bytes ${String(start)}-${String(archive.length - 1)}/${String(archive.length)}`,
      );
    }
    const body = archive.subarray(start);
    const limit = cutAfter;
    cutAfter = undefined; // une seule coupure
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (limit !== undefined) {
          controller.enqueue(new Uint8Array(body.subarray(0, limit)));
          return;
        }
        for (let i = 0; i < body.length; i += 1024)
          controller.enqueue(new Uint8Array(body.subarray(i, i + 1024)));
        controller.close();
      },
      pull(controller) {
        // Connexion coupée après les octets déjà envoyés.
        controller.error(new Error('ECONNRESET'));
      },
    });
    return Promise.resolve(new Response(stream, { status, headers: respHeaders }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function expectCode(
  promise: Promise<unknown>,
  code: AtelierErrorCode,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(isAtelierError(error)).toBe(true);
    if (!isAtelierError(error)) throw error;
    expect(error.code).toBe(code);
    return error.details ?? {};
  }
  throw new Error(`Exception ${code} attendue`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

let work: string;
let root: string;
let bundledDir: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'atelier-voice-'));
  root = voiceModelsDir(join(work, 'userData'));
  bundledDir = join(work, 'resources');
  await mkdir(bundledDir, { recursive: true });
  await writeFile(join(bundledDir, 'vad.onnx'), BUNDLED_DATA);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function manager(
  entry: VoiceCatalogEntry,
  options: Partial<VoiceModelManagerOptions> = {},
): VoiceModelManager {
  return new VoiceModelManager({
    rootDir: root,
    bundledDir,
    catalog: [bundledEntry, entry],
    freeBytes: () => Promise.resolve(10 * 1024 ** 3),
    diskMarginBytes: 0,
    ...options,
  });
}

/** Contenu du dossier des modèles, hors `.downloads`. */
async function rootContent(): Promise<string[]> {
  return (await readdir(root).catch(() => [] as string[])).filter((n) => n !== '.downloads').sort();
}

describe('VoiceModelManager : installation', () => {
  it('installe un modèle : dossier <id>@<version>, manifeste, fichiers résolus', async () => {
    const archive = makeTar(goodEntries());
    const entry = entryFor(archive);
    const server = fakeServer(archive);
    const events: VoiceModelInfo[] = [];
    const m = manager(entry, {
      fetch: server.fetchImpl,
      onModelChange: (i) => events.push(i),
      progressIntervalMs: 0,
    });
    await m.init();
    expect((await m.info('test-stt')).state).toBe('absent');

    await m.install('test-stt');

    expect(await rootContent()).toEqual(['test-stt@1']);
    const manifest = JSON.parse(
      await readFile(join(root, 'test-stt@1', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'test-stt',
      version: '1',
      sha256: entry.source.sha256,
      origin: 'official',
    });
    expect(await readdir(join(root, '.downloads'))).toEqual([]);
    const resolved = await m.resolve('test-stt');
    expect(await readFile(resolved.files['tokens.txt'] ?? '', 'utf8')).toBe(FILES['tokens.txt']);
    expect((await m.info('test-stt')).state).toBe('installed');
    expect(events[0]?.state).toBe('downloading');
    expect(events.some((e) => e.progress?.receivedBytes === archive.length)).toBe(true);
    expect(events.at(-1)?.state).toBe('installed');
    expect(server.calls[0]?.url).toBe('https://example.com/releases/model-x.tar');
  });

  it('refuse un SHA-256 incorrect (voice/model_invalid) et ne garde rien', async () => {
    const archive = makeTar(goodEntries());
    const entry = entryFor(archive, {}, '0'.repeat(64));
    const m = manager(entry, { fetch: fakeServer(archive).fetchImpl });
    await m.init();
    const details = await expectCode(m.install('test-stt'), 'voice/model_invalid');
    expect(details['reason']).toBe('sha256_mismatch');
    expect(await rootContent()).toEqual([]);
    expect(await readdir(join(root, '.downloads'))).toEqual([]);
    const info = await m.info('test-stt');
    expect(info.state).toBe('error');
    expect(info.error?.code).toBe('voice/model_invalid');
  });

  it('reprend un téléchargement coupé avec un en-tête Range', async () => {
    const archive = makeTar(goodEntries());
    const entry = entryFor(archive);
    const server = fakeServer(archive, { cutAfter: 2048 });
    const m = manager(entry, { fetch: server.fetchImpl });
    await m.init();

    const details = await expectCode(m.install('test-stt'), 'voice/download_failed');
    expect(details['receivedBytes']).toBe(2048);
    expect((await stat(join(root, '.downloads', 'test-stt@1.partial'))).size).toBe(2048);
    expect(await rootContent()).toEqual([]);

    await m.install('test-stt');
    expect(server.calls[1]?.range).toBe('bytes=2048-');
    expect((await m.info('test-stt')).state).toBe('installed');
  });

  it('repart de zéro si le serveur ignore Range', async () => {
    const archive = makeTar(goodEntries());
    const entry = entryFor(archive);
    await mkdir(join(root, '.downloads'), { recursive: true });
    await writeFile(join(root, '.downloads', 'test-stt@1.partial'), archive.subarray(0, 1000));
    const server = fakeServer(archive, { ignoreRange: true });
    const m = manager(entry, { fetch: server.fetchImpl });
    await m.install('test-stt');
    expect(server.calls[0]?.range).toBe('bytes=1000-');
    expect((await m.info('test-stt')).state).toBe('installed');
  });

  it('vérifie la place disque avant de télécharger', async () => {
    const archive = makeTar(goodEntries());
    const server = fakeServer(archive);
    const m = manager(entryFor(archive), {
      fetch: server.fetchImpl,
      freeBytes: () => Promise.resolve(100),
    });
    const details = await expectCode(m.install('test-stt'), 'voice/download_failed');
    expect(details).toMatchObject({ reason: 'disk_full', availableBytes: 100 });
    expect(server.calls).toHaveLength(0);
  });

  it("n'appelle le réseau qu'une fois pour deux demandes simultanées", async () => {
    const archive = makeTar(goodEntries());
    const server = fakeServer(archive);
    const m = manager(entryFor(archive), { fetch: server.fetchImpl });
    await Promise.all([m.install('test-stt'), m.install('test-stt')]);
    expect(server.calls).toHaveLength(1);
  });

  it('annule une installation et garde le .partial', async () => {
    const archive = makeTar(goodEntries());
    const m = manager(entryFor(archive), {
      fetch: fakeServer(archive).fetchImpl,
      onStep: (_id, step) => {
        if (step === 'download') m.cancel('test-stt');
      },
    });
    const details = await expectCode(m.install('test-stt'), 'voice/download_failed');
    expect(details['reason']).toBe('cancelled');
    expect((await m.info('test-stt')).state).toBe('absent');
  });
});

describe('VoiceModelManager : contrôle des archives', () => {
  const cases: [string, TarEntry[]][] = [
    ['un chemin ../', [...goodEntries(), { name: `${ROOT}/../evil.sh`, data: 'x' }]],
    ['un chemin absolu', [...goodEntries(), { name: '/tmp/evil.sh', data: 'x' }]],
    ['un fichier inattendu', [...goodEntries(), { name: `${ROOT}/extra.bin`, data: 'x' }]],
    ['un fichier manquant', goodEntries().filter((e) => !e.name.endsWith('tokens.txt'))],
    ['un second dossier racine', [...goodEntries(), { name: 'other/' }]],
    [
      'un lien symbolique à la place d’un fichier',
      [
        ...goodEntries().filter((e) => !e.name.endsWith('tokens.txt')),
        { name: `${ROOT}/tokens.txt`, type: '2', linkname: '/etc/passwd' },
      ],
    ],
  ];

  for (const [label, entries] of cases) {
    it(`refuse une archive contenant ${label}`, async () => {
      const archive = makeTar(entries);
      // Le catalogue « épingle » cette archive : seul le contrôle du contenu peut la refuser.
      const m = manager(entryFor(archive), { fetch: fakeServer(archive).fetchImpl });
      await m.init();
      await expectCode(m.install('test-stt'), 'voice/model_invalid');
      expect(await rootContent()).toEqual([]);
      expect(await exists(join(work, 'userData', 'models', 'evil.sh'))).toBe(false);
      expect((await m.info('test-stt')).state).toBe('error');
    });
  }

  it('refuse une taille de fichier différente du catalogue', async () => {
    const archive = makeTar(goodEntries());
    const base = entryFor(archive);
    if (base.source.kind !== 'download') throw new Error('download attendu');
    const entry = {
      ...base,
      source: {
        ...base.source,
        files: base.source.files.map((f) => ({ ...f, bytes: f.bytes + 1 })),
      },
    };
    const m = manager(entry, { fetch: fakeServer(archive).fetchImpl });
    await expectCode(m.install('test-stt'), 'voice/model_invalid');
    expect(await rootContent()).toEqual([]);
  });
});

describe('VoiceModelManager : atomicité', () => {
  const steps: VoiceInstallStep[] = [
    'download',
    'verify',
    'extract',
    'check',
    'commit',
    'manifest',
  ];
  for (const crashAt of steps) {
    it(`rien d'installé à moitié après un crash à l'étape « ${crashAt} »`, async () => {
      const archive = makeTar(goodEntries());
      const entry = entryFor(archive);
      const crashing = manager(entry, {
        fetch: fakeServer(archive).fetchImpl,
        onStep: (_id, step) => {
          if (step === crashAt) throw new Error(`crash simulé : ${step}`);
        },
      });
      await crashing.init();
      await expect(crashing.install('test-stt')).rejects.toThrow('crash simulé');

      // Redémarrage de l'app.
      const restarted = manager(entry, { fetch: fakeServer(archive).fetchImpl });
      await restarted.init();
      expect((await restarted.info('test-stt')).state).toBe('absent');
      expect(await rootContent()).toEqual([]);
      await expectCode(restarted.resolve('test-stt'), 'voice/model_missing');
      await restarted.install('test-stt');
      expect((await restarted.info('test-stt')).state).toBe('installed');
    });
  }

  it('nettoie au démarrage les restes d’un process tué (staging, dossier sans manifeste)', async () => {
    const archive = makeTar(goodEntries());
    const entry = entryFor(archive);
    await mkdir(join(root, '.staging-test-stt@1-abc', ROOT), { recursive: true });
    await mkdir(join(root, 'test-stt@1'), { recursive: true });
    await writeFile(join(root, 'test-stt@1', 'encoder.onnx'), 'partiel');
    await writeFile(join(root, 'test-stt@1-x.manifest.tmp'), '{');

    const m = manager(entry, { fetch: fakeServer(archive).fetchImpl });
    expect((await m.info('test-stt')).state).toBe('absent');
    await m.init();
    expect(await rootContent()).toEqual([]);
  });

  it('un manifeste présent mais un fichier tronqué : modèle non installé', async () => {
    const archive = makeTar(goodEntries());
    const m = manager(entryFor(archive), { fetch: fakeServer(archive).fetchImpl });
    await m.install('test-stt');
    await writeFile(join(root, 'test-stt@1', 'encoder.onnx'), 'E');
    expect((await m.info('test-stt')).state).toBe('absent');
    await expectCode(m.resolve('test-stt'), 'voice/model_missing');
  });
});

describe('VoiceModelManager : suppression, mise à jour, sources', () => {
  it('supprime un modèle installé et son .partial', async () => {
    const archive = makeTar(goodEntries());
    const events: VoiceModelInfo[] = [];
    const m = manager(entryFor(archive), {
      fetch: fakeServer(archive).fetchImpl,
      onModelChange: (i) => events.push(i),
    });
    await m.install('test-stt');
    await writeFile(join(root, '.downloads', 'test-stt@2.partial'), 'x');
    await m.remove('test-stt');
    expect(await rootContent()).toEqual([]);
    expect(await readdir(join(root, '.downloads'))).toEqual([]);
    expect((await m.info('test-stt')).state).toBe('absent');
    expect(events.at(-1)?.state).toBe('absent');
  });

  it('refuse de supprimer un modèle embarqué', async () => {
    const archive = makeTar(goodEntries());
    await expectCode(manager(entryFor(archive)).remove('test-vad'), 'settings/invalid');
  });

  it('modèle inconnu : voice/model_missing', async () => {
    const archive = makeTar(goodEntries());
    await expectCode(manager(entryFor(archive)).install('inconnu'), 'voice/model_missing');
  });

  it("signale une mise à jour sans l'appliquer, puis supprime l'ancienne version après la bascule", async () => {
    const archiveV1 = makeTar(goodEntries());
    const v1 = entryFor(archiveV1);
    await manager(v1, { fetch: fakeServer(archiveV1).fetchImpl }).install('test-stt');

    const archiveV2 = makeTar([
      ...goodEntries().filter((e) => !e.name.endsWith('tokens.txt')),
      { name: `${ROOT}/tokens.txt`, data: 'x\ny\nz\n' },
    ]);
    const v2 = entryFor(archiveV2, { version: '2' });
    const server = fakeServer(archiveV2);
    const m = manager(v2, { fetch: server.fetchImpl });
    await m.init();
    expect(await m.pendingUpdates()).toEqual([
      { id: 'test-stt', installedVersion: '1', catalogVersion: '2' },
    ]);
    expect((await m.info('test-stt')).state).toBe('absent');
    expect(await rootContent()).toEqual(['test-stt@1']);
    expect(server.calls).toHaveLength(0);

    await m.install('test-stt');
    expect(await rootContent()).toEqual(['test-stt@2']);
    expect(await m.pendingUpdates()).toEqual([]);
  });

  it('télécharge depuis le miroir, contrôlé par la même empreinte', async () => {
    const archive = makeTar(goodEntries());
    const server = fakeServer(archive);
    const m = manager(entryFor(archive), { fetch: server.fetchImpl });
    await m.install('test-stt', { sourceUrl: 'https://mirror.example.be/voice/' });
    expect(server.calls[0]?.url).toBe('https://mirror.example.be/voice/model-x.tar');
    const manifest = JSON.parse(
      await readFile(join(root, 'test-stt@1', 'manifest.json'), 'utf8'),
    ) as { origin: string };
    expect(manifest.origin).toBe('mirror');

    const tampered = Buffer.from(archive);
    tampered[600] = (tampered[600] ?? 0) ^ 1;
    const other = manager(entryFor(archive, { id: 'test-stt' }), {
      rootDir: join(work, 'other'),
      fetch: fakeServer(tampered).fetchImpl,
    });
    await expectCode(
      other.install('test-stt', { sourceUrl: 'https://mirror.example.be' }),
      'voice/model_invalid',
    );
  });

  it('applique la règle de checkServerUrl au miroir', () => {
    const archive = makeTar(goodEntries());
    const source = entryFor(archive).source;
    if (source.kind !== 'download') throw new Error('download attendu');
    expect(() => modelDownloadUrl(source, 'http://mirror.example.be')).toThrow(/https/);
    expect(modelDownloadUrl(source, 'http://localhost:8080/m')).toBe(
      'http://localhost:8080/m/model-x.tar',
    );
    expect(modelDownloadUrl(source, 'http://100.101.1.2')).toBe('http://100.101.1.2/model-x.tar');
    expect(modelDownloadUrl(source, '  ')).toBe(source.url);
  });

  it('importe une archive hors ligne, sans réseau', async () => {
    const archive = makeTar(goodEntries());
    const file = join(work, 'model-x.tar');
    await writeFile(file, archive);
    const server = fakeServer(archive);
    const m = manager(entryFor(archive), { fetch: server.fetchImpl });
    await m.init();
    await m.importArchive('test-stt', file);
    expect(server.calls).toHaveLength(0);
    expect((await m.info('test-stt')).state).toBe('installed');
    expect(await exists(file)).toBe(true); // l'archive de l'utilisateur n'est pas touchée
    expect(await readdir(join(root, '.downloads'))).toEqual([]);
    const manifest = JSON.parse(
      await readFile(join(root, 'test-stt@1', 'manifest.json'), 'utf8'),
    ) as { origin: string };
    expect(manifest.origin).toBe('import');
  });

  it("refuse l'import d'une archive qui n'a pas l'empreinte du catalogue", async () => {
    const archive = makeTar(goodEntries());
    const tampered = Buffer.from(archive);
    tampered[700] = (tampered[700] ?? 0) ^ 1;
    const file = join(work, 'model-x.tar');
    await writeFile(file, tampered);
    const m = manager(entryFor(archive));
    const details = await expectCode(m.importArchive('test-stt', file), 'voice/model_invalid');
    expect(details['reason']).toBe('sha256_mismatch');
    expect(await rootContent()).toEqual([]);

    await writeFile(file, archive.subarray(0, 100));
    expect(
      (await expectCode(m.importArchive('test-stt', file), 'voice/model_invalid'))['reason'],
    ).toBe('size_mismatch');
  });
});

describe('VoiceModelManager : modèle embarqué', () => {
  it('le modèle embarqué est installé et résolu dans les ressources', async () => {
    const archive = makeTar(goodEntries());
    const m = manager(entryFor(archive));
    const info = await m.info('test-vad');
    expect(info).toMatchObject({ state: 'installed', bundled: true, downloadBytes: 0 });
    expect((await m.resolve('test-vad')).files['vad.onnx']).toBe(join(bundledDir, 'vad.onnx'));
  });

  it('un modèle embarqué corrompu est en erreur', async () => {
    await writeFile(join(bundledDir, 'vad.onnx'), 'xxxxxx');
    const archive = makeTar(goodEntries());
    const m = manager(entryFor(archive));
    const info = await m.info('test-vad');
    expect(info.state).toBe('error');
    expect(info.error?.code).toBe('voice/model_invalid');
    await expectCode(m.resolve('test-vad'), 'voice/model_invalid');
  });
});
