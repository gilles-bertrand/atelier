/**
 * Projets (voir `docs/adr/ADR-003-projets.md`) : un projet regroupe des
 * dossiers (un principal et des dossiers rattachés, en lecture seule ou en
 * lecture et écriture), des consignes, une mémoire, des conversations, des
 * tâches planifiées et des artefacts (pages publiées et versionnées).
 *
 * Types et fonctions pures, sans dépendance Node : le main (validation,
 * montages de la VM) et le renderer (formulaires, aperçu des chemins) partagent
 * les mêmes règles. Les chemins sont des chemins POSIX absolus (macOS).
 */
import { GUEST_FOLDERS } from './sandbox.js';

/** Accès de l'agent à un dossier du projet. */
export type ProjectFolderAccess = 'read' | 'write';

/** Dossier d'un projet. Le premier de la liste est le dossier principal. */
export interface ProjectFolder {
  /** Chemin absolu côté hôte. */
  path: string;
  /**
   * Nom court, unique dans le projet : montré au modèle (« Compta/bilan.xlsx »)
   * et dans les cartes de fichiers. Défaut : nom du dossier ({@link defaultFolderLabel}).
   */
  label: string;
  /**
   * `read` : lecture seule, appliquée par les outils et par le montage de la VM.
   * Le dossier principal est toujours `write`.
   */
  access: ProjectFolderAccess;
}

/** Projet tel que saisi (création, modification). */
export interface ProjectInput {
  /** De 1 à {@link MAX_PROJECT_NAME_CHARS} caractères. */
  name: string;
  /** Au plus {@link MAX_PROJECT_DESCRIPTION_CHARS} caractères. */
  description?: string;
  /**
   * Consignes de l'utilisateur, ajoutées au prompt système de chaque
   * conversation et de chaque run du projet (au plus {@link MAX_PROJECT_INSTRUCTIONS_CHARS}).
   */
  instructions?: string;
  /**
   * De 1 à {@link MAX_PROJECT_FOLDERS} dossiers, le premier est le principal.
   * Absent à la création : l'app crée `<projectsDir>/<nom>/` comme dossier principal.
   */
  folders?: ProjectFolder[];
}

/** Projet enregistré. */
export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Au moins un dossier ; le premier est le principal. */
  folders: ProjectFolder[];
  /** Horodatages ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** Présent : projet archivé (masqué de la colonne de gauche, tâches suspendues). */
  archivedAt?: string;
}

/** Projet avec ses compteurs (colonne de gauche, liste des projets). */
export interface ProjectSummary extends Project {
  /** Conversations du projet, runs planifiés exclus. */
  conversations: number;
  tasks: number;
  artifacts: number;
  /** Dernière activité d'une conversation du projet (ISO 8601). */
  lastActivityAt?: string;
}

/** Mémoire courante d'un projet (dernière révision). */
export interface ProjectMemory {
  /** Markdown ; vide tant que personne n'a rien écrit. */
  content: string;
  /** Numéro de la dernière révision ; `0` = jamais écrite. */
  revision: number;
  /** Date de la dernière révision (ISO 8601). */
  updatedAt?: string;
}

/** Auteur d'une révision de la mémoire. */
export type MemorySource = 'user' | 'agent';

/** Révision de la mémoire d'un projet (historique, « Revenir à cette version »). */
export interface MemoryRevision {
  revision: number;
  content: string;
  source: MemorySource;
  /** Conversation où l'agent a écrit (absente : édition de l'utilisateur ou conversation supprimée). */
  sessionId?: string;
  /** Run planifié où l'agent a écrit. */
  runId?: string;
  createdAt: string;
}

/** Format d'un artefact, déduit de l'extension du fichier publié. */
export type ArtifactFormat = 'html' | 'markdown';

/**
 * Artefact : page publiée par l'agent (`publish_artifact`). Republier le même
 * fichier crée une nouvelle version du même artefact (identité : projet et
 * chemin canonique du fichier).
 */
export interface Artifact {
  id: string;
  /** Absent : publié depuis une conversation hors projet. */
  projectId?: string;
  /** Chemin absolu canonique du fichier source. */
  path: string;
  title: string;
  description?: string;
  format: ArtifactFormat;
  /** Dernière version publiée (à partir de 1). */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Conversation qui a publié la dernière version. */
  sessionId?: string;
  /** Run planifié qui a publié la dernière version. */
  runId?: string;
  /** Nom de la tâche de ce run. */
  taskName?: string;
}

