/**
 * Génère les fixtures de test de `@atelier/documents` dans `test/fixtures/`.
 *
 * Usage : `pnpm --filter @atelier/documents fixtures` (macOS : `sips` pour le
 * HEIC, `zip` pour le docx). Les fichiers produits sont commités : ce script
 * n'est relancé que pour les modifier.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import sharp, { type Sharp } from 'sharp';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

/** Image de texte noir sur blanc rendue depuis un SVG. */
function textImage(width: number, height: number, lines: string[]): Sharp {
  const longest = Math.max(...lines.map((l) => l.length));
  // Police bornée par la hauteur et par la largeur (≈ 0,6 em par caractère) : rien n'est coupé.
  const size = Math.round(
    Math.min(height / (lines.length + 2), (width - 80) / (longest * 0.6 * 0.7)),
  );
  const tspans = lines
    .map((l, i) => `<text x="40" y="${(i + 1.5) * size}" font-size="${size * 0.7}">${l}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><g font-family="Helvetica, Arial, sans-serif" fill="black">${tspans}</g></svg>`;
  return sharp(Buffer.from(svg));
}

/** Petit écrivain PDF : objets numérotés, table xref aux bons décalages. */
function buildPdf(objects: (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]?.length ?? 0;
  objects.forEach((body, i) => {
    offsets.push(length);
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const content = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    const tail = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(head, content, tail);
    length += head.length + content.length + tail.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(length),
    '%%EOF\n',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

function stream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

function textContent(lines: string[]): Buffer {
  const ops = lines
    .map((l, i) => `BT /F1 14 Tf 72 ${720 - i * 24} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`)
    .join('\n');
  return Buffer.from(ops, 'latin1');
}

/** PDF de pages texte (WinAnsi, accents compris). */
function textPdf(pages: string[][]): Buffer {
  // 1 catalogue, 2 pages, 3 police, puis (page, contenu) par page.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((lines, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      stream('', textContent(lines)),
    );
  });
  return buildPdf(objects);
}

/** PDF de 2 pages : une page texte, puis une page « scannée » (image JPEG seule). */
function scannedPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const draw = Buffer.from(`q 612 0 0 792 0 0 cm /Im1 Do Q`, 'latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    stream('', textContent(['Dossier comptable', 'La facture suit en page 2.'])),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>',
    stream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpeg,
    ),
    stream('', draw),
  ]);
}

async function docx(target: string): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atelier-docx-'));
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Compte rendu de réunion</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Participants : Alice, </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Bruno</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Action</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Responsable</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Envoyer le devis</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Prochaine réunion le 12 novembre.</w:t></w:r></w:p>
</w:body></w:document>`,
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.join(dir, path.dirname(name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  await rm(target, { force: true });
  execFileSync('zip', ['-X', '-r', target, '[Content_Types].xml', '_rels', 'word'], { cwd: dir });
  await rm(dir, { recursive: true, force: true });
}

async function xlsx(target: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date('2026-01-01T00:00:00Z');
  const ventes = wb.addWorksheet('Ventes');
  ventes.addRow(['Mois', 'Produit', 'Montant']);
  ventes.addRow(['Janvier', 'Café | moulu', 1200.5]);
  ventes.addRow(['Février', 'Thé', 830]);
  ventes.addRow(['Total', '', { formula: 'SUM(C2:C3)', result: 2030.5 }]);
  ventes.addRow([new Date('2026-03-15T00:00:00Z'), 'Livraison\nexpress', 15]);
  const journal = wb.addWorksheet('Journal');
  journal.addRow(['N°', 'Libellé']);
  for (let i = 1; i <= 250; i++) journal.addRow([i, `Écriture ${i}`]);
  await writeFile(target, Buffer.from(await wb.xlsx.writeBuffer()));
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  await writeFile(
    path.join(OUT, 'notes.md'),
    '# Notes\n\nRéunion du lundi : budget validé.\n\n- point 1\n- point 2\n',
  );
  await writeFile(
    path.join(OUT, 'latin1.txt'),
    Buffer.from('Château de Fontainebleau\nÉlève : François Gaël\nPrix : 12,50 F\n', 'latin1'),
  );

  const pages = Array.from({ length: 25 }, (_, i) => [
    `Rapport annuel - page ${i + 1}`,
    i === 1
      ? "Chiffre d'affaires : 12 345 euros, en hausse de 8 %."
      : `Contenu de la section ${i + 1}.`,
  ]);
  await writeFile(path.join(OUT, 'rapport.pdf'), textPdf(pages));

  // PDF dense en chiffres (tableaux financiers) : ≈ 1,4 caractère par token.
  const figures = Array.from({ length: 30 }, (_, p) => [
    `Annexe financière - page ${p + 1}`,
    ...Array.from({ length: 27 }, (_, l) => {
      const n = p * 27 + l + 1;
      const amount = (v: number) =>
        String(((n * v) % 900_000) + 10_000).replace(/\B(?=(\d{3})+$)/g, ' ');
      return `${String(n).padStart(4, '0')} ; 2025-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')} ; ${amount(7_919)},${n % 100} ; ${amount(104_729)},${(n * 7) % 100} ; ${amount(15_485_863)}`;
    }),
  ]);
  await writeFile(path.join(OUT, 'chiffres.pdf'), textPdf(figures));

  const scanW = 1240;
  const scanH = 1754;
  const scan = await textImage(scanW, scanH, ['FACTURE N° 2026-117', 'Total TTC : 1 234,56 EUR'])
    .jpeg({ quality: 80 })
    .toBuffer();
  await writeFile(path.join(OUT, 'scan.pdf'), scannedPdf(scan, scanW, scanH));
  // Rendu PNG attendu de la page 2 (renvoyé par la fausse VM des tests).
  await textImage(620, 877, ['FACTURE N° 2026-117', 'Total TTC : 1 234,56 EUR'])
    .png()
    .toFile(path.join(OUT, 'scan-page-2.png'));

  await textImage(2400, 1200, ['TICKET DE CAISSE', 'TOTAL 42,00 EUR'])
    .png()
    .toFile(path.join(OUT, 'ticket.png'));
  await textImage(800, 600, ['Photo de test'])
    .jpeg({ quality: 85 })
    .toFile(path.join(OUT, 'photo.jpg'));
  const heicTmp = path.join(os.tmpdir(), 'atelier-photo.jpg');
  await textImage(640, 480, ['HEIC']).jpeg().toFile(heicTmp);
  execFileSync('sips', ['-s', 'format', 'heic', heicTmp, '--out', path.join(OUT, 'photo.heic')]);
  await rm(heicTmp, { force: true });

  await docx(path.join(OUT, 'compte-rendu.docx'));
  await xlsx(path.join(OUT, 'ventes.xlsx'));

  const sizes = await Promise.all(
    [
      'rapport.pdf',
      'chiffres.pdf',
      'scan.pdf',
      'ticket.png',
      'photo.heic',
      'compte-rendu.docx',
      'ventes.xlsx',
    ].map(async (f) => `${f} ${(await readFile(path.join(OUT, f))).length} o`),
  );
  console.log(sizes.join('\n'));
}

await main();
