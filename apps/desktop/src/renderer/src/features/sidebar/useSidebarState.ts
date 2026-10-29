/**
 * État d'affichage de la colonne de gauche : masquée ou non (mémorisé), dossiers
 * retirés de la liste (mémorisé), et masquage automatique en fenêtre étroite.
 *
 * Les préférences vivent dans `localStorage`, toujours lu et écrit sous
 * try/catch : un stockage indisponible ne doit jamais casser l'interface.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Largeur de fenêtre sous laquelle la colonne se masque d'elle-même. */
export const NARROW_WIDTH = 1100;

export const COLLAPSED_KEY = 'atelier.sidebar.collapsed';
export const HIDDEN_FOLDERS_KEY = 'atelier.sidebar.hiddenFolders';

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Stockage plein ou refusé : la préférence ne sera simplement pas gardée.
  }
}

function readHiddenFolders(): string[] {
  const raw = readStored(HIDDEN_FOLDERS_KEY);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function isNarrow(): boolean {
  return window.innerWidth < NARROW_WIDTH;
}

export interface SidebarState {
  /** La colonne est-elle affichée ? */
  open: boolean;
  /** Fenêtre étroite : la colonne est masquée d'office (rouvrable). */
  narrow: boolean;
  toggle: () => void;
  /** Dossiers retirés de la liste (rien n'est supprimé sur le disque). */
  hiddenFolders: readonly string[];
  hideFolder: (workspace: string) => void;
  showFolder: (workspace: string) => void;
}

export function useSidebarState(): SidebarState {
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) === 'true');
  const [narrow, setNarrow] = useState(isNarrow);
  // En fenêtre étroite, une réouverture vaut pour la session d'affichage seulement.
  const [openWhileNarrow, setOpenWhileNarrow] = useState(false);
  const [hiddenFolders, setHiddenFolders] = useState(readHiddenFolders);

  const narrowRef = useRef(narrow);
  useEffect(() => {
    const onResize = (): void => {
      const next = isNarrow();
      if (next === narrowRef.current) return;
      narrowRef.current = next;
      setNarrow(next);
      setOpenWhileNarrow(false);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const toggle = useCallback(() => {
    if (narrow) {
      setOpenWhileNarrow((open) => !open);
      return;
    }
    setCollapsed((value) => {
      writeStored(COLLAPSED_KEY, String(!value));
      return !value;
    });
  }, [narrow]);

  const saveFolders = useCallback((update: (list: string[]) => string[]) => {
    setHiddenFolders((list) => {
      const next = update(list);
      writeStored(HIDDEN_FOLDERS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const hideFolder = useCallback(
    (workspace: string) => {
      saveFolders((list) => (list.includes(workspace) ? list : [...list, workspace]));
    },
    [saveFolders],
  );

  const showFolder = useCallback(
    (workspace: string) => {
      saveFolders((list) => list.filter((w) => w !== workspace));
    },
    [saveFolders],
  );

  return {
    open: narrow ? openWhileNarrow : !collapsed,
    narrow,
    toggle,
    hiddenFolders,
    hideFolder,
    showFolder,
  };
}
