/**
 * Secrets (token du serveur, clés de recherche) chiffrés via `safeStorage`
 * (trousseau macOS) et stockés dans `userData/secrets.json`. Le renderer n'en
 * voit jamais la valeur : seulement leur présence.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AtelierError, type SecretId, type SecretsPresence } from '@atelier/shared';

/** Sous-ensemble de `electron.safeStorage` utilisé (injectable pour les tests). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const SECRET_IDS: readonly SecretId[] = ['llm_token', 'ollama_search_key', 'brave_search_key'];

export class SecretsStore {
  readonly #file: string;
  readonly #cipher: SecretCipher;
  /** Valeurs chiffrées, encodées en base64. */
  #encrypted: Partial<Record<SecretId, string>>;
  #writing: Promise<void> = Promise.resolve();

  private constructor(
    file: string,
    cipher: SecretCipher,
    encrypted: Partial<Record<SecretId, string>>,
  ) {
    this.#file = file;
    this.#cipher = cipher;
    this.#encrypted = encrypted;
  }

  static async load(file: string, cipher: SecretCipher): Promise<SecretsStore> {
    let encrypted: Partial<Record<SecretId, string>> = {};
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof raw === 'object' && raw !== null) {
        for (const id of SECRET_IDS) {
          const value = (raw as Record<string, unknown>)[id];
          if (typeof value === 'string') encrypted[id] = value;
        }
      }
    } catch {
      encrypted = {};
    }
    return new SecretsStore(file, cipher, encrypted);
  }

  presence(): SecretsPresence {
    return {
      llm_token: this.#encrypted.llm_token !== undefined,
      ollama_search_key: this.#encrypted.ollama_search_key !== undefined,
      brave_search_key: this.#encrypted.brave_search_key !== undefined,
    };
  }

  /** Valeur en clair (process main uniquement), ou `undefined`. */
  get(id: SecretId): string | undefined {
    const value = this.#encrypted[id];
    if (value === undefined) return undefined;
    try {
      return this.#cipher.decryptString(Buffer.from(value, 'base64'));
    } catch {
      // Trousseau changé (autre Mac, profil restauré) : le secret est perdu, on le signale absent.
      return undefined;
    }
  }

  /** Enregistre (ou efface avec `null` / chaîne vide) un secret. */
  async set(id: SecretId, value: string | null): Promise<void> {
    if (!SECRET_IDS.includes(id)) {
      throw new AtelierError('internal', `Secret inconnu : ${id as string}`);
    }
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') {
      const { [id]: _removed, ...rest } = this.#encrypted;
      this.#encrypted = rest;
    } else {
      if (!this.#cipher.isEncryptionAvailable()) {
        throw new AtelierError(
          'internal',
          'Le trousseau macOS est indisponible : impossible de protéger ce secret.',
        );
      }
      this.#encrypted[id] = this.#cipher.encryptString(trimmed).toString('base64');
    }
    await this.#persist();
  }

  #persist(): Promise<void> {
    const snapshot = { ...this.#encrypted };
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(tmp, this.#file);
    };
    this.#writing = this.#writing.then(run, run);
    return this.#writing;
  }
}
