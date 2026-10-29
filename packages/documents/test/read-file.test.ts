import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDocumentTools,
  createReadFileTool,
  createVisionAnalyzer,
  CACHE_DIR,
  VISION_INSTRUCTIONS,
} from '../src/index.js';
import { contextFor, fakeSandbox, okContent, visionModel, withWorkspace } from './helpers.js';

const noCacheTool = (options: Parameters<typeof createReadFileTool>[0] = {}) =>
  createReadFileTool({ cache: false, ...options });

describe('read_file : texte', () => {
  it('numérote les lignes d’un markdown', async () => {
    await withWorkspace(['notes.md'], async (ws) => {
      const out = okContent(await noCacheTool().execute({ path: 'notes.md' }, contextFor(ws)));
      expect(out).toContain('     1\t# Notes');
      expect(out).toContain('     3\tRéunion du lundi : budget validé.');
      expect(out).not.toContain('[lignes');
    });
  });

  it('détecte le latin-1 et le convertit', async () => {
    await withWorkspace(['latin1.txt'], async (ws) => {
      const out = okContent(await noCacheTool().execute({ path: 'latin1.txt' }, contextFor(ws)));
      expect(out).toContain('[encodage détecté : latin-1, converti en UTF-8]');
      expect(out).toContain('Château de Fontainebleau');
      expect(out).toContain('Élève : François Gaël');
    });
  });

  it('applique offset/limit et borne à 2000 lignes', async () => {
    await withWorkspace([], async (ws) => {
      const lines = Array.from({ length: 2500 }, (_, i) => `ligne ${i + 1}`).join('\n');
      await writeFile(path.join(ws, 'long.csv'), lines);
      // Budget par défaut (24 000 caractères) : la fenêtre s'arrête avant 2000 lignes.
      const bounded = okContent(await noCacheTool().execute({ path: 'long.csv' }, contextFor(ws)));
      expect(bounded.length).toBeLessThanOrEqual(24_000 + 500); // corps + en-tête et rappel de fin
      expect(bounded).toMatch(/^\[lignes 1-1\d{3} sur 2500 ; suite avec offset: 1\d{3}\]/);
      const tool = noCacheTool({ maxOutputChars: 100_000 });
      const first = okContent(await tool.execute({ path: 'long.csv' }, contextFor(ws)));
      expect(first).toContain('[lignes 1-2000 sur 2500 ; suite avec offset: 2001]');
      expect(first).toContain('  2000\tligne 2000');
      expect(first).not.toContain('ligne 2001');
      const window = okContent(
        await tool.execute({ path: 'long.csv', offset: 10, limit: 3 }, contextFor(ws)),
      );
      expect(window.split('\n')).toEqual([
        '[lignes 10-12 sur 2500 ; suite avec offset: 13]',
        '    10\tligne 10',
        '    11\tligne 11',
        '    12\tligne 12',
        '[Sortie limitée : lignes 10-12 sur 2500. Suite : read_file({ path: "long.csv", offset: 13 }). Pour calculer sur tout le fichier (totaux, filtres, regroupements), préfère un script dans la VM (bash) plutôt que de le lire en entier.]',
      ]);
    });
  });

  it('gère le fichier vide et le CRLF', async () => {
    await withWorkspace([], async (ws) => {
      await writeFile(path.join(ws, 'vide.txt'), '');
      await writeFile(path.join(ws, 'crlf.txt'), 'a\r\nb\r\n');
      const tool = noCacheTool();
      expect(okContent(await tool.execute({ path: 'vide.txt' }, contextFor(ws)))).toContain(
        '(fichier vide)',
      );
      expect(okContent(await tool.execute({ path: 'crlf.txt' }, contextFor(ws)))).toBe(
        '     1\ta\n     2\tb',
      );
    });
  });
});

