#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
/**
 * Crée un classeur Excel (.xlsx) à partir d'une description JSON : feuilles,
 * colonnes typées, formules, ligne de totaux et graphiques Excel natifs.
 *
 *   node /skills/xlsx/scripts/build-workbook.cjs <spec.json> <sortie.xlsx>
 *   node /skills/xlsx/scripts/build-workbook.cjs - <sortie.xlsx>   (spec sur stdin)
 *   node /skills/xlsx/scripts/build-workbook.cjs --example         (affiche un exemple)
 *
 * Le classeur est écrit par exceljs ; exceljs ne sachant pas créer de graphiques,
 * ceux-ci sont ajoutés ensuite au fichier (DrawingML) avec jszip.
 */
const fs = require('node:fs');
const path = require('node:path');

const NS = {
  main: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  relDrawing: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
  relChart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  ctChart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  ctDrawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
};

const FORMATS = {
  text: '@',
  number: '#,##0.00',
  integer: '#,##0',
  currency: '#,##0.00 "€"',
  percent: '0.0%',
  date: 'dd/mm/yyyy',
};

const CHART_TYPES = ['column', 'bar', 'line', 'pie'];

const EXAMPLE = {
  properties: { title: 'Récapitulatif des ventes', creator: 'Atelier' },
  sheets: [
    {
      name: 'Ventes',
      columns: [
        { header: 'Mois', key: 'mois', type: 'text' },
        { header: 'Quantité', key: 'qte', type: 'integer' },
        { header: 'Prix unitaire', key: 'prix', type: 'currency' },
        { header: 'Montant', key: 'montant', type: 'currency', formula: '={qte}*{prix}' },
      ],
      rows: [
        { mois: 'Janvier', qte: 120, prix: 12.5 },
        { mois: 'Février', qte: 95, prix: 12.5 },
        { mois: 'Mars', qte: 143, prix: 13 },
      ],
      totals: { label: 'Total', functions: { qte: 'SUM', montant: 'SUM', prix: 'AVERAGE' } },
      charts: [
        {
          type: 'column',
          title: 'Montant par mois',
          categories: 'mois',
          series: ['montant'],
          anchor: 'F2',
        },
      ],
    },
  ],
};

class SpecError extends Error {}

function fail(message) {
  process.stderr.write(`Erreur : ${message}\n`);
  process.exit(1);
}

/** Charge un module installé globalement (NODE_PATH) ou fourni avec exceljs. */
function load(name) {
  try {
    return require(name);
  } catch {
    // jszip est une dépendance d'exceljs : on le cherche à côté.
  }
  try {
    const base = path.dirname(require.resolve('exceljs'));
    return require(require.resolve(name, { paths: [base] }));
  } catch {
    return fail(`module « ${name} » introuvable (dans la VM Atelier il est installé globalement).`);
  }
}

// ---------------------------------------------------------------------------
// Utilitaires

function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** "F2" → { col: 5, row: 1 } (indices à partir de 0). */
function parseCell(ref) {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(String(ref).toUpperCase());
  if (!match) throw new SpecError(`référence de cellule invalide : « ${ref} »`);
  let col = 0;
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Référence absolue vers une plage d'une feuille : 'Feuille'!$A$2:$A$13. */
function rangeRef(sheetName, col, fromRow, toRow) {
  const letter = columnLetter(col);
  const sheet = `'${sheetName.replace(/'/g, "''")}'`;
  return fromRow === toRow
    ? `${sheet}!$${letter}$${fromRow}`
    : `${sheet}!$${letter}$${fromRow}:$${letter}$${toRow}`;
}

/** Convertit "1 234,5" ou "12,5 €" en nombre si possible. */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\s\u00a0€%]/g, '').replace(',', '.');
  return cleaned !== '' && Number.isFinite(Number(cleaned)) ? Number(cleaned) : value;
}

// ---------------------------------------------------------------------------
// Calcul des résultats en cache (pour les lecteurs qui ne recalculent pas :
// aperçus, Quick Look, lecture du fichier par l'agent). Sous-ensemble sûr :
// nombres, références, + - * / ^, parenthèses, SUM/AVERAGE/MIN/MAX/COUNT.

