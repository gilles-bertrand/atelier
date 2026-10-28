import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHandlers, type HandlerServices } from './handlers.js';
import { resolveOpenable } from './safe-open.js';

let workspace: string;
let outside: string;

beforeAll(async () => {
  // realpath : sur macOS, tmpdir() passe par /var → /private/var.
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'atelier-open-ws-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'atelier-open-out-')));
  await writeFile(join(workspace, 'rapport.pdf'), '%PDF-1.4');
  await writeFile(join(workspace, 'script.command'), '#!/bin/sh\necho pwned');
  await mkdir(join(workspace, 'Faux.app', 'Contents'), { recursive: true });
  await mkdir(join(outside, 'Terminal.app', 'Contents'), { recursive: true });
  await writeFile(join(outside, 'secret.pdf'), '%PDF-1.4');
  await mkdir(join(workspace, 'docs'));
  await writeFile(join(workspace, 'docs', 'note.md'), '# Note');
  // Pièges : liens qui « ressemblent » à des documents.
  await symlink(join(outside, 'Terminal.app'), join(workspace, 'facture.pdf'));
  await symlink(join(outside, 'secret.pdf'), join(workspace, 'copie.pdf'));
  await symlink(join(workspace, 'docs', 'note.md'), join(workspace, 'lien-interne.md'));
});

const reject = (path: string, mode: 'open' | 'reveal' = 'open') =>
  expect(resolveOpenable(path, [workspace], mode)).rejects;

describe('resolveOpenable', () => {
  it('accepte un vrai PDF du dossier de travail', async () => {
    expect(await resolveOpenable(join(workspace, 'rapport.pdf'), [workspace], 'open')).toBe(
      join(workspace, 'rapport.pdf'),
    );
  });

  it('refuse un lien symbolique « .pdf » vers une application', async () => {
    await reject(join(workspace, 'facture.pdf')).toMatchObject({
      code: 'tool/path_outside_workspace',
    });
  });

  it('refuse un lien vers un fichier hors du dossier', async () => {
    await reject(join(workspace, 'copie.pdf')).toMatchObject({
      code: 'tool/path_outside_workspace',
    });
    await reject(join(outside, 'secret.pdf')).toMatchObject({
      code: 'tool/path_outside_workspace',
    });
    await reject(join(workspace, '..', 'x.pdf')).toMatchObject({
      code: 'tool/path_outside_workspace',
    });
  });

  it('refuse une extension hors liste blanche et un bundle .app', async () => {
    await reject(join(workspace, 'script.command')).toMatchObject({
      code: 'tool/failed',
      details: { kind: 'blocked_open' },
    });
    await reject(join(workspace, 'Faux.app')).toMatchObject({ code: 'tool/failed' });
  });

  it('suit un lien interne et renvoie le chemin réel', async () => {
    expect(await resolveOpenable(join(workspace, 'lien-interne.md'), [workspace], 'open')).toBe(
      join(workspace, 'docs', 'note.md'),
    );
  });

  it('« Afficher dans le Finder » accepte dossiers et scripts, jamais l’extérieur', async () => {
    expect(await resolveOpenable(join(workspace, 'script.command'), [workspace], 'reveal')).toBe(
      join(workspace, 'script.command'),
    );
    expect(await resolveOpenable(join(workspace, 'docs'), [workspace], 'reveal')).toBe(
      join(workspace, 'docs'),
    );
    await reject(join(workspace, 'facture.pdf'), 'reveal').toMatchObject({
      code: 'tool/path_outside_workspace',
    });
  });

  it('refuse un chemin relatif ou un fichier absent', async () => {
    await reject('rapport.pdf').toMatchObject({ code: 'tool/invalid_input' });
    await reject(join(workspace, 'absent.pdf')).toMatchObject({
      code: 'tool/path_outside_workspace',
    });
  });
});

describe('file:open / file:reveal', () => {
  const setup = () => {
    const openPath = vi.fn(() => Promise.resolve(''));
    const showItemInFolder = vi.fn();
    const s = {
      chats: {
        list: () => [{ id: 's', title: '', workspace, createdAt: '', updatedAt: '' }],
      },
      shell: { openPath, showItemInFolder, chooseDirectory: vi.fn() },
    } as unknown as HandlerServices;
    return { handlers: createHandlers(s), openPath, showItemInFolder };
  };

  it('ouvre le chemin réel d’un document, jamais une application derrière un lien', async () => {
    const { handlers, openPath } = setup();
    await handlers['file:open']?.({ absolutePath: join(workspace, 'rapport.pdf') });
    expect(openPath).toHaveBeenCalledWith(join(workspace, 'rapport.pdf'));
    await expect(
      Promise.resolve().then(() =>
        handlers['file:open']?.({ absolutePath: join(workspace, 'facture.pdf') }),
      ),
    ).rejects.toMatchObject({ code: 'tool/path_outside_workspace' });
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it('affiche un script dans le Finder sans l’ouvrir', async () => {
    const { handlers, openPath, showItemInFolder } = setup();
    await handlers['file:reveal']?.({ absolutePath: join(workspace, 'script.command') });
    expect(showItemInFolder).toHaveBeenCalledWith(join(workspace, 'script.command'));
    expect(openPath).not.toHaveBeenCalled();
  });
});