describe('read_file : sécurité et refus', () => {
  it('refuse un chemin hors du dossier, y compris via un lien symbolique', async () => {
    await withWorkspace([], async (ws) => {
      const outside = await import('node:fs/promises').then((fs) =>
        fs.mkdtemp(path.join(os.tmpdir(), 'atelier-outside-')),
      );
      await writeFile(path.join(outside, 'secret.txt'), 'mot de passe');
      await symlink(path.join(outside, 'secret.txt'), path.join(ws, 'lien.txt'));
      await symlink(outside, path.join(ws, 'dossier'));
      const tool = noCacheTool();
      for (const p of [
        '../secret.txt',
        path.join(outside, 'secret.txt'),
        'lien.txt',
        'dossier/secret.txt',
      ]) {
        const out = await tool.execute({ path: p }, contextFor(ws));
        expect(out.ok).toBe(false);
        expect(out.content).toMatch(/en dehors du dossier de travail/);
        expect(out.content).not.toContain('mot de passe');
      }
    });
  });

  it('signale un fichier introuvable ou un dossier', async () => {
    await withWorkspace([], async (ws) => {
      await mkdir(path.join(ws, 'sous'));
      const tool = noCacheTool();
      expect((await tool.execute({ path: 'absent.md' }, contextFor(ws))).content).toBe(
        'Fichier introuvable : absent.md',
      );
      const dir = await tool.execute({ path: 'sous' }, contextFor(ws));
      expect(dir.ok).toBe(false);
      expect(dir.content).toMatch(/dossier/);
    });
  });

  it('refuse un binaire inconnu en indiquant le type détecté', async () => {
    await withWorkspace([], async (ws) => {
      await writeFile(
        path.join(ws, 'app.bin'),
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array<number>(60).fill(0)]),
      );
      await writeFile(path.join(ws, 'data.dat'), Buffer.from([1, 2, 0, 3, 4, 0, 5]));
      await writeFile(path.join(ws, 'archive.zip'), Buffer.from('504b0304140000000000', 'hex'));
      const tool = noCacheTool();
      const elf = await tool.execute({ path: 'app.bin' }, contextFor(ws));
      expect(elf.ok).toBe(false);
      expect(elf.content).toMatch(/Format non pris en charge : « app\.bin » est un fichier ELF/);
      const dat = await tool.execute({ path: 'data.dat' }, contextFor(ws));
      expect(dat.content).toMatch(/binaire \.dat/);
      const zip = await tool.execute({ path: 'archive.zip' }, contextFor(ws));
      expect(zip.content).toMatch(/ZIP/);
    });
  });

  it('se fie aux magic bytes plutôt qu’à l’extension', async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      await writeFile(path.join(ws, 'pas-une-image.png'), 'simple texte\n');
      const { readFile } = await import('node:fs/promises');
      await writeFile(path.join(ws, 'image.txt'), await readFile(path.join(ws, 'ticket.png')));
      const vision = createVisionAnalyzer({ model: visionModel('Un ticket.') });
      const tool = noCacheTool({ vision });
      expect(okContent(await tool.execute({ path: 'pas-une-image.png' }, contextFor(ws)))).toBe(
        '     1\tsimple texte',
      );
      expect(okContent(await tool.execute({ path: 'image.txt' }, contextFor(ws)))).toMatch(
        /^\[Image : image\.txt \(image PNG/,
      );
    });
  });
});