/** Parse et évalue une formule ; `undefined` si elle sort du sous-ensemble. */
function evaluateFormula(formula, values) {
  const tokens = String(formula)
    .replace(/^=/, '')
    .match(
      /\s*([A-Z]{1,3}[0-9]+:[A-Z]{1,3}[0-9]+|[A-Z]{1,3}[0-9]+|[A-Z]+(?=\()|[0-9]+(?:\.[0-9]+)?|[-+*/^(),;])\s*/gy,
    );
  if (
    !tokens ||
    tokens.join('').replace(/\s/g, '') !== String(formula).replace(/^=/, '').replace(/\s/g, '')
  ) {
    return undefined;
  }
  const list = tokens.map((t) => t.trim());
  let pos = 0;
  const peek = () => list[pos];
  const next = () => list[pos++];
  const cell = (ref) => {
    const v = values.get(ref);
    if (typeof v !== 'number') throw new Error('valeur inconnue');
    return v;
  };
  const range = (ref) => {
    const [a, b] = ref.split(':').map(parseCell);
    const out = [];
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
        const v = values.get(`${columnLetter(c)}${r + 1}`);
        if (typeof v === 'number') out.push(v);
        else if (v === undefined) throw new Error('valeur inconnue');
      }
    }
    return out;
  };
  const FUNCTIONS = {
    SUM: (xs) => xs.reduce((a, b) => a + b, 0),
    AVERAGE: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN),
    MIN: (xs) => Math.min(...xs),
    MAX: (xs) => Math.max(...xs),
    COUNT: (xs) => xs.length,
  };
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('fin inattendue');
    if (t === '(') {
      const v = expr();
      if (next() !== ')') throw new Error(') attendue');
      return v;
    }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (/^[0-9]/.test(t)) return Number(t);
    if (/^[A-Z]+$/.test(t)) {
      const fn = FUNCTIONS[t];
      if (!fn || next() !== '(') throw new Error('fonction non gérée');
      const args = [];
      while (peek() !== ')') {
        const arg = peek();
        if (arg !== undefined && arg.includes(':')) {
          next();
          args.push(...range(arg));
        } else {
          args.push(expr());
        }
        if (peek() === ',' || peek() === ';') next();
        else if (peek() !== ')') throw new Error(', attendue');
      }
      next();
      return fn(args);
    }
    if (/^[A-Z]{1,3}[0-9]+$/.test(t)) return cell(t);
    throw new Error(`jeton inattendu ${t}`);
  }
  function power() {
    let v = primary();
    while (peek() === '^') {
      next();
      v = v ** primary();
    }
    return v;
  }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/') v = next() === '*' ? v * power() : v / power();
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
    return v;
  }
  try {
    const result = expr();
    return pos === list.length && Number.isFinite(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Ajoute `result` aux formules calculables, en plusieurs passes (dépendances). */
function computeResults(cells, values) {
  let pending = cells.filter((c) => c.value && typeof c.value === 'object' && 'formula' in c.value);
  for (let pass = 0; pass < 10 && pending.length > 0; pass++) {
    const still = [];
    for (const c of pending) {
      const result = evaluateFormula(c.value.formula, values);
      if (result === undefined) still.push(c);
      else {
        c.value.result = result;
        values.set(c.ref, result);
      }
    }
    if (still.length === pending.length) break;
    pending = still;
  }
}

// ---------------------------------------------------------------------------
// Validation de la spec

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new SpecError('la spec doit être un objet JSON.');
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    throw new SpecError('« sheets » doit contenir au moins une feuille.');
  }
  const names = new Set();
  for (const [i, sheet] of spec.sheets.entries()) {
    const where = `feuille n° ${i + 1}`;
    if (typeof sheet.name !== 'string' || sheet.name.trim() === '') {
      throw new SpecError(`${where} : « name » manquant.`);
    }
    if (sheet.name.length > 31 || /[\\/?*[\]:]/.test(sheet.name)) {
      throw new SpecError(
        `${where} : nom « ${sheet.name} » invalide (31 caractères max, sans \\ / ? * [ ] :).`,
      );
    }
    if (names.has(sheet.name.toLowerCase())) {
      throw new SpecError(`deux feuilles s'appellent « ${sheet.name} ».`);
    }
    names.add(sheet.name.toLowerCase());
    if (!Array.isArray(sheet.columns) || sheet.columns.length === 0) {
      throw new SpecError(`${where} : « columns » doit contenir au moins une colonne.`);
    }
    const keys = new Set();
    for (const column of sheet.columns) {
      if (typeof column.key !== 'string' || !/^[A-Za-z_][\w]*$/.test(column.key)) {
        throw new SpecError(
          `${where} : clé de colonne invalide « ${column.key} » (lettres, chiffres, _).`,
        );
      }
      if (keys.has(column.key)) throw new SpecError(`${where} : clé « ${column.key} » en double.`);
      keys.add(column.key);
      if (column.type !== undefined && !(column.type in FORMATS)) {
        throw new SpecError(
          `${where} : type « ${column.type} » inconnu (${Object.keys(FORMATS).join(', ')}).`,
        );
      }
    }
    if (sheet.rows !== undefined && !Array.isArray(sheet.rows)) {
      throw new SpecError(`${where} : « rows » doit être un tableau.`);
    }
    for (const chart of sheet.charts ?? []) {
      if (!CHART_TYPES.includes(chart.type)) {
        throw new SpecError(
          `${where} : type de graphique « ${chart.type} » inconnu (${CHART_TYPES.join(', ')}).`,
        );
      }
      if (!keys.has(chart.categories)) {
        throw new SpecError(`${where} : « categories » doit être une clé de colonne.`);
      }
      if (!Array.isArray(chart.series) || chart.series.length === 0) {
        throw new SpecError(`${where} : « series » doit lister au moins une clé de colonne.`);
      }
      for (const key of chart.series) {
        if (!keys.has(key)) throw new SpecError(`${where} : série « ${key} » inconnue.`);
      }
      if (chart.type === 'pie' && chart.series.length !== 1) {
        throw new SpecError(`${where} : un camembert (pie) n'a qu'une série.`);
      }
      if (chart.anchor !== undefined) parseCell(chart.anchor);
    }
  }
}

