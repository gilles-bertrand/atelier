/**
 * Réglages de l'application, persistés côté main. Les secrets (token du serveur,
 * clés de recherche) ne figurent jamais ici : ils passent par `safeStorage` et
 * ne sont exposés au renderer que sous forme de booléen « configuré ».
 */
import type { LlmServerConfig } from './llm.js';
import type { SandboxResources } from './sandbox.js';
import type { SearchProviderId } from './search.js';

/** Identifiants des secrets stockés via `safeStorage`. */
export type SecretId = 'llm_token' | 'ollama_search_key' | 'brave_search_key';

/** Réglages complets de l'application. */
export interface AppSettings {
  /** Serveur LLM. */
  llm: LlmServerConfig;
  /** Ressources et réseau de la VM. */
  sandbox: SandboxResources & {
    /** Réseau sortant autorisé par défaut pour les nouvelles sessions. */
    networkEnabledByDefault: boolean;
  };
  /** Recherche web. */
  search: {
    /** Fournisseur actif (défaut `searxng`). */
    provider: SearchProviderId;
  };
  /** Dossier des skills (défaut `~/Atelier/skills`). */
  skillsDir: string;
  /** Fichier de configuration MCP (défaut `~/Atelier/mcp.json`). */
  mcpConfigPath: string;
  /**
   * Racine des dossiers créés pour les nouveaux projets (ADR-003 D2).
   * Absent = `~/Atelier/Projets`.
   */
  projectsDir?: string;
  /** Onboarding terminé. */
  onboardingCompleted: boolean;
  /** Avertissement de confidentialité accepté (horodatage ISO 8601). */
  privacyAcceptedAt?: string;
  /**
   * Ouvrir Atelier à la connexion, fenêtre masquée, pour que les tâches
   * planifiées tournent (ADR-002). Absent = `false`.
   */
  openAtLogin?: boolean;
}

/** Modification partielle (profonde au premier niveau) des réglages. */
export type AppSettingsPatch = {
  [K in keyof AppSettings]?: AppSettings[K] extends object
    ? Partial<AppSettings[K]>
    : AppSettings[K];
};

/** Présence des secrets (jamais leur valeur). */
export type SecretsPresence = Record<SecretId, boolean>;
