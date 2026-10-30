/**
 * Aperçu de fichier de la conversation : les cartes de fichier (fil, panneau de
 * suivi) l'ouvrent sans que chaque intermédiaire relaie un callback.
 * Hors fournisseur (tests isolés, autres écrans), les cartes restent sans aperçu.
 */
import { createContext, useContext } from 'react';
import type { FileCard } from '@atelier/shared';

export interface FilePreviewControls {
  /** Chemin du fichier affiché dans l'aperçu, s'il y en a un. */
  selectedPath: string | undefined;
  /** Ouvre (ou referme si déjà affiché) l'aperçu du fichier. */
  toggle: (file: FileCard) => void;
}

export const FilePreviewContext = createContext<FilePreviewControls | null>(null);

export function useFilePreview(): FilePreviewControls | null {
  return useContext(FilePreviewContext);
}