describe('read_file : PDF', () => {
  it('lit les 20 premières pages par défaut, avec en-têtes et nombre total', async () => {
    await withWorkspace(['rapport.pdf'], async (ws) => {
      const out = okContent(await noCacheTool().execute({ path: 'rapport.pdf' }, contextFor(ws)));
      expect(out.split('\n')[0]).toBe(
        '[PDF : rapport.pdf, 25 pages au total ; pages 1-20 ci-dessous]',
      );
      // La consigne de continuation vient en dernier, impossible à rater.
      expect(out.split('\n\n').at(-1)).toBe(
        '[LECTURE INCOMPLÈTE : pages 21-25 sur 25 pas encore lues. Pour résumer ou analyser ce document, lis la suite AVANT de répondre : read_file({ path: "rapport.pdf", pages: "21-25" }), puis les tranches suivantes jusqu\'à la page 25.]',
      );
      expect(out).toContain('--- page 1 ---\nRapport annuel - page 1');
      expect(out).toContain(
        "--- page 2 ---\nRapport annuel - page 2\nChiffre d'affaires : 12 345 euros",
      );
      expect(out).toContain('--- page 20 ---');
      expect(out).not.toContain('--- page 21 ---');
    });
  });

  it('borne chaque tranche au budget de sortie et guide la lecture jusqu’à la fin', async () => {
    await withWorkspace(['rapport.pdf'], async (ws) => {
      // Budget serré : quelques pages par appel. On suit les consignes comme le ferait le modèle.
      const tool = noCacheTool({ maxOutputChars: 300 });
      const seen = new Set<number>();
      let args: { path: string; pages?: string } = { path: 'rapport.pdf' };
      let calls = 0;
      for (;;) {
        calls++;
        const out = okContent(await tool.execute(args, contextFor(ws)));
        expect(out.length).toBeLessThan(300 + 600);
        for (const m of out.matchAll(/--- page (\d+) ---/g)) seen.add(Number(m[1]));
        const next = /pages: "([^"]+)" \}\)/.exec(out.split('\n\n').at(-1) ?? '');
        if (!next) {
          expect(out.split('\n\n').at(-1)).toBe('[Fin du document : page 25 sur 25 lue.]');
          break;
        }
        expect(out).toContain('LECTURE INCOMPLÈTE');
        args = { path: 'rapport.pdf', pages: next[1] ?? '' };
        expect(calls).toBeLessThan(25);
      }
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(calls).toBeGreaterThan(2);
    });
  });

  it('signale les pages demandées mais coupées par le budget', async () => {
    await withWorkspace(['rapport.pdf'], async (ws) => {
      const out = okContent(
        await noCacheTool({ maxOutputChars: 300 }).execute(
          { path: 'rapport.pdf', pages: '2,4-12' },
          contextFor(ws),
        ),
      );
      const footer = out.split('\n\n').at(-1) ?? '';
      expect(footer).toMatch(/^\[LECTURE INCOMPLÈTE : pages .* demandées mais non affichées/);
      expect(footer).toMatch(/jusqu'à la page 12\.\]$/);
    });
  });

  it('respecte le paramètre pages et refuse plus de 20 pages', async () => {
    await withWorkspace(['rapport.pdf'], async (ws) => {
      const tool = noCacheTool();
      const out = okContent(
        await tool.execute({ path: 'rapport.pdf', pages: '21-' }, contextFor(ws)),
      );
      expect(out).toMatch(/pages 21-25 ci-dessous\]/);
      expect(out).toContain('--- page 25 ---');
      expect(out.split('\n\n').at(-1)).toBe('[Fin du document : page 25 sur 25 lue.]');
      expect(out).not.toContain('LECTURE INCOMPLÈTE');
      const some = okContent(
        await tool.execute({ path: 'rapport.pdf', pages: '2,4-5' }, contextFor(ws)),
      );
      expect(some).toMatch(/pages 2, 4-5 ci-dessous/);
      const tooMany = await tool.execute({ path: 'rapport.pdf', pages: '1-25' }, contextFor(ws));
      expect(tooMany.ok).toBe(false);
      expect(tooMany.content).toMatch(/20 au plus par appel/);
      const invalid = await tool.execute({ path: 'rapport.pdf', pages: 'début' }, contextFor(ws));
      expect(invalid.content).toMatch(/Intervalle de pages invalide/);
      const beyond = await tool.execute({ path: 'rapport.pdf', pages: '40-45' }, contextFor(ws));
      expect(beyond.content).toMatch(/le PDF compte 25 pages/);
    });
  });

  it('rend une page scannée dans la VM puis la fait transcrire par le modèle vision', async () => {
    await withWorkspace(['scan.pdf'], async (ws) => {
      const model = visionModel('FACTURE N° 2026-117\nTotal TTC : 1 234,56 EUR');
      const sandbox = fakeSandbox(ws);
      const tool = createReadFileTool({ vision: createVisionAnalyzer({ model }) });
      const out = okContent(await tool.execute({ path: 'scan.pdf' }, contextFor(ws, { sandbox })));
      expect(out).toContain('--- page 1 ---\nDossier comptable');
      expect(out).toContain(
        '--- page 2 (scannée, transcrite par le modèle vision) ---\nFACTURE N° 2026-117\nTotal TTC : 1 234,56 EUR',
      );
      expect(out).toMatch(/1 page scannée transcrite par le modèle vision/);
      // pdftoppm dans la VM, sur le chemin /workspace, une seule page, 1568 px.
      expect(sandbox.commands).toHaveLength(1);
      expect(sandbox.commands[0]).toMatch(
        /^pdftoppm -f 2 -l 2 -scale-to 1568 -png -singlefile '\/workspace\/scan\.pdf' '\/workspace\/\.atelier\/cache\/pages\/[0-9a-f]{16}-p2-[0-9a-f-]{36}'$/,
      );
      // Contexte isolé : consignes de vision + image PNG, sans l'historique du chat.
      expect(model.prompts).toHaveLength(1);
      expect(model.prompts[0]?.mediaType).toBe('image/png');
      expect(model.prompts[0]?.system).toBe(VISION_INSTRUCTIONS);
      expect(model.prompts[0]?.text).toMatch(/page de document scannée/);

      // Deuxième lecture : transcription servie par le cache, ni VM ni vision.
      const again = okContent(
        await tool.execute({ path: 'scan.pdf' }, contextFor(ws, { sandbox })),
      );
      expect(again).toContain('Total TTC : 1 234,56 EUR');
      expect(sandbox.commands).toHaveLength(1);
      expect(model.prompts).toHaveLength(1);
      expect((await readdir(path.join(ws, CACHE_DIR))).some((f) => f.endsWith('.txt'))).toBe(true);
    });
  });

  it('dégrade proprement sans VM, sans vision ou si pdftoppm échoue', async () => {
    await withWorkspace(['scan.pdf'], async (ws) => {
      const vision = createVisionAnalyzer({ model: visionModel('x') });
      const noVm = okContent(
        await noCacheTool({ vision }).execute({ path: 'scan.pdf' }, contextFor(ws)),
      );
      expect(noVm).toMatch(
        /--- page 2 ---\n\(page sans texte \(scan probable\) : la VM n'est pas prête/,
      );
      const noVision = okContent(
        await noCacheTool().execute(
          { path: 'scan.pdf' },
          contextFor(ws, { sandbox: fakeSandbox(ws) }),
        ),
      );
      expect(noVision).toMatch(/aucun modèle vision configuré/);
      const missing = okContent(
        await noCacheTool({ vision }).execute(
          { path: 'scan.pdf' },
          contextFor(ws, {
            sandbox: fakeSandbox(ws, {
              exitCode: 127,
              stderr: 'bash: pdftoppm: command not found',
            }),
          }),
        ),
      );
      expect(missing).toMatch(/pdftoppm est absent de la VM/);
    });
  });
});

