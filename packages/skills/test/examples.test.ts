import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG = resolve(import.meta.dirname, '..');
const BUILD = join(PKG, 'examples/xlsx/scripts/build-workbook.cjs');
const CSV_TO_MD = join(PKG, 'examples/rapport-markdown/scripts/csv_to_markdown.py');

let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'atelier-examples-')));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Lance le script comme dans la VM (modules trouvés via NODE_PATH). */
function build(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BUILD, ...args], {
    env: { ...process.env, NODE_PATH: join(PKG, 'node_modules') },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const SPEC = {
  sheets: [
    {
      name: "Ventes d'été",
      columns: [
        { header: 'Mois', key: 'mois' },
        { header: 'Quantité', key: 'qte', type: 'integer' },
        { header: 'Prix', key: 'prix', type: 'currency' },
        { header: 'Montant', key: 'montant', type: 'currency', formula: '={qte}*{prix}' },
      ],
      rows: [
        { mois: 'Juin', qte: 10, prix: 2.5 },
        ['Juillet', 20, '3,5'],
        { mois: 'Août', qte: 5, prix: 4, montant: '=B{row}*C{row}+1' },
      ],
      totals: true,
      formulas: [{ cell: 'G1', formula: '=D5/B5' }],
      charts: [
        { type: 'column', title: 'Montant', categories: 'mois', series: ['montant'] },
        { type: 'line', categories: 'mois', series: ['qte', 'prix'], anchor: 'F20' },
      ],
    },
    {
      name: 'Répartition',
      columns: [
        { header: 'Catégorie', key: 'cat' },
        { header: 'Part', key: 'part', type: 'percent' },
      ],
      rows: [
        ['A', 0.6],
        ['B', 0.4],
      ],
      charts: [{ type: 'pie', title: 'Parts', categories: 'cat', series: ['part'] }],
    },
  ],
};

describe('skill xlsx : build-workbook.cjs', () => {
  it('crée feuilles, formules (avec résultats) et graphiques', async () => {
    const specPath = join(dir, 'spec.json');
    const out = join(dir, 'sortie', 'recap.xlsx');
    await writeFile(specPath, JSON.stringify(SPEC));
    const run = build([specPath, out]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      fichier: out,
      feuilles: [
        { feuille: "Ventes d'été", lignes: 3, graphiques: 2 },
        { feuille: 'Répartition', lignes: 2, graphiques: 1 },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(out);
    const ws = workbook.getWorksheet("Ventes d'été");
    expect(ws?.getCell('A1').value).toBe('Mois');
    expect(ws?.getCell('C3').value).toBe(3.5); // "3,5" converti
    expect(ws?.getCell('D2').value).toEqual({ formula: 'B2*C2', result: 25 });
    expect(ws?.getCell('D4').value).toEqual({ formula: 'B4*C4+1', result: 21 });
    expect(ws?.getCell('A5').value).toBe('Total');
    expect(ws?.getCell('D5').value).toEqual({ formula: 'SUM(D2:D4)', result: 116 });
    expect(ws?.getCell('B5').value).toEqual({ formula: 'SUM(B2:B4)', result: 35 });
    expect(ws?.getCell('G1').value).toMatchObject({ formula: 'D5/B5' });
    expect(ws?.getCell('C2').numFmt).toBe('#,##0.00 "€"');
    expect(workbook.getWorksheet('Répartition')?.getCell('B2').numFmt).toBe('0.0%');

    const zip = await JSZip.loadAsync(await readFile(out));
    const files = Object.keys(zip.files);
    expect(files).toEqual(
      expect.arrayContaining([
        'xl/charts/chart1.xml',
        'xl/charts/chart2.xml',
        'xl/charts/chart3.xml',
        'xl/drawings/drawing1.xml',
        'xl/drawings/drawing2.xml',
        'xl/drawings/_rels/drawing1.xml.rels',
        'xl/worksheets/_rels/sheet1.xml.rels',
      ]),
    );
    const chart1 = await zip.file('xl/charts/chart1.xml')?.async('string');
    expect(chart1).toContain('<c:barDir val="col"/>');
    expect(chart1).toContain("<c:f>'Ventes d''été'!$D$2:$D$4</c:f>");
    expect(chart1).toContain("<c:f>'Ventes d''été'!$A$2:$A$4</c:f>"); // sans la ligne de totaux
    const chart2 = await zip.file('xl/charts/chart2.xml')?.async('string');
    expect(chart2?.match(/<c:ser>/g)).toHaveLength(2);
    expect(await zip.file('xl/charts/chart3.xml')?.async('string')).toContain('<c:pieChart>');
    const sheet1 = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
    expect(sheet1).toMatch(/<pageSetup[^>]*\/><drawing r:id="rIdAtelierDrawing1"\/><\/worksheet>/);
    const types = await zip.file('[Content_Types].xml')?.async('string');
    expect(types).toContain('PartName="/xl/charts/chart3.xml"');
    expect(types).toContain('PartName="/xl/drawings/drawing2.xml"');
  });

  it("lit la spec sur l'entrée standard et affiche un exemple valide", () => {
    const example = build(['--example']);
    expect(example.status).toBe(0);
    const out = join(dir, 'exemple.xlsx');
    const run = build(['-', out], example.stdout);
    expect(run.status).toBe(0);
  });

  it.each([
    [{ sheets: [] }, /au moins une feuille/],
    [{ sheets: [{ name: 'a/b', columns: [{ key: 'x' }] }] }, /nom « a\/b » invalide/],
    [{ sheets: [{ name: 'A', columns: [{ key: 'x', type: 'euros' }] }] }, /type « euros » inconnu/],
    [
      {
        sheets: [
          {
            name: 'A',
            columns: [{ key: 'x' }],
            charts: [{ type: 'radar', categories: 'x', series: ['x'] }],
          },
        ],
      },
      /type de graphique « radar »/,
    ],
    [
      {
        sheets: [
          {
            name: 'A',
            columns: [{ key: 'x' }],
            charts: [{ type: 'pie', categories: 'x', series: ['y'] }],
          },
        ],
      },
      /série « y » inconnue/,
    ],
    [
      { sheets: [{ name: 'A', columns: [{ key: 'x', formula: '={nope}*2' }], rows: [{}] }] },
      /\{nope\} ne correspond à aucune colonne/,
    ],
  ])('refuse une spec invalide avec un message clair (%#)', (spec, message) => {
    const run = build(['-', join(dir, 'x.xlsx')], JSON.stringify(spec));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
  });
});

describe('skill rapport-markdown : csv_to_markdown.py', () => {
  it('convertit un CSV en tableau Markdown au format français', async () => {
    const csvPath = join(dir, 'ventes.csv');
    await writeFile(
      csvPath,
      'mois;total;part\nJanvier;1 200,50;12 %\nFévrier;980;9,5 %\nMars;12345.678;10 %\n',
    );
    const result = spawnSync('python3', ['-I', CSV_TO_MD, csvPath, '--max-rows', '2'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n').slice(0, 4)).toEqual([
      '| mois | total | part |',
      '| --- | ---: | ---: |',
      '| Janvier | 1 200,50 | 12 % |',
      '| Février | 980 | 9,50 % |',
    ]);
    expect(result.stdout).toContain('2 lignes affichées sur 3');
  });
});
