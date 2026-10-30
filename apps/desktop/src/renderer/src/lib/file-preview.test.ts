import { describe, expect, it } from 'vitest';
import { detectDelimiter, filePreviewUrl, parseDelimited, previewMode } from './file-preview';

describe('previewMode', () => {
  it('choisit le rendu selon l’extension', () => {
    expect(previewMode('/w/photo.JPG')).toBe('image');
    expect(previewMode('/w/rapport.pdf')).toBe('pdf');
    expect(previewMode('/w/synthese.md')).toBe('markdown');
    expect(previewMode('/w/ventes.csv')).toBe('table');
    expect(previewMode('/w/page.html')).toBe('text');
    expect(previewMode('/w/logo.svg')).toBe('text');
    expect(previewMode('/w/.env')).toBe('text');
  });
  it('passe Word et Excel par la conversion du main', () => {
    expect(previewMode('/w/recap.xlsx')).toBe('workbook');
    expect(previewMode('/w/macro.XLSM')).toBe('workbook');
    expect(previewMode('/w/lettre.docx')).toBe('document');
  });
  it('n’offre pas d’aperçu pour les autres formats', () => {
    expect(previewMode('/w/slides.pptx')).toBe('none');
    expect(previewMode('/w/ancien.xls')).toBe('none');
    expect(previewMode('/w/Makefile')).toBe('none');
  });
});

describe('filePreviewUrl', () => {
  it('encode le chemin et porte la révision', () => {
    expect(filePreviewUrl('/Users/a b/é.md', 3)).toBe(
      'atelier-file://preview/?path=%2FUsers%2Fa%20b%2F%C3%A9.md&v=3',
    );
  });
});

describe('CSV', () => {
  it('détecte le point-virgule d’Excel en français', () => {
    expect(detectDelimiter('Nom;Montant\nA;1,5', '/w/a.csv')).toBe(';');
    expect(detectDelimiter('a,b,c\n1,2,3', '/w/a.csv')).toBe(',');
    expect(detectDelimiter('a,b', '/w/a.tsv')).toBe('\t');
  });

  it('gère guillemets, guillemets doublés, retours à la ligne et BOM', () => {
    const text = '﻿nom,note\r\n"Dupont, Jean","il a dit ""oui""\nensuite"\r\nMarie,ok\n';
    expect(parseDelimited(text, ',').rows).toEqual([
      ['nom', 'note'],
      ['Dupont, Jean', 'il a dit "oui"\nensuite'],
      ['Marie', 'ok'],
    ]);
  });

  it('s’arrête à maxRows et le signale', () => {
    const table = parseDelimited('a\nb\nc\nd\n', ',', 2);
    expect(table).toEqual({ rows: [['a'], ['b']], truncated: true });
    expect(parseDelimited('a\nb\n', ',', 2).truncated).toBe(false);
  });
});