describe('read_file : images', () => {
  it('décrit un PNG via le modèle vision (image réduite à 1568 px)', async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      const model = visionModel('Ticket de caisse. TOTAL 42,00 EUR');
      const tool = noCacheTool({ vision: createVisionAnalyzer({ model }) });
      const out = okContent(await tool.execute({ path: 'ticket.png' }, contextFor(ws)));
      expect(out).toBe(
        '[Image : ticket.png (image PNG, 2400×1200 px, réduite à 1568×784 px), décrite par le modèle vision ; pour une question précise, utilise look_at]\n\nTicket de caisse. TOTAL 42,00 EUR',
      );
      expect(model.prompts[0]?.mediaType).toBe('image/png');
      expect(model.prompts[0]?.text).toMatch(/transcris-le intégralement/);
    });
  });

  it('lit un JPEG et un HEIC', async () => {
    await withWorkspace(['photo.jpg', 'photo.heic'], async (ws) => {
      const model = visionModel('Une photo.');
      const tool = noCacheTool({ vision: createVisionAnalyzer({ model }) });
      expect(okContent(await tool.execute({ path: 'photo.jpg' }, contextFor(ws)))).toMatch(
        /^\[Image : photo\.jpg \(image JPG, 800×600 px\)/,
      );
      expect(okContent(await tool.execute({ path: 'photo.heic' }, contextFor(ws)))).toMatch(
        /^\[Image : photo\.heic \(image HEIC, 640×480 px\)/,
      );
      expect(model.prompts.map((p) => p.mediaType)).toEqual(['image/jpeg', 'image/jpeg']);
    });
  });

  it('refuse clairement sans modèle vision', async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      const out = await noCacheTool().execute({ path: 'ticket.png' }, contextFor(ws));
      expect(out.ok).toBe(false);
      expect(out.content).toMatch(/Aucun modèle vision n'est configuré/);
    });
  });

  it('remonte une erreur du modèle vision en résultat lisible', async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      const failing = { id: 'test:ko', analyze: () => Promise.reject(new Error('boom')) };
      const out = await noCacheTool({ vision: failing }).execute(
        { path: 'ticket.png' },
        contextFor(ws),
      );
      expect(out.ok).toBe(false);
    });
  });
});

