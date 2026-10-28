import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAtelierError } from '@atelier/shared';
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
    expect(next.skillsDir).toBe('/Users/a/Atelier/skills');
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
