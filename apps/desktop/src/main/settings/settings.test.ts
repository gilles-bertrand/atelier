import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_SETTINGS, isAtelierError } from '@atelier/shared';
import { SecretsStore, type SecretCipher } from './secrets-store.js';
import {
  applySettingsPatch,
  defaultSettings,
  mergeWithDefaults,
  SettingsStore,
} from './settings-store.js';

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'atelier-settings-'));

describe('réglages', () => {
  it('applique un patch profond au premier niveau', () => {
    const next = applySettingsPatch(defaultSettings('/Users/a'), { llm: { model: 'qwen3.5:9b' } });
    expect(next.llm).toMatchObject({ model: 'qwen3.5:9b', thinking: true });
    expect(next.skillsDir).toBe('/Users/a/YodAI/skills');
  });

  it('« Ouvrir YodAI à la connexion » : enregistré et relu (absent = non)', () => {
    const base = defaultSettings('/h');
    expect(base.openAtLogin).toBeUndefined();
    const on = applySettingsPatch(base, { openAtLogin: true });
    expect(on.openAtLogin).toBe(true);
    expect(mergeWithDefaults(base, { ...on }).openAtLogin).toBe(true);
    expect(mergeWithDefaults(base, { openAtLogin: 'oui' }).openAtLogin).toBeUndefined();
  });

  it('refuse une URL http hors localhost / Tailscale', () => {
    let error: unknown;
    try {
      applySettingsPatch(defaultSettings('/h'), { llm: { baseUrl: 'http://llm.example.com' } });
    } catch (e) {
      error = e;
    }
    expect(isAtelierError(error) && error.code).toBe('llm/insecure_url');
    expect(() =>
      applySettingsPatch(defaultSettings('/h'), { llm: { baseUrl: 'http://100.64.1.2:11434' } }),
    ).not.toThrow();
  });

  it("efface le modèle vision et le contexte forcé avec '' et 0", () => {
    const set = applySettingsPatch(defaultSettings('/h'), {
      llm: { visionModel: 'qwen3-vl:8b', numCtx: 65536 },
    });
    expect(set.llm).toMatchObject({ visionModel: 'qwen3-vl:8b', numCtx: 65536 });
    const cleared = applySettingsPatch(set, { llm: { visionModel: '', numCtx: 0 } });
    expect(cleared.llm).not.toHaveProperty('visionModel');
    expect(cleared.llm).not.toHaveProperty('numCtx');
  });

  it('valide les ressources de la VM', () => {
    expect(() => applySettingsPatch(defaultSettings('/h'), { sandbox: { cpus: 0 } })).toThrow();
    expect(() =>
      applySettingsPatch(defaultSettings('/h'), { sandbox: { memoryGiB: 128 } }),
    ).toThrow();
  });

  it('revient aux défauts sur un fichier corrompu', () => {
    const d = defaultSettings('/h');
    expect(mergeWithDefaults(d, 'n’importe quoi')).toBe(d);
    expect(mergeWithDefaults(d, { llm: { baseUrl: 'ftp://x' } })).toBe(d);
    expect(mergeWithDefaults(d, { llm: { model: 'm' } }).llm.model).toBe('m');
  });

  it('persiste et notifie', async () => {
    const dir = await tmp();
    const file = join(dir, 'settings.json');
    const store = await SettingsStore.load(file, '/h');
    const seen: string[] = [];
    store.onChange((next, prev) => seen.push(`${prev.llm.model}→${next.llm.model}`));
    await store.update({ llm: { model: 'qwen3.5:27b' }, onboardingCompleted: true });
    expect(seen).toEqual(['qwen3.5:35b→qwen3.5:27b']);
    const reloaded = await SettingsStore.load(file, '/h');
    expect(reloaded.get()).toMatchObject({
      onboardingCompleted: true,
      llm: { model: 'qwen3.5:27b' },
    });
  });
});

/** Chiffrement factice réversible (le vrai est le trousseau macOS). */
const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
});

