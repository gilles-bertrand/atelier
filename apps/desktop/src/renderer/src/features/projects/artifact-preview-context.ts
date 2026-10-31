/**
 * Ouverture d'un artefact depuis une carte du chat (ADR-003 D5) : la
 * conversation l'affiche dans le panneau droit. Hors fournisseur (tests isolés,
 * autres écrans), la carte reste informative.
 */
import { createContext, useContext } from 'react';

export interface ArtifactPreviewControls {
  /** Artefact affiché dans le panneau, s'il y en a un. */
  selectedId: string | undefined;
  /** Ouvre l'artefact (ou le referme s'il est déjà affiché). */
  toggle: (artifactId: string) => void;
}

export const ArtifactPreviewContext = createContext<ArtifactPreviewControls | null>(null);

export function useArtifactPreview(): ArtifactPreviewControls | null {
  return useContext(ArtifactPreviewContext);
}
