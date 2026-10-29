import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLookAtTool,
  createReadFileTool,
  createVisionAnalyzer,
  findAttachment,
  listAttachments,
  UPLOADS_DIR,
} from '../src/index.js';
import { contextFor, FIXTURES, okContent, visionModel, withWorkspace } from './helpers.js';

/** Dossier de travail avec des pièces jointes dans `.atelier/uploads/`. */
async function withUploads<T>(
  names: readonly string[],
  fn: (ws: string) => Promise<T>,
): Promise<T> {
  return withWorkspace([], async (ws) => {
    await mkdir(path.join(ws, UPLOADS_DIR), { recursive: true });
    for (const name of names) {
      await copyFile(path.join(FIXTURES, name), path.join(ws, UPLOADS_DIR, name));
    }
    return fn(ws);
  });
}

const readFile = () => createReadFileTool({ cache: false });

describe('read_file : chemin de pièce jointe déformé (#59)', () => {
  it.each([
    ['.ratelier/uploads/rapport.pdf'],
    ['.rataloader/uploads/rapport.pdf'],
    ['.rapport.pdf'],
    ['rapport.pdf'],
    ['uploads/rapport.pdf'],
    ['.atelier/upload/RAPPORT.pdf'],
  ])('retrouve « %s » dans les pièces jointes et le signale', async (input) => {
    await withUploads(['rapport.pdf', 'ticket.png'], async (ws) => {
      const out = okContent(await readFile().execute({ path: input }, contextFor(ws)));
      const [note, rest] = out.split('\n\n', 2);
      expect(note).toBe(
        `[Atelier : « ${input} » introuvable, pièce jointe « .atelier/uploads/rapport.pdf » utilisée.]`,
      );
      expect(rest).toMatch(/^\[PDF : \.atelier\/uploads\/rapport\.pdf, 25 pages au total/);
    });
  });

  it('ne touche pas à un chemin correct', async () => {
    await withUploads(['rapport.pdf'], async (ws) => {
      const out = okContent(
        await readFile().execute({ path: '.atelier/uploads/rapport.pdf' }, contextFor(ws)),
      );
      expect(out).not.toContain('[Atelier :');
    });
  });

  it('liste les pièces jointes quand aucune ne correspond', async () => {
    await withUploads(['rapport.pdf', 'ticket.png'], async (ws) => {
      const out = await readFile().execute(
        { path: '.ratelier/uploads/facture.pdf' },
        contextFor(ws),
      );
      expect(out.ok).toBe(false);
      expect(out.content).toBe(
        'Fichier introuvable : .ratelier/uploads/facture.pdf. Pièces jointes disponibles : .atelier/uploads/rapport.pdf, .atelier/uploads/ticket.png. Utilise le chemin exact.',
      );
    });
  });

  it('refuse de choisir entre plusieurs candidats', async () => {
    await withUploads(['rapport.pdf'], async (ws) => {
      // « .rapport.pdf » et « rapport.pdf » ont le même nom de base sans point initial.
      await copyFile(
        path.join(FIXTURES, 'rapport.pdf'),
        path.join(ws, UPLOADS_DIR, '.rapport.pdf'),
      );
      const out = await readFile().execute({ path: '.ratelier/rapport.pdf' }, contextFor(ws));
      expect(out.ok).toBe(false);
      expect(out.content).toMatch(
        /^Fichier introuvable : \.ratelier\/rapport\.pdf\. Pièces jointes disponibles : /,
      );
    });
  });

  it('garde le message habituel sans pièces jointes', async () => {
    await withWorkspace([], async (ws) => {
      const out = await readFile().execute(
        { path: '.ratelier/uploads/rapport.pdf' },
        contextFor(ws),
      );
      expect(out).toEqual({
        ok: false,
        content: 'Fichier introuvable : .ratelier/uploads/rapport.pdf',
      });
    });
  });

  it('ne cherche que dans les pièces jointes, et pas hors du dossier de travail', async () => {
    await withUploads(['rapport.pdf'], async (ws) => {
      // Un fichier ailleurs dans le dossier n'est pas un candidat.
      await writeFile(path.join(ws, 'notes.md'), '# Notes\n');
      const other = await readFile().execute({ path: '.ratelier/notes.md' }, contextFor(ws));
      expect(other.ok).toBe(false);
      // Chemin absolu hors du dossier : la vérification reste la même (refus).
      const absolute = await readFile().execute(
        { path: '/.atelier/uploads/rapport.pdf' },
        contextFor(ws),
      );
      expect(absolute.ok).toBe(false);
      expect(absolute.content).toMatch(/en dehors du dossier de travail/);
    });
  });

  it('ignore les liens symboliques des pièces jointes', async () => {
    await withUploads([], async (ws) => {
      await symlink('/etc/hosts', path.join(ws, UPLOADS_DIR, 'hosts'));
      expect(await listAttachments(ws)).toEqual([]);
      const lookup = await findAttachment(ws, '.ratelier/uploads/hosts');
      expect(lookup.match).toBeUndefined();
      const out = await readFile().execute({ path: '.ratelier/uploads/hosts' }, contextFor(ws));
      expect(out.ok).toBe(false);
    });
  });
});

describe('look_at : chemin de pièce jointe déformé (#59)', () => {
  it('retrouve « .rataloader/uploads/ticket.png »', async () => {
    await withUploads(['ticket.png'], async (ws) => {
      const model = visionModel('TOTAL 42,00 EUR');
      const tool = createLookAtTool({ vision: createVisionAnalyzer({ model }), cache: false });
      const out = okContent(
        await tool.execute(
          { path: '.rataloader/uploads/ticket.png', question: 'Quel est le total ?' },
          contextFor(ws),
        ),
      );
      expect(out.split('\n\n')[0]).toBe(
        '[Atelier : « .rataloader/uploads/ticket.png » introuvable, pièce jointe « .atelier/uploads/ticket.png » utilisée.]',
      );
      expect(out).toContain('TOTAL 42,00 EUR');
    });
  });

  it('signale la correction même quand la réponse est un refus', async () => {
    await withUploads(['ticket.png'], async (ws) => {
      const out = await createLookAtTool({ cache: false }).execute(
        { path: '.ticket.png', question: 'Total ?' },
        contextFor(ws),
      );
      expect(out.ok).toBe(false);
      expect(out.content).toMatch(/^\[Atelier : « \.ticket\.png » introuvable, pièce jointe/);
      expect(out.content).toMatch(/Aucun modèle vision/);
    });
  });
});
