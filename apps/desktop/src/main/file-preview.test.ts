import { copyFile, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  handlePreviewRequest,
  MAX_TEXT_BYTES,
  previewMimeType,
  previewUrl,
} from './file-preview.js';
import type { WorkbookPreview } from '../common/file-preview.js';

/** Documents Word et Excel de référence du package documents. */
const OFFICE_FIXTURES = join(import.meta.dirname, '../../../../packages/documents/test/fixtures');

let workspace: string;
let outside: string;

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'atelier-preview-ws-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'atelier-preview-out-')));
  await writeFile(join(workspace, 'note.md'), '# Titre\n\nCorps');
  await writeFile(join(workspace, 'piege.html'), '<script>alert(1)</script>');
  await writeFile(join(workspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(workspace, 'rapport.pdf'), '%PDF-1.4');
  await writeFile(join(workspace, 'archive.zip'), 'PK');
  await writeFile(join(workspace, 'gros.log'), 'a'.repeat(MAX_TEXT_BYTES + 10));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(workspace, 'lien.txt'));
  await copyFile(join(OFFICE_FIXTURES, 'compte-rendu.docx'), join(workspace, 'compte-rendu.docx'));
  await copyFile(join(OFFICE_FIXTURES, 'ventes.xlsx'), join(workspace, 'ventes.xlsx'));
  await writeFile(join(workspace, 'casse.xlsx'), 'pas un classeur');
});

const get = (path: string) => handlePreviewRequest(previewUrl(path), [workspace]);

describe('previewMimeType', () => {
  it('sert HTML et SVG en texte brut, jamais interprétés', () => {
    expect(previewMimeType('/a/page.html')).toBe('text/plain; charset=utf-8');
    expect(previewMimeType('/a/logo.SVG')).toBe('text/plain; charset=utf-8');
  });
  it('reconnaît images et PDF, ignore le reste', () => {
    expect(previewMimeType('/a/photo.JPG')).toBe('image/jpeg');
    expect(previewMimeType('/a/r.pdf')).toBe('application/pdf');
    expect(previewMimeType('/a/r.pptx')).toBeUndefined();
    expect(previewMimeType('/a/r.docx')).toBe('text/markdown; charset=utf-8');
    expect(previewMimeType('/a/app.command')).toBeUndefined();
  });
});

describe('handlePreviewRequest', () => {
  it('sert un markdown du dossier de travail, inerte (CSP sandbox, nosniff)', async () => {
    const response = await get(join(workspace, 'note.md'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# Titre\n\nCorps');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('x-atelier-truncated')).toBeNull();
  });

  it('sert un HTML piégé en texte brut', async () => {
    const response = await get(join(workspace, 'piege.html'));
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('sert une image et un PDF avec leur type', async () => {
    expect((await get(join(workspace, 'image.png'))).headers.get('content-type')).toBe('image/png');
    const pdf = await get(join(workspace, 'rapport.pdf'));
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    // La visionneuse PDF doit pouvoir s'exécuter.
    expect(pdf.headers.get('content-security-policy')).toBeNull();
  });

  it('tronque un texte trop long et le signale', async () => {
    const response = await get(join(workspace, 'gros.log'));
    expect(response.headers.get('x-atelier-truncated')).toBe('1');
    expect((await response.arrayBuffer()).byteLength).toBe(MAX_TEXT_BYTES);
  });

  it('refuse un lien symbolique qui sort du dossier de travail', async () => {
    const response = await get(join(workspace, 'lien.txt'));
    expect(response.status).toBe(403);
  });

  it('refuse un fichier hors des dossiers de travail', async () => {
    expect((await get(join(outside, 'secret.txt'))).status).toBe(403);
  });

  it('refuse un type sans aperçu', async () => {
    expect((await get(join(workspace, 'archive.zip'))).status).toBe(415);
  });

  it('refuse une URL mal formée ou un autre hôte', async () => {
    expect((await handlePreviewRequest('atelier-file://preview/', [workspace])).status).toBe(400);
    expect(
      (await handlePreviewRequest('atelier-file://autre/?path=%2Fetc%2Fhosts', [workspace])).status,
    ).toBe(400);
    expect(
      (await handlePreviewRequest('atelier-file://preview/?path=relatif.md', [workspace])).status,
    ).toBe(400);
  });

  it('convertit un document Word en markdown', async () => {
    const response = await get(join(workspace, 'compte-rendu.docx'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it('convertit un classeur Excel en feuilles JSON', async () => {
    const response = await get(join(workspace, 'ventes.xlsx'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const workbook = (await response.json()) as WorkbookPreview;
    expect(workbook.sheets.length).toBeGreaterThan(0);
    const first = workbook.sheets[0];
    expect(first?.rows.length).toBeGreaterThan(0);
    expect(first?.totalRows).toBeGreaterThanOrEqual(first?.rows.length ?? 0);
  });

  it('signale un classeur endommagé', async () => {
    const response = await get(join(workspace, 'casse.xlsx'));
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('illisible');
  });
});