describe('read_file : Word et Excel', () => {
  it('convertit un docx en markdown (titres, gras, tableau)', async () => {
    await withWorkspace(['compte-rendu.docx'], async (ws) => {
      const out = okContent(
        await noCacheTool().execute({ path: 'compte-rendu.docx' }, contextFor(ws)),
      );
      expect(out).toMatch(
        /^\[Document Word : compte-rendu\.docx \(1,2 Ko\), converti en markdown\]/,
      );
      expect(out).toContain('# Compte rendu de réunion');
      expect(out).toContain('Participants : Alice, **Bruno**.');
      expect(out).toContain(
        '| Action | Responsable |\n| --- | --- |\n| Envoyer le devis | Alice |',
      );
      expect(out).toContain('Prochaine réunion le 12 novembre.');
    });
  });

  it('convertit un xlsx en tableaux markdown, 200 lignes max par feuille', async () => {
    await withWorkspace(['ventes.xlsx'], async (ws) => {
      const out = okContent(await noCacheTool().execute({ path: 'ventes.xlsx' }, contextFor(ws)));
      expect(out).toContain('Classeur : 2 feuilles (« Ventes », « Journal »).');
      expect(out).toContain('## Feuille « Ventes » (5 lignes × 3 colonnes)');
      expect(out).toContain('| Mois | Produit | Montant |');
      expect(out).toContain('| Janvier | Café \\| moulu | 1200.5 |');
      expect(out).toContain('| Total |  | 2030.5 |');
      expect(out).toContain('| 2026-03-15 | Livraison express | 15 |');
      expect(out).toContain('## Feuille « Journal » (251 lignes × 2 colonnes)');
      expect(out).toContain('| 199 | Écriture 199 |');
      expect(out).not.toContain('Écriture 200 |');
      expect(out).toContain('200 premières lignes non vides sur 251');
    });
  });
});

describe('createDocumentTools', () => {
  it('fournit read_file et look_at, sans permission, source documents', () => {
    const tools = createDocumentTools();
    expect(tools.map((t) => [t.name, t.permission, t.source])).toEqual([
      ['read_file', 'never', 'documents'],
      ['look_at', 'never', 'documents'],
    ]);
  });

  it('n’écrit pas le cache à travers un .atelier qui sort du dossier', async () => {
    await withWorkspace(['compte-rendu.docx'], async (ws) => {
      const outside = await import('node:fs/promises').then((fs) =>
        fs.mkdtemp(path.join(os.tmpdir(), 'atelier-outside-')),
      );
      await symlink(outside, path.join(ws, '.atelier'));
      const out = await createReadFileTool().execute({ path: 'compte-rendu.docx' }, contextFor(ws));
      expect(out.ok).toBe(true);
      expect(await readdir(outside)).toEqual([]);
    });
  });
});