/** Version d'un artefact (sélecteur de version de la visionneuse). */
export interface ArtifactVersion {
  artifactId: string;
  version: number;
  /** Taille du contenu en octets. */
  size: number;
  createdAt: string;
  sessionId?: string;
  runId?: string;
  taskName?: string;
}

/** Ce qu'affiche la carte « Artefact publié » du chat. */
export type ArtifactCard = Pick<Artifact, 'id' | 'title' | 'version' | 'format' | 'path'>;

/** Protocole qui sert les versions d'artefacts à la visionneuse (origine isolée, ADR-003 D5). */
export const ARTIFACT_SCHEME = 'atelier-artifact';

/** Nombre maximal de dossiers d'un projet (principal compris). */
export const MAX_PROJECT_FOLDERS = 10;
export const MAX_PROJECT_NAME_CHARS = 80;
export const MAX_PROJECT_DESCRIPTION_CHARS = 500;
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 4_000;
export const MAX_FOLDER_LABEL_CHARS = 40;
/** Mémoire injectée dans le prompt système : au-delà, la fin est coupée avec une note. */
export const MEMORY_PROMPT_CHARS = 8_000;
/** Taille maximale de la mémoire enregistrée. */
export const MAX_MEMORY_CHARS = 50_000;
/** Révisions de mémoire gardées par projet (la première est toujours conservée). */
export const MAX_MEMORY_REVISIONS = 100;
/** Taille maximale d'une version d'artefact. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** Versions gardées par artefact (les plus anciennes sont purgées). */
export const MAX_ARTIFACT_VERSIONS = 30;

/** Extensions publiables et leur format. */
export const ARTIFACT_EXTENSIONS: Readonly<Record<string, ArtifactFormat>> = {
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

/** Extension en minuscules d'un chemin POSIX (`.html`), ou `''`. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Format d'artefact d'un chemin d'après son extension, ou `undefined` s'il n'est pas publiable. */
export function artifactFormatOf(path: string): ArtifactFormat | undefined {
  return ARTIFACT_EXTENSIONS[extensionOf(path)];
}

/**
 * URL d'une version d'artefact pour la visionneuse : `atelier-artifact://<id>/v<N>/`,
 * ou `atelier-artifact://<id>/latest/` sans version.
 */
export function artifactUrl(id: string, version?: number): string {
  const segment = version === undefined ? 'latest' : `v${String(version)}`;
  return `${ARTIFACT_SCHEME}://${encodeURIComponent(id)}/${segment}/`;
}

/**
 * Nom du point de montage d'un dossier rattaché dans la VM : accents retirés,
 * espaces et caractères spéciaux remplacés par `-`, au plus 40 caractères,
 * jamais vide (`dossier`). Deux libellés différents peuvent donner le même nom :
 * {@link validateProjectInput} refuse ce cas.
 */
export function folderGuestName(label: string): string {
  const name = label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, MAX_FOLDER_LABEL_CHARS)
    .replace(/-+$/g, '');
  return name === '' ? 'dossier' : name;
}

/** Chemin d'un dossier rattaché dans la VM : `/dossiers/<nom>`. */
export function folderGuestPath(label: string): string {
  return `${GUEST_FOLDERS}/${folderGuestName(label)}`;
}

/** Retire les `/` finaux d'un chemin absolu (sauf la racine). */
function trimSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Libellé par défaut d'un dossier : son nom (dernier segment), tronqué. */
export function defaultFolderLabel(path: string): string {
  const clean = trimSlashes(path);
  const name = clean.slice(clean.lastIndexOf('/') + 1).trim();
  return (name === '' ? 'Dossier' : name).slice(0, MAX_FOLDER_LABEL_CHARS);
}

/**
 * Nom du dossier créé pour un projet (`<projectsDir>/<nom>`) : `/` et `:`
 * remplacés par `-`, points de tête retirés (pas de dossier caché), espaces
 * superflus réduits ; `Projet` s'il ne reste que des tirets ou rien.
 */
export function projectDirName(name: string): string {
  const clean = name
    .replace(/[/:\\\0]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_PROJECT_NAME_CHARS)
    .trim();
  return /^[-\s]*$/.test(clean) ? 'Projet' : clean;
}

/** Vrai si `child` est `parent` ou se trouve dessous (chemins POSIX absolus, sans résolution). */
export function isSameOrInside(parent: string, child: string): boolean {
  const p = trimSlashes(parent);
  const c = trimSlashes(child);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
}

