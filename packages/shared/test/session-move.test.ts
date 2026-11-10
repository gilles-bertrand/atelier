/** Déplacement d'une conversation par glisser-déposer (#21). */
import { describe, expect, it } from 'vitest';
import {
  ATELIER_ERROR_CODES,
  checkSessionMove,
  IPC_RENDERER_INVOKE_CHANNELS,
  type Project,
} from '../src/index.js';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Offre Jambes',
  description: '',
  instructions: '',
  folders: [
    { path: '/Users/g/YodAI/Projets/Offre', label: 'Offre', access: 'write' },
    { path: '/Users/g/Compta', label: 'Compta', access: 'read' },
  ],
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  ...over,
});

describe('checkSessionMove', () => {
  it('accepte une conversation dont le dossier est le dossier principal du projet', () => {
    expect(checkSessionMove({ workspace: '/Users/g/YodAI/Projets/Offre/' }, project())).toBe(
      undefined,
    );
  });

  it('refuse un autre dossier, même rattaché au projet (le dossier de travail ne change jamais)', () => {
    for (const workspace of [
      '/Users/g/Compta',
      '/Users/g/Autre',
      '/Users/g/YodAI/Projets/Offre/sous',
    ]) {
      expect(checkSessionMove({ workspace }, project())).toMatch(
        /autre dossier que celui du projet « Offre Jambes »/,
      );
    }
  });

  it('sortir d’un projet, ou rester dans le même, est toujours permis', () => {
    expect(checkSessionMove({ workspace: '/x', projectId: 'p1' }, undefined)).toBeUndefined();
    expect(checkSessionMove({ workspace: '/x', projectId: 'p1' }, project())).toBeUndefined();
  });

  it('refuse un projet archivé et le run d’une tâche planifiée', () => {
    expect(
      checkSessionMove(
        { workspace: '/Users/g/YodAI/Projets/Offre' },
        project({ archivedAt: '2026-11-10T11:00:00.000Z' }),
      ),
    ).toMatch(/archivé/);
    expect(
      checkSessionMove({ workspace: '/x', projectId: 'p1', scheduledTaskId: 't1' }, undefined),
    ).toMatch(/tâche planifiée/);
  });

  it('contrat : canal session:set-project et code session/move_refused', () => {
    expect(IPC_RENDERER_INVOKE_CHANNELS).toContain('session:set-project');
    expect(ATELIER_ERROR_CODES).toContain('session/move_refused');
  });
});
