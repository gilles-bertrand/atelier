import { describe, expect, it } from 'vitest';
import { extensionOf, FILE_TILE_CLASSES, fileType, type FileKind } from './file-types';

describe('extensionOf', () => {
  it('prend la dernière extension, en minuscules, chemin compris', () => {
    expect(extensionOf('rapports/ventes.T3.XLSX')).toBe('xlsx');
    expect(extensionOf('archives-2025.tar.gz')).toBe('gz');
  });

  it('ignore les fichiers cachés et les noms sans extension', () => {
    expect(extensionOf('.env')).toBeUndefined();
    expect(extensionOf('Makefile')).toBeUndefined();
    expect(extensionOf('notes.')).toBeUndefined();
  });
});

describe('fileType', () => {
  it.each<[string, FileKind, string]>([
    ['ventes-T3.xlsx', 'sheet', 'XLSX'],
    ['releve-banque.csv', 'sheet', 'CSV'],
    ['synthese.docx', 'doc', 'DOCX'],
    ['contrat-bail.pdf', 'pdf', 'PDF'],
    ['presentation-CA.pptx', 'slides', 'PPTX'],
    ['facture-octobre.HEIC', 'image', 'HEIC'],
    ['graphique.py', 'code', 'PY'],
    ['export-clients.json', 'data', 'JSON'],
    ['archives-2025.zip', 'archive', 'ZIP'],
    ['notes.md', 'text', 'MD'],
    ['plan.dwg', 'other', 'DWG'],
  ])('%s → %s (%s)', (name, kind, label) => {
    expect(fileType(name)).toEqual({ kind, label });
  });

  it('coupe le libellé à quatre caractères', () => {
    expect(fileType('budget.numbers')).toEqual({ kind: 'sheet', label: 'NUMB' });
  });

  it('reconnaît une image par son type MIME quand l’extension est inconnue', () => {
    expect(fileType('capture', 'image/png')).toEqual({ kind: 'image' });
    expect(fileType('capture')).toEqual({ kind: 'other' });
  });

  it('a une tuile pour chaque famille', () => {
    for (const kind of Object.keys(FILE_TILE_CLASSES) as FileKind[]) {
      expect(FILE_TILE_CLASSES[kind]).toMatch(/^bg-\S+ text-\S+$/);
    }
  });
});