describe('secrets', () => {
  it('chiffre, relit, efface et n’expose que la présence', async () => {
    const file = join(await tmp(), 'secrets.json');
    const store = await SecretsStore.load(file, fakeCipher());
    await store.set('llm_token', '  abc  ');
    expect(store.presence()).toEqual({
      llm_token: true,
      ollama_search_key: false,
      brave_search_key: false,
    });
    expect(await readFile(file, 'utf8')).not.toContain('abc');
    const reloaded = await SecretsStore.load(file, fakeCipher());
    expect(reloaded.get('llm_token')).toBe('abc');
    await reloaded.set('llm_token', null);
    expect(reloaded.presence().llm_token).toBe(false);
  });

  it('refuse d’enregistrer sans trousseau et ignore un fichier illisible', async () => {
    const file = join(await tmp(), 'secrets.json');
    await writeFile(file, '{oops');
    const store = await SecretsStore.load(file, fakeCipher(false));
    expect(store.presence().llm_token).toBe(false);
    await expect(store.set('llm_token', 'x')).rejects.toThrow(/trousseau/);
  });
});

describe('réglages de la voix (ADR-004 D10)', () => {
  it('absents par défaut, puis enregistrés et relus', () => {
    const base = defaultSettings('/h');
    expect(base.voice).toBeUndefined();
    const on = applySettingsPatch(base, { voice: { ...DEFAULT_VOICE_SETTINGS, enabled: true } });
    expect(on.voice).toEqual({
      enabled: true,
      sttModel: 'parakeet-tdt-0.6b-v3-int8',
      idleUnloadMinutes: 10,
    });
    expect(mergeWithDefaults(base, JSON.parse(JSON.stringify(on)) as unknown).voice).toEqual(
      on.voice,
    );
    // Un autre patch garde la voix.
    expect(applySettingsPatch(on, { openAtLogin: true }).voice).toEqual(on.voice);
  });

  it('miroir : règle de checkServerUrl ; chaîne vide = source officielle', () => {
    const base = defaultSettings('/h');
    expect(() =>
      applySettingsPatch(base, {
        voice: { ...DEFAULT_VOICE_SETTINGS, modelSourceUrl: 'http://mirror.example.be' },
      }),
    ).toThrow(/https/);
    const mirror = applySettingsPatch(base, {
      voice: { ...DEFAULT_VOICE_SETTINGS, modelSourceUrl: ' https://m.example.be ' },
    });
    expect(mirror.voice?.modelSourceUrl).toBe('https://m.example.be');
    expect(
      applySettingsPatch(mirror, { voice: { ...DEFAULT_VOICE_SETTINGS, modelSourceUrl: '' } }).voice
        ?.modelSourceUrl,
    ).toBeUndefined();
  });

  it('refuse un délai de déchargement hors bornes (settings/invalid, champ indiqué)', () => {
    let error: unknown;
    try {
      applySettingsPatch(defaultSettings('/h'), {
        voice: { ...DEFAULT_VOICE_SETTINGS, idleUnloadMinutes: -1 },
      });
    } catch (e) {
      error = e;
    }
    expect(isAtelierError(error) && error.code).toBe('settings/invalid');
    expect(isAtelierError(error) && error.details?.['field']).toBe('voice.idleUnloadMinutes');
  });

  it('une voix illisible sur le disque revient aux défauts sans toucher au reste', () => {
    const base = defaultSettings('/h');
    const raw = {
      ...base,
      openAtLogin: true,
      voice: { enabled: true, glossary: 'Ollama', idleUnloadMinutes: 'dix' },
    };
    const merged = mergeWithDefaults(base, raw);
    expect(merged.openAtLogin).toBe(true);
    expect(merged.voice).toEqual({
      enabled: true,
      sttModel: 'parakeet-tdt-0.6b-v3-int8',
      idleUnloadMinutes: 10,
    });
    const invalidVoice = mergeWithDefaults(base, { ...base, voice: { idleUnloadMinutes: 99_999 } });
    expect(invalidVoice.voice).toBeUndefined();
  });
});
