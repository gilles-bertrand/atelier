/**
 * Conversion des documents bureautiques pour l'aperçu : Word en markdown
 * (même conversion que `read_file`), Excel en tableaux JSON par feuille. Rien
 * n'est exécuté : macros ignorées, formules lues par leur résultat enregistré.
 */
import ExcelJS from 'exceljs';
import { cellText, docxToMarkdown } from '@atelier/documents';
import { AtelierError } from '@atelier/shared';
import {
  PREVIEW_SHEET_COLUMNS,
  PREVIEW_SHEET_ROWS,
  type WorkbookPreview,
} from '../common/file-preview.js';

export { docxToMarkdown };

/** Feuilles d'un classeur, limitées à {@link PREVIEW_SHEET_ROWS} lignes et {@link PREVIEW_SHEET_COLUMNS} colonnes. */
export async function xlsxPreview(data: Uint8Array): Promise<WorkbookPreview> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  } catch (error) {
    throw new AtelierError('tool/failed', 'Classeur Excel illisible ou endommagé.', {
      cause: error,
    });
  }
  return {
    sheets: workbook.worksheets.map((sheet) => {
      const width = Math.min(sheet.columnCount, PREVIEW_SHEET_COLUMNS);
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        if (rows.length >= PREVIEW_SHEET_ROWS) return;
        rows.push(Array.from({ length: width }, (_, i) => cellText(row.getCell(i + 1).value)));
      });
      return {
        name: sheet.name,
        rows,
        totalRows: sheet.actualRowCount,
        totalColumns: sheet.columnCount,
        hidden: sheet.state !== 'visible',
      };
    }),
  };
}
