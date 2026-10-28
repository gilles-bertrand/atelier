import { describe, expect, it } from 'vitest';
import { AtelierError } from '@atelier/shared';
import { createLookAtTool, createVisionAnalyzer } from '../src/index.js';
import { contextFor, fakeSandbox, okContent, visionModel, withWorkspace } from './helpers.js';

describe('look_at', () => {
  it('pose la question au modèle vision sur une image', async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      const model = visionModel('42,00 EUR');
      const tool = createLookAtTool({ vision: createVisionAnalyzer({ model }) });
      const out = okContent(
        await tool.execute({ path: 'ticket.png', question: 'Quel est le total ?' }, contextFor(ws)),
      );
      expect(out).toBe('[Modèle vision, image ticket.png]\n\n42,00 EUR');
      expect(model.prompts[0]?.text).toBe('Quel est le total ?');
      // Même question : réponse en cache.
      await tool.execute({ path: 'ticket.png', question: 'Quel est le total ?' }, contextFor(ws));
      expect(model.prompts).toHaveLength(1);
      await tool.execute({ path: 'ticket.png', question: 'Quelle date ?' }, contextFor(ws));
      expect(model.prompts).toHaveLength(2);
    });
  });

  it('rend la page PDF demandée dans la VM', async () => {
    await withWorkspace(['scan.pdf'], async (ws) => {
      const model = visionModel('1 234,56 EUR');
      const sandbox = fakeSandbox(ws);
      const tool = createLookAtTool({ vision: createVisionAnalyzer({ model }), cache: false });
      const out = okContent(
        await tool.execute(
          { path: 'scan.pdf', question: 'Total TTC ?', page: 2 },
          contextFor(ws, { sandbox }),
        ),
      );
      expect(out).toBe('[Modèle vision, page 2/2 de scan.pdf]\n\n1 234,56 EUR');
      expect(sandbox.commands[0]).toMatch(/^pdftoppm -f 2 -l 2 /);
      expect(model.prompts[0]?.mediaType).toBe('image/png');
      const beyond = await tool.execute(
        { path: 'scan.pdf', question: 'x', page: 9 },
        contextFor(ws, { sandbox }),
      );
      expect(beyond.content).toBe('Page 9 inexistante : le PDF compte 2 pages.');
      const noVm = await tool.execute({ path: 'scan.pdf', question: 'x' }, contextFor(ws));
      expect(noVm.content).toMatch(/La VM n'est pas prête/);
    });
  });

  it('refuse les fichiers qui ne sont ni des images ni des PDF', async () => {
    await withWorkspace(['notes.md'], async (ws) => {
      const tool = createLookAtTool({ vision: createVisionAnalyzer({ model: visionModel('x') }) });
      const out = await tool.execute({ path: 'notes.md', question: 'x' }, contextFor(ws));
      expect(out.ok).toBe(false);
      expect(out.content).toMatch(/utilise read_file/);
    });
  });

  it('remonte l’annulation (bouton stop) au lieu d’un résultat', async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      const controller = new AbortController();
      controller.abort();
      const tool = createLookAtTool({ vision: createVisionAnalyzer({ model: visionModel('x') }) });
      await expect(
        tool.execute(
          { path: 'ticket.png', question: 'x' },
          contextFor(ws, { abortSignal: controller.signal }),
        ),
      ).rejects.toSatisfy((e) => e instanceof AtelierError && e.code === 'agent/aborted');
    });
  });
});