// ---------------------------------------------------------------------------
// Construction du classeur (exceljs)

/** Remplace {row} et {clé} par le numéro de ligne / la cellule de la même ligne. */
function expandFormula(template, rowNumber, letters) {
  return template.replace(/^=/, '').replace(/\{(\w+)\}/g, (whole, name) => {
    if (name === 'row') return String(rowNumber);
    if (name in letters) return `${letters[name]}${rowNumber}`;
    throw new SpecError(`formule « ${template} » : {${name}} ne correspond à aucune colonne.`);
  });
}

function cellValue(raw, column, rowNumber, letters) {
  if (typeof raw === 'string' && raw.startsWith('=')) {
    return { formula: expandFormula(raw, rowNumber, letters) };
  }
  if (raw === null || raw === undefined || raw === '') return null;
  switch (column.type) {
    case 'number':
    case 'integer':
    case 'currency':
    case 'percent':
      return toNumber(raw);
    case 'date': {
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? raw : date;
    }
    default:
      return raw;
  }
}

function buildSheet(workbook, sheet) {
  const ws = workbook.addWorksheet(sheet.name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const columns = sheet.columns;
  const letters = Object.fromEntries(columns.map((c, i) => [c.key, columnLetter(i)]));
  const rows = sheet.rows ?? [];

  ws.columns = columns.map((column) => ({
    header: column.header ?? column.key,
    key: column.key,
    style: column.type && column.type !== 'text' ? { numFmt: FORMATS[column.type] } : {},
  }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 22;

  // Valeurs connues (pour calculer les résultats des formules) et cellules à formule.
  const known = new Map();
  const cells = [];
  const track = (values, rowNumber) => {
    values.forEach((value, i) => {
      const ref = `${columnLetter(i)}${rowNumber}`;
      if (typeof value === 'number') known.set(ref, value);
      else if (value === null || value === undefined) known.set(ref, null);
      else if (typeof value === 'object' && 'formula' in value) cells.push({ ref, value });
      else known.set(ref, String(value));
    });
  };

  const dataRows = rows.map((row, index) => {
    const rowNumber = index + 2;
    const values = columns.map((column, colIndex) => {
      const raw = Array.isArray(row) ? row[colIndex] : row[column.key];
      if ((raw === undefined || raw === null) && column.formula) {
        return { formula: expandFormula(column.formula, rowNumber, letters) };
      }
      return cellValue(raw, column, rowNumber, letters);
    });
    track(values, rowNumber);
    return values;
  });

  const lastDataRow = rows.length + 1;
  let totalValues;
  if (sheet.totals && rows.length > 0) {
    const totals = sheet.totals === true ? {} : sheet.totals;
    const functions =
      totals.functions ??
      Object.fromEntries(
        columns
          .filter((c) => ['number', 'integer', 'currency'].includes(c.type))
          .map((c) => [c.key, 'SUM']),
      );
    const values = columns.map((column, colIndex) => {
      const fn = functions[column.key];
      if (fn) {
        const letter = letters[column.key];
        return { formula: `${String(fn).toUpperCase()}(${letter}2:${letter}${lastDataRow})` };
      }
      return colIndex === 0 ? (totals.label ?? 'Total') : null;
    });
    track(values, lastDataRow + 1);
    totalValues = values;
  }

  const extra = (sheet.formulas ?? []).map((formula) => {
    const { col, row } = parseCell(formula.cell);
    const value = { formula: String(formula.formula).replace(/^=/, '') };
    cells.push({ ref: `${columnLetter(col)}${row + 1}`, value });
    return { cell: formula.cell, value };
  });
  computeResults(cells, known);

  for (const values of dataRows) ws.addRow(values);
  if (totalValues) {
    const totalRow = ws.addRow(totalValues);
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => {
      cell.border = { top: { style: 'thin' } };
    });
  }

  for (const { cell, value } of extra) ws.getCell(cell).value = value;

  if (rows.length > 0) {
    ws.autoFilter = { from: 'A1', to: `${columnLetter(columns.length - 1)}${lastDataRow}` };
  }

  // Largeurs : explicites, sinon d'après le contenu (10 à 50 caractères).
  columns.forEach((column, i) => {
    let width = column.width;
    if (!width) {
      width = String(column.header ?? column.key).length + 2;
      for (const row of rows) {
        const raw = Array.isArray(row) ? row[i] : row[column.key];
        if (raw !== undefined && raw !== null && !String(raw).startsWith('=')) {
          width = Math.max(width, String(raw).length + 2);
        }
      }
      width = Math.min(50, Math.max(10, width + (column.type === 'currency' ? 4 : 0)));
    }
    ws.getColumn(i + 1).width = width;
  });

  return { lastDataRow, letters };
}

// ---------------------------------------------------------------------------
// Graphiques (DrawingML)

function titleXml(title) {
  if (!title) return '<c:autoTitleDeleted val="1"/>';
  return (
    '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr b="1"/></a:pPr>' +
    `<a:r><a:rPr lang="fr-FR" b="1"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx>` +
    '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'
  );
}

function seriesXml(chart, sheetName, layout) {
  const catCol = chart.columns.indexOf(chart.categories);
  return chart.series
    .map((key, i) => {
      const valCol = chart.columns.indexOf(key);
      const tx = `<c:tx><c:strRef><c:f>${escapeXml(rangeRef(sheetName, valCol, 1, 1))}</c:f></c:strRef></c:tx>`;
      const cat = `<c:cat><c:strRef><c:f>${escapeXml(rangeRef(sheetName, catCol, 2, layout.lastDataRow))}</c:f></c:strRef></c:cat>`;
      const val = `<c:val><c:numRef><c:f>${escapeXml(rangeRef(sheetName, valCol, 2, layout.lastDataRow))}</c:f></c:numRef></c:val>`;
      const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}`;
      if (chart.type === 'line') {
        return `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
      }
      if (chart.type === 'pie') {
        const labels =
          '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/>' +
          '<c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/>' +
          '<c:showLeaderLines val="1"/></c:dLbls>';
        return `<c:ser>${head}${labels}${cat}${val}</c:ser>`;
      }
      return `<c:ser>${head}<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`;
    })
    .join('');
}

