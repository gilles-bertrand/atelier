import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '@atelier/shared';
import { guessMimeType, importAttachments } from './attachments.js';
import { PermissionBroker } from './permission-broker.js';

const request = (id: string, sessionId = 's1', scopeKey = 'write_file'): PermissionRequest => ({
  id,
  sessionId,
  toolCallId: 'c',
  toolName: 'write_file',
  kind: 'file_write',
  title: 'Écrire a.md',
  scopeKey,
  input: {},
});

describe('PermissionBroker', () => {
  it('attend la réponse de la modale et mémorise « toujours pour la session »', async () => {
    const broker = new PermissionBroker();
    const handler = broker.handlerFor('s1');
    const first = handler(request('r1'));
    expect(broker.pending().map((r) => r.id)).toEqual(['r1']);
    broker.respond('r1', 'allow_session');
    expect(await first).toBe('allow_session');
    // Même portée : plus de modale.
    expect(await handler(request('r2'))).toBe('allow_session');
    expect(broker.pending()).toEqual([]);
  });

  it('refuse sur annulation et via denyAll', async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const pending = broker.handlerFor('s1')(request('r1'), controller.signal);
    controller.abort();
    expect(await pending).toBe('deny');
    const other = broker.handlerFor('s2')(request('r2', 's2'));
    broker.denyAll('s2');
    expect(await other).toBe('deny');
    expect(broker.respond('inconnu', 'allow_once')).toBe(false);
  });
});

describe('pièces jointes', () => {
  it('copie dans .atelier/uploads via documents et renvoie des Attachment', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'atelier-ws-'));
    const source = join(await mkdtemp(join(tmpdir(), 'atelier-src-')), 'facture.pdf');
    await writeFile(source, '%PDF-1.4 test');
    const [first] = await importAttachments(workspace, [source]);
    expect(first).toEqual({
      path: '.atelier/uploads/facture.pdf',
      name: 'facture.pdf',
      size: 13,
      mimeType: 'application/pdf',
    });
    expect(await readFile(join(workspace, '.atelier/uploads/facture.pdf'), 'utf8')).toBe(
      '%PDF-1.4 test',
    );
  });

  it('devine le type MIME', () => {
    expect(guessMimeType('Ticket.JPG')).toBe('image/jpeg');
    expect(guessMimeType('inconnu.xyz')).toBeUndefined();
  });
});