/** Problème de saisie d'un projet (message français, affiché tel quel). */
export interface ProjectValidationIssue {
  field: 'name' | 'description' | 'instructions' | 'folders';
  /** Index du dossier concerné, pour `field: 'folders'`. */
  index?: number;
  message: string;
}

function validateFolders(folders: readonly ProjectFolder[]): ProjectValidationIssue | undefined {
  const issue = (message: string, index?: number): ProjectValidationIssue => ({
    field: 'folders',
    message,
    ...(index !== undefined ? { index } : {}),
  });
  if (folders.length === 0) return issue('Ajoutez au moins un dossier.');
  if (folders.length > MAX_PROJECT_FOLDERS) {
    return issue(`Un projet compte au plus ${String(MAX_PROJECT_FOLDERS)} dossiers.`);
  }
  const labels = new Map<string, number>();
  const guestNames = new Map<string, number>();
  for (const [index, folder] of folders.entries()) {
    if (!folder.path.startsWith('/') || folder.path.includes('\0')) {
      return issue(`Chemin de dossier invalide : ${folder.path}`, index);
    }
    const label = folder.label.trim();
    if (label === '') return issue('Donnez un nom court à chaque dossier.', index);
    if (label.length > MAX_FOLDER_LABEL_CHARS) {
      return issue(
        `Le nom court « ${label} » dépasse ${String(MAX_FOLDER_LABEL_CHARS)} caractères.`,
        index,
      );
    }
    const key = label.toLocaleLowerCase('fr');
    if (labels.has(key)) return issue(`Deux dossiers portent le nom « ${label} ».`, index);
    labels.set(key, index);
    const guest = folderGuestName(label).toLowerCase();
    if (guestNames.has(guest)) {
      return issue(
        `Les noms « ${label} » et « ${folders[guestNames.get(guest) ?? 0]?.label.trim() ?? ''} » sont trop proches : choisissez-en un autre.`,
        index,
      );
    }
    guestNames.set(guest, index);
    if (index === 0 && folder.access !== 'write') {
      return issue('Le dossier principal doit être en lecture et écriture.', 0);
    }
  }
  for (const [index, folder] of folders.entries()) {
    for (const [other, candidate] of folders.entries()) {
      if (other === index) continue;
      if (trimSlashes(candidate.path) === trimSlashes(folder.path)) {
        return issue(`Le dossier ${folder.path} est ajouté deux fois.`, Math.max(index, other));
      }
      if (isSameOrInside(candidate.path, folder.path)) {
        return issue(
          `Le dossier « ${folder.label.trim()} » est déjà inclus dans « ${candidate.label.trim()} ».`,
          index,
        );
      }
    }
  }
  return undefined;
}

/**
 * Valide la saisie d'un projet : nom, longueurs, dossiers (de 1 à 10, chemins
 * absolus, noms courts uniques, principal en écriture, aucun dossier inclus
 * dans un autre). Renvoie le premier problème, ou `undefined`.
 *
 * Une modification se valide sur le projet complet (projet enregistré, puis
 * champs modifiés). Le main vérifie en plus ce qui demande le disque : dossier
 * existant, chemin canonique (liens symboliques), dossiers interdits (racine,
 * `$HOME` entier…).
 */
export function validateProjectInput(input: ProjectInput): ProjectValidationIssue | undefined {
  const name = input.name.trim();
  if (name === '') return { field: 'name', message: 'Donnez un nom au projet.' };
  if (name.length > MAX_PROJECT_NAME_CHARS) {
    return {
      field: 'name',
      message: `Le nom dépasse ${String(MAX_PROJECT_NAME_CHARS)} caractères.`,
    };
  }
  if ((input.description ?? '').length > MAX_PROJECT_DESCRIPTION_CHARS) {
    return {
      field: 'description',
      message: `La description dépasse ${String(MAX_PROJECT_DESCRIPTION_CHARS)} caractères.`,
    };
  }
  if ((input.instructions ?? '').length > MAX_PROJECT_INSTRUCTIONS_CHARS) {
    return {
      field: 'instructions',
      message: `Les consignes dépassent ${String(MAX_PROJECT_INSTRUCTIONS_CHARS)} caractères.`,
    };
  }
  return input.folders !== undefined ? validateFolders(input.folders) : undefined;
}