function axesXml(horizontal) {
  const catPos = horizontal ? 'l' : 'b';
  const valPos = horizontal ? 'b' : 'l';
  return (
    `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${catPos}"/><c:numFmt formatCode="General" sourceLinked="1"/>` +
    `<c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/>` +
    `<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${valPos}"/><c:majorGridlines/>` +
    `<c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/>` +
    `<c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  );
}

function chartXml(chart, sheetName, layout) {
  const series = seriesXml(chart, sheetName, layout);
  const axIds = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  let plot;
  switch (chart.type) {
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'line':
      plot =
        `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}` +
        `<c:marker val="1"/>${axIds}</c:lineChart>${axesXml(false)}`;
      break;
    default: {
      const horizontal = chart.type === 'bar';
      plot =
        `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="clustered"/>` +
        `<c:varyColors val="0"/>${series}<c:gapWidth val="150"/>${axIds}</c:barChart>${axesXml(horizontal)}`;
    }
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
    '<c:lang val="fr-FR"/><c:roundedCorners val="0"/><c:chart>' +
    titleXml(chart.title) +
    `<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>'
  );
}

function anchorXml(chart, index, chartRelId) {
  const from = parseCell(chart.anchor);
  const width = Math.max(3, Number(chart.width) || 8);
  const height = Math.max(5, Number(chart.height) || 16);
  const cell = (tag, col, row) =>
    `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  return (
    '<xdr:twoCellAnchor editAs="oneCell">' +
    cell('from', from.col, from.row) +
    cell('to', from.col + width, from.row + height) +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>' +
    `<xdr:cNvPr id="${index + 2}" name="${escapeXml(chart.title || `Graphique ${index + 1}`)}"/>` +
    '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    `<a:graphic><a:graphicData uri="${NS.c}">` +
    `<c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${chartRelId}"/>` +
    '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>'
  );
}

