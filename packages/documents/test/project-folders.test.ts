/** Dossiers rattachés d'un projet (ADR-003) : read_file et rendu des pages de PDF. */
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspaceFolder } from '@atelier/shared';
import { createReadFileTool, renderPdfPage } from '../src/index.js';
import { contextFor, fakeSandbox, okContent, withWorkspace } from './helpers.js';

/** Dossier principal `Projet` et dossier rattaché `Compta` (lecture seule), canoniques. */
async function layout(base: string): Promise<{ primary: string; folder: WorkspaceFolder }> {
  const root = await realpath(base);
  const primary = path.join(root, 'Projet');
  const compta = path.join(root, 'Compta');
  await mkdir(primary);
  await mkdir(compta);
  return {
    primary,
    folder: { path: compta, label: 'Compta', access: 'read', guestPath: '/dossiers/Compta' },
  };
}

describe('documents dans un projet', () => {
  it('read_file lit « Compta/… » et le chemin absolu d’un dossier rattaché', async () => {
    await withWorkspace([], async (base) => {
      const { primary, folder } = await layout(base);
      await writeFile(path.join(folder.path, 'notes.txt'), 'Bilan 2026\n');
      const tool = createReadFileTool({ cache: false });
      const context = contextFor(primary, { folders: [folder] });
      expect(okContent(await tool.execute({ path: 'Compta/notes.txt' }, context))).toContain(
        'Bilan 2026',
      );
      expect(
        okContent(await tool.execute({ path: path.join(folder.path, 'notes.txt') }, context)),
      ).toContain('Bilan 2026');
      // Sans le dossier rattaché, le même chemin absolu est refusé.
      const refused = await tool.execute(
        { path: path.join(folder.path, 'notes.txt') },
        contextFor(primary),
      );
      expect(refused).toMatchObject({ ok: false });
    });
  });

  it('rend une page d’un PDF rattaché via son chemin dans la VM (/dossiers/…)', async () => {
    await withWorkspace([], async (base) => {
      const { primary, folder } = await layout(base);
      const pdf = path.join(folder.path, 'scan.pdf');
      await writeFile(pdf, '%PDF-1.4');
      const vm = fakeSandbox(primary);
      const guest = vm.toGuestPath.bind(vm);
      vm.toGuestPath = (host: string) =>
        host.startsWith(`${folder.path}/`)
          ? `/dossiers/Compta/${path.relative(folder.path, host)}`
          : guest(host);
      const png = await renderPdfPage({
        sandbox: vm,
        workspace: primary,
        relativePath: 'Compta/scan.pdf',
        absolutePath: pdf,
        fileHash: 'abc123',
        page: 1,
      });
      expect(png.byteLength).toBeGreaterThan(0);
      expect(vm.commands[0]).toContain("'/dossiers/Compta/scan.pdf'");
      // La sortie reste dans le dossier principal (/workspace/.atelier/pages).
      expect(vm.commands[0]).toContain("'/workspace/.atelier/cache/pages/");
    });
  });

  it('refuse clairement un PDF invisible dans la VM', async () => {
    await withWorkspace([], async (base) => {
      const { primary, folder } = await layout(base);
      const pdf = path.join(folder.path, 'scan.pdf');
      await writeFile(pdf, '%PDF-1.4');
      await expect(
        renderPdfPage({
          sandbox: fakeSandbox(primary),
          workspace: primary,
          relativePath: 'Compta/scan.pdf',
          absolutePath: pdf,
          fileHash: 'abc123',
          page: 1,
        }),
      ).rejects.toMatchObject({ code: 'tool/failed' });
    });
  });
});
