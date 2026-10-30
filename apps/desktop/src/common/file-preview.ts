/**
 * Format d'échange de l'aperçu d'un classeur Excel, servi en JSON par le main
 * (`atelier-file://`, voir main/office-preview.ts) et affiché par le renderer.
 */

export interface SheetPreview {
  name: string;
  /** Lignes non vides, valeurs déjà mises en texte (formules : résultat calculé). */
  rows: string[][];
  /** Nombre réel de lignes non vides (peut dépasser `rows.length`). */
  totalRows: number;
  /** Nombre réel de colonnes (peut dépasser la largeur des lignes). */
  totalColumns: number;
  hidden: boolean;
}

export interface WorkbookPreview {
  sheets: SheetPreview[];
}

/** Lignes servies au plus par feuille. */
export const PREVIEW_SHEET_ROWS = 500;
/** Colonnes servies au plus par feuille. */
export const PREVIEW_SHEET_COLUMNS = 50;