function relsXml(relationships) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<Relationships xmlns="${NS.rels}">` +
    relationships
      .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeXml(r.target)}"/>`)
      .join('') +
    '</Relationships>'
  );
}

/** Associe chaque nom de feuille à son fichier XML dans l'archive. */
async function sheetPaths(zip) {
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const targets = {};
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0]);
    const target = /\bTarget="([^"]+)"/.exec(match[0]);
    if (id && target) targets[id[1]] = target[1].replace(/^\/?xl\//, '');
  }
  const paths = {};
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(match[0]);
    const rid = /\br:id="([^"]+)"/.exec(match[0]);
    if (name && rid && targets[rid[1]]) paths[unescapeXml(name[1])] = `xl/${targets[rid[1]]}`;
  }
  return paths;
}

const DRAWING_SUCCESSORS = [
  '<legacyDrawing',
  '<legacyDrawingHF',
  '<drawingHF',
  '<picture',
  '<oleObjects',
  '<controls',
  '<webPublishItems',
  '<tableParts',
  '<extLst',
  '</worksheet>',
];

async function addCharts(buffer, charts) {
  if (charts.length === 0) return buffer;
  const JSZip = load('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const paths = await sheetPaths(zip);
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  const overrides = [];
  let chartNumber = 0;
  let drawingNumber = 0;
  const nextFree = (dir, prefix, current) => {
    let n = current + 1;
    while (zip.file(`${dir}/${prefix}${n}.xml`)) n++;
    return n;
  };

  const bySheet = new Map();
  for (const chart of charts) {
    if (!bySheet.has(chart.sheetName)) bySheet.set(chart.sheetName, []);
    bySheet.get(chart.sheetName).push(chart);
  }

  for (const [sheetName, sheetCharts] of bySheet) {
    const sheetPath = paths[sheetName];
    if (!sheetPath) throw new Error(`feuille « ${sheetName} » introuvable dans l'archive.`);
    let sheetXml = await zip.file(sheetPath).async('string');
    if (sheetXml.includes('<drawing ')) {
      throw new Error(`la feuille « ${sheetName} » contient déjà des dessins (images).`);
    }

    drawingNumber = nextFree('xl/drawings', 'drawing', drawingNumber);
    const drawingName = `drawing${drawingNumber}.xml`;
    const anchors = [];
    const drawingRels = [];
    sheetCharts.forEach((chart, index) => {
      chartNumber = nextFree('xl/charts', 'chart', chartNumber);
      const chartName = `chart${chartNumber}.xml`;
      zip.file(`xl/charts/${chartName}`, chartXml(chart, sheetName, chart.layout));
      overrides.push([`/xl/charts/${chartName}`, NS.ctChart]);
      const relId = `rId${index + 1}`;
      drawingRels.push({ id: relId, type: NS.relChart, target: `../charts/${chartName}` });
      anchors.push(anchorXml(chart, index, relId));
    });
    zip.file(
      `xl/drawings/${drawingName}`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}">${anchors.join('')}</xdr:wsDr>`,
    );
    zip.file(`xl/drawings/_rels/${drawingName}.rels`, relsXml(drawingRels));
    overrides.push([`/xl/drawings/${drawingName}`, NS.ctDrawing]);

    // Relation feuille → dessin.
    const sheetFile = path.posix.basename(sheetPath);
    const sheetRelsPath = `${path.posix.dirname(sheetPath)}/_rels/${sheetFile}.rels`;
    const drawingRelId = 'rIdAtelierDrawing1';
    const drawingRel = `<Relationship Id="${drawingRelId}" Type="${NS.relDrawing}" Target="../drawings/${drawingName}"/>`;
    const existingRels = zip.file(sheetRelsPath);
    if (existingRels) {
      const xml = await existingRels.async('string');
      zip.file(sheetRelsPath, xml.replace('</Relationships>', `${drawingRel}</Relationships>`));
    } else {
      zip.file(
        sheetRelsPath,
        relsXml([{ id: drawingRelId, type: NS.relDrawing, target: `../drawings/${drawingName}` }]),
      );
    }

    if (!/<worksheet\b[^>]*\sxmlns:r=/.test(sheetXml)) {
      sheetXml = sheetXml.replace('<worksheet ', `<worksheet xmlns:r="${NS.r}" `);
    }
    const drawingTag = `<drawing r:id="${drawingRelId}"/>`;
    const position = DRAWING_SUCCESSORS.map((tag) => sheetXml.indexOf(tag))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0];
    sheetXml = `${sheetXml.slice(0, position)}${drawingTag}${sheetXml.slice(position)}`;
    zip.file(sheetPath, sheetXml);
  }

  const overrideXml = overrides
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join('');
  contentTypes = contentTypes.replace('</Types>', `${overrideXml}</Types>`);
  zip.file('[Content_Types].xml', contentTypes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// Programme principal

async function build(spec, output) {
  validateSpec(spec);
  const ExcelJS = load('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = spec.properties?.creator ?? 'Atelier';
  if (spec.properties?.title) workbook.title = spec.properties.title;
  workbook.created = new Date();
  // Formules sans valeur en cache : Excel les recalcule à l'ouverture.
  workbook.calcProperties.fullCalcOnLoad = true;

  const charts = [];
  const summary = [];
  for (const sheet of spec.sheets) {
    const layout = buildSheet(workbook, sheet);
    const columns = sheet.columns.map((c) => c.key);
    (sheet.charts ?? []).forEach((chart, i) => {
      charts.push({
        ...chart,
        anchor: chart.anchor ?? `${columnLetter(columns.length + 1)}${2 + i * 18}`,
        columns,
        layout,
        sheetName: sheet.name,
      });
    });
    summary.push({
      feuille: sheet.name,
      lignes: (sheet.rows ?? []).length,
      graphiques: (sheet.charts ?? []).length,
    });
  }

  const buffer = await addCharts(Buffer.from(await workbook.xlsx.writeBuffer()), charts);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, buffer);
  return { fichier: path.resolve(output), feuilles: summary };
}

async function main(argv) {
  if (argv.includes('--example')) {
    process.stdout.write(`${JSON.stringify(EXAMPLE, null, 2)}\n`);
    return;
  }
  if (argv.length !== 2 || argv.includes('--help')) {
    process.stderr.write(
      'Usage : node build-workbook.cjs <spec.json|-> <sortie.xlsx>\n' +
        '        node build-workbook.cjs --example\n',
    );
    process.exit(argv.includes('--help') ? 0 : 2);
  }
  const [specPath, output] = argv;
  if (!output.toLowerCase().endsWith('.xlsx')) fail('le fichier de sortie doit finir par .xlsx.');
  let spec;
  try {
    const text = specPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(specPath, 'utf8');
    spec = JSON.parse(text);
  } catch (error) {
    fail(`spec illisible (${error.message}).`);
  }
  try {
    const result = await build(spec, output);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    fail(error instanceof SpecError ? error.message : `génération impossible : ${error.message}`);
  }
}

if (require.main === module) {
  void main(process.argv.slice(2));
}

module.exports = {
  build,
  columnLetter,
  parseCell,
  expandFormula,
  evaluateFormula,
  chartXml,
  EXAMPLE,
};
