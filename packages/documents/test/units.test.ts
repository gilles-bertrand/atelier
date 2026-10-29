import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  cellText,
  decodeText,
  describePages,
  importAttachment,
  importAttachments,
  toAttachment,
  markdownTable,
  MAX_OUTPUT_TOKENS,
  outputTokensForContext,
  parsePageRange,
  prepareImage,
  sanitizeFileName,
  shellQuote,
  UPLOADS_DIR,
  windowLines,
} from '../src/index.js';
import { estimateTokens, TOOL_OUTPUT_SHARE } from '@atelier/agent-core';
import { FIXTURES, withWorkspace } from './helpers.js';

describe('encodage', () => {
  it('UTF-8, BOM, UTF-16 et repli latin-1', () => {
    expect(decodeText(Buffer.from('é', 'utf8'))).toEqual({
      text: 'é',
      encoding: 'utf-8',
      bom: false,
    });
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).text).toBe('a');
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x61, 0x00])).encoding).toBe('utf-16le');
    expect(decodeText(Buffer.from([0xe9, 0x80]))).toEqual({
      text: 'é€',
      encoding: 'latin-1',
      bom: false,
    });
  });
});

describe('pages et lignes', () => {
  it('analyse les intervalles de pages', () => {
    expect(parsePageRange('3', 10)).toEqual([3]);
    expect(parsePageRange('8-', 10)).toEqual([8, 9, 10]);
    expect(parsePageRange(' 1-2 , 5,2 ', 10)).toEqual([1, 2, 5]);
    expect(parsePageRange('9-30', 10)).toEqual([9, 10]);
    expect(() => parsePageRange('0', 10)).toThrow(/invalide/);
    expect(() => parsePageRange('5-2', 10)).toThrow(/invalide/);
    expect(() => parsePageRange('1-21', 30)).toThrow(/20 au plus/);
    expect(describePages([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10');
  });

  it('coupe les lignes trop longues', () => {
    const { body } = windowLines('x'.repeat(2500), {}, false);
    expect(body).toHaveLength(2000 + '… [ligne tronquée]'.length);
  });

  it('borne la fenêtre au budget de tokens', () => {
    const text = Array.from({ length: 100 }, (_, i) => `ligne ${i + 1} ${'x'.repeat(90)}`).join(
      '\n',
    );
    const w = windowLines(text, {}, true, 300);
    expect(estimateTokens(w.body)).toBeLessThanOrEqual(300);
    expect(w.last).toBeLessThan(100);
  });

  it('dérive le budget de sortie de la fenêtre de contexte', () => {
    expect(outputTokensForContext(32_768)).toBe(6_553);
    expect(outputTokensForContext(131_072, 0.1)).toBe(13_107);
    expect(outputTokensForContext(1_000)).toBe(500);
    // Sous le plafond d'agent-core pour une sortie d'outil (25 % de la fenêtre).
    expect(MAX_OUTPUT_TOKENS).toBeLessThan(32_768 * TOOL_OUTPUT_SHARE);
  });
});

describe('office', () => {
  it('formate cellules et tables', () => {
    expect(cellText({ formula: 'A1*2', result: 4 })).toBe('4');
    expect(cellText({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(cellText({ text: 'site', hyperlink: 'https://x' })).toBe('site');
    expect(cellText({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(cellText(new Date('2026-01-02T10:30:00Z'))).toBe('2026-01-02 10:30');
    expect(markdownTable([['a', 'b'], ['1']])).toBe('| a | b |\n| --- | --- |\n| 1 |  |');
  });
});

describe('images', () => {
  it('réduit à 1568 px sans agrandir', async () => {
    const big = await prepareImage(await readFile(path.join(FIXTURES, 'ticket.png')), 'png');
    expect([big.width, big.height, big.originalWidth, big.mediaType]).toEqual([
      1568,
      784,
      2400,
      'image/png',
    ]);
    const small = await prepareImage(await readFile(path.join(FIXTURES, 'photo.jpg')), 'jpeg');
    expect([small.width, small.height, small.mediaType]).toEqual([800, 600, 'image/jpeg']);
  });

  it('refuse une image corrompue', async () => {
    await expect(prepareImage(Buffer.from('pas une image'), 'png')).rejects.toThrow(/illisible/);
  });
});

describe('cache et shell', () => {
  it('clé stable quel que soit l’ordre des champs', () => {
    expect(cacheKey({ a: 1, b: 'x' })).toBe(cacheKey({ b: 'x', a: 1, c: undefined }));
    expect(cacheKey({ a: 1 })).not.toBe(cacheKey({ a: 2 }));
  });

  it('échappe les guillemets simples', () => {
    expect(shellQuote("/workspace/l'été.pdf")).toBe(`'/workspace/l'\\''été.pdf'`);
  });
});

describe('importAttachment', () => {
  it('copie dans .atelier/uploads, réutilise un doublon identique, suffixe sinon', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'atelier-src-'));
    try {
      await writeFile(path.join(src, 'facture.pdf'), 'v1');
      await withWorkspace([], async (ws) => {
        const first = await importAttachment(path.join(src, 'facture.pdf'), ws);
        expect(first).toMatchObject({
          relativePath: `${UPLOADS_DIR}/facture.pdf`,
          size: 2,
          reused: false,
        });
        expect(await readFile(path.join(ws, first.relativePath), 'utf8')).toBe('v1');
        expect(toAttachment(first)).toEqual({
          path: `${UPLOADS_DIR}/facture.pdf`,
          name: 'facture.pdf',
          mimeType: 'text/plain',
          size: 2,
        });
        const same = await importAttachment(path.join(src, 'facture.pdf'), ws);
        expect(same).toMatchObject({ relativePath: first.relativePath, reused: true });
        await writeFile(path.join(src, 'facture.pdf'), 'v2');
        const other = await importAttachment(path.join(src, 'facture.pdf'), ws);
        expect(other.relativePath).toBe(`${UPLOADS_DIR}/facture (2).pdf`);
      });
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('importAttachments renvoie des Attachment (nom d’origine, type MIME par signature)', async () => {
    await withWorkspace([], async (ws) => {
      const attachments = await importAttachments(
        [path.join(FIXTURES, 'rapport.pdf'), path.join(FIXTURES, 'notes.md')],
        ws,
      );
      expect(attachments).toEqual([
        {
          path: `${UPLOADS_DIR}/rapport.pdf`,
          name: 'rapport.pdf',
          mimeType: 'application/pdf',
          size: expect.any(Number) as number,
        },
        { path: `${UPLOADS_DIR}/notes.md`, name: 'notes.md', mimeType: 'text/markdown', size: 66 },
      ]);
    });
  });

  it('refuse un dossier, un fichier trop gros et un uploads qui sort du dossier', async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), 'atelier-src-'));
    try {
      await writeFile(path.join(src, 'a.txt'), '12345');
      await withWorkspace([], async (ws) => {
        await expect(importAttachment(src, ws)).rejects.toThrow(/n'est pas un fichier/);
        await expect(
          importAttachment(path.join(src, 'a.txt'), ws, { maxBytes: 4 }),
        ).rejects.toThrow(/trop volumineuse/);
        await mkdir(path.join(ws, '.atelier'));
        await symlink(src, path.join(ws, '.atelier', 'uploads'));
        await expect(importAttachment(path.join(src, 'a.txt'), ws)).rejects.toThrow(
          /en dehors du dossier de travail/,
        );
      });
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('assainit les noms de fichiers', () => {
    expect(sanitizeFileName('../../.bashrc')).toBe('bashrc');
    expect(sanitizeFileName('Relevé\u0007 : mai?.PDF')).toBe('Relevé_ _ mai_.PDF');
    expect(sanitizeFileName('.')).toBe('piece-jointe');
  });
});
