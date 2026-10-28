import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertWorkspace, createHandlers, isWithin, type HandlerServices } from './handlers.js';

describe('isWithin', () => {
  it('reconnaît les chemins internes et refuse les sorties', () => {
    expect(isWithin('/w', '/w/a/b.txt')).toBe(true);
    expect(isWithin('/w', '/w')).toBe(true);
    expect(isWithin('/w', '/w/../etc/passwd')).toBe(false);
    expect(isWithin('/w', '/wx/a')).toBe(false);
    expect(isWithin('/w', '/w/..secret')).toBe(true);
  });
});

describe('assertWorkspace', () => {
  it('refuse la racine, le $HOME entier et un fichier', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atelier-home-'));
    await expect(assertWorkspace('/', home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    await expect(assertWorkspace(home, home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    const file = join(home, 'f.txt');
    await writeFile(file, '');
    await expect(assertWorkspace(file, home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    await expect(assertWorkspace('relatif', home)).rejects.toMatchObject({
      code: 'sandbox/invalid_workspace',
    });
    expect(await assertWorkspace(tmpdir(), home)).toBeTruthy();
  });
});

describe('file:open', () => {
  const services = (workspace: string) => {
    const openPath = vi.fn(() => Promise.resolve(''));
    const s = {
      chats: { list: () => [{ id: 's', title: '', workspace, createdAt: '', updatedAt: '' }] },
      shell: { openPath, showItemInFolder: vi.fn(), chooseDirectory: vi.fn() },
    } as unknown as HandlerServices;
    return { handlers: createHandlers(s), openPath };
  };

  it('ouvre un document du dossier de travail', async () => {
    const { handlers, openPath } = services('/w');
    await handlers['file:open']?.({ absolutePath: '/w/recap.xlsx' });
    expect(openPath).toHaveBeenCalledWith('/w/recap.xlsx');
  });

  it('refuse hors dossier et les exécutables', async () => {
    const { handlers, openPath } = services('/w');
    await expect(
      Promise.resolve().then(() => handlers['file:open']?.({ absolutePath: '/etc/hosts' })),
    ).rejects.toMatchObject({
      code: 'tool/path_outside_workspace',
    });
    await expect(
      Promise.resolve().then(() => handlers['file:open']?.({ absolutePath: '/w/run.command' })),
    ).rejects.toMatchObject({
      code: 'tool/failed',
    });
    expect(openPath).not.toHaveBeenCalled();
  });
});
