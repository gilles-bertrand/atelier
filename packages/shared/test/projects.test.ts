/** Règles pures des projets (ADR-003) : validation, noms dans la VM, URL d'artefact. */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_SCHEME,
  artifactFormatOf,
  artifactUrl,
  defaultFolderLabel,
  folderGuestName,
  folderGuestPath,
  GUEST_FOLDERS,
  isSameOrInside,
  MAX_FOLDER_LABEL_CHARS,
  MAX_PROJECT_DESCRIPTION_CHARS,
  MAX_PROJECT_FOLDERS,
  MAX_PROJECT_INSTRUCTIONS_CHARS,
  MAX_PROJECT_NAME_CHARS,
  projectDirName,
  validateProjectInput,
  type ProjectFolder,
  type ProjectInput,
} from '../src/index.js';

const folder = (path: string, label: string, access: ProjectFolder['access'] = 'write') => ({
  path,
  label,
  access,
});

const valid: ProjectInput = {
  name: 'Ventes 2026',
  description: 'Suivi mensuel',
  instructions: 'Réponds en tableau.',
  folders: [
    folder('/Users/ana/Atelier/Projets/Ventes 2026', 'Ventes 2026'),
    folder('/Users/ana/Compta', 'Compta'),
    folder('/Volumes/NAS/Archives', 'Archives', 'read'),
  ],
};

describe('validateProjectInput', () => {
  it('accepte un projet complet, et un projet sans dossiers (créé par l’app)', () => {
    expect(validateProjectInput(valid)).toBeUndefined();
    expect(validateProjectInput({ name: 'Notes' })).toBeUndefined();
  });

  it('refuse un nom vide ou trop long', () => {
    expect(validateProjectInput({ name: '   ' })).toMatchObject({ field: 'name' });
    expect(validateProjectInput({ name: 'x'.repeat(MAX_PROJECT_NAME_CHARS + 1) })).toMatchObject({
      field: 'name',
    });
    expect(validateProjectInput({ name: 'x'.repeat(MAX_PROJECT_NAME_CHARS) })).toBeUndefined();
  });

  it('borne la description et les consignes', () => {
    expect(
      validateProjectInput({
        name: 'P',
        description: 'd'.repeat(MAX_PROJECT_DESCRIPTION_CHARS + 1),
      }),
    ).toMatchObject({ field: 'description' });
    expect(
      validateProjectInput({
        name: 'P',
        instructions: 'i'.repeat(MAX_PROJECT_INSTRUCTIONS_CHARS + 1),
      }),
    ).toMatchObject({ field: 'instructions' });
    expect(
      validateProjectInput({ name: 'P', instructions: 'i'.repeat(MAX_PROJECT_INSTRUCTIONS_CHARS) }),
    ).toBeUndefined();
  });

  it('demande de 1 à 10 dossiers', () => {
    expect(validateProjectInput({ name: 'P', folders: [] })).toMatchObject({ field: 'folders' });
    const many = Array.from({ length: MAX_PROJECT_FOLDERS + 1 }, (_, i) =>
      folder(`/Users/ana/d${String(i)}`, `d${String(i)}`),
    );
    expect(validateProjectInput({ name: 'P', folders: many })).toMatchObject({
      field: 'folders',
    });
    expect(
      validateProjectInput({ name: 'P', folders: many.slice(0, MAX_PROJECT_FOLDERS) }),
    ).toBeUndefined();
  });

  it('refuse un chemin relatif ou un octet nul, avec l’index du dossier', () => {
    expect(
      validateProjectInput({ name: 'P', folders: [folder('/a', 'a'), folder('b', 'b')] }),
    ).toMatchObject({ field: 'folders', index: 1 });
    expect(validateProjectInput({ name: 'P', folders: [folder('/a\0', 'a')] })).toMatchObject({
      field: 'folders',
      index: 0,
    });
  });

  it('exige un nom court, unique sans tenir compte de la casse, de 40 caractères au plus', () => {
    expect(validateProjectInput({ name: 'P', folders: [folder('/a', ' ')] })).toMatchObject({
      field: 'folders',
      index: 0,
    });
    expect(
      validateProjectInput({
        name: 'P',
        folders: [folder('/a', 'Compta'), folder('/b', 'compta')],
      }),
    ).toMatchObject({ field: 'folders', index: 1 });
    expect(
      validateProjectInput({
        name: 'P',
        folders: [folder('/a', 'x'.repeat(MAX_FOLDER_LABEL_CHARS + 1))],
      }),
    ).toMatchObject({ field: 'folders', index: 0 });
  });

  it('refuse deux noms qui donnent le même dossier dans la VM', () => {
    const issue = validateProjectInput({
      name: 'P',
      folders: [folder('/a', 'Été 2026'), folder('/b', 'Ete-2026')],
    });
    expect(issue).toMatchObject({ field: 'folders', index: 1 });
    expect(issue?.message).toContain('trop proches');
  });

  it('exige un dossier principal en lecture et écriture', () => {
    expect(
      validateProjectInput({ name: 'P', folders: [folder('/a', 'a', 'read'), folder('/b', 'b')] }),
    ).toMatchObject({ field: 'folders', index: 0 });
  });

  it('refuse un dossier ajouté deux fois ou inclus dans un autre', () => {
    expect(
      validateProjectInput({ name: 'P', folders: [folder('/a/b', 'x'), folder('/a/b/', 'y')] }),
    ).toMatchObject({ field: 'folders', index: 1 });
    const nested = validateProjectInput({
      name: 'P',
      folders: [
        folder('/Users/ana/Compta', 'Compta'),
        folder('/Users/ana/Compta/2026', '2026', 'read'),
      ],
    });
    expect(nested).toMatchObject({ field: 'folders', index: 1 });
    expect(nested?.message).toContain('déjà inclus');
    // Préfixe de nom sans inclusion : /Users/ana/Compta-old n'est pas dans /Users/ana/Compta.
    expect(
      validateProjectInput({
        name: 'P',
        folders: [folder('/Users/ana/Compta', 'Compta'), folder('/Users/ana/Compta-old', 'Old')],
      }),
    ).toBeUndefined();
  });
});

describe('noms des dossiers dans la VM', () => {
  it('retire les accents et remplace les caractères spéciaux', () => {
    expect(folderGuestName('Été 2026')).toBe('Ete-2026');
    expect(folderGuestName('Compta / Fiscalité')).toBe('Compta-Fiscalite');
    expect(folderGuestName('rapport_v2.final')).toBe('rapport_v2.final');
  });

  it('ne commence ni par un point ni par un tiret, et n’est jamais vide', () => {
    expect(folderGuestName('.cache')).toBe('cache');
    expect(folderGuestName('--x--')).toBe('x');
    expect(folderGuestName('???')).toBe('dossier');
    expect(folderGuestName('')).toBe('dossier');
  });

  it('borne la longueur à 40 caractères, sans tiret final', () => {
    const name = folderGuestName(`${'a'.repeat(39)} b`);
    expect(name.length).toBeLessThanOrEqual(MAX_FOLDER_LABEL_CHARS);
    expect(name.endsWith('-')).toBe(false);
  });

  it('place le dossier sous /dossiers', () => {
    expect(GUEST_FOLDERS).toBe('/dossiers');
    expect(folderGuestPath('Compta 2026')).toBe('/dossiers/Compta-2026');
  });
});

describe('libellés et dossiers créés', () => {
  it('libellé par défaut = nom du dossier', () => {
    expect(defaultFolderLabel('/Users/ana/Compta')).toBe('Compta');
    expect(defaultFolderLabel('/Users/ana/Compta/')).toBe('Compta');
    expect(defaultFolderLabel('/')).toBe('Dossier');
    expect(defaultFolderLabel(`/${'n'.repeat(60)}`)).toHaveLength(MAX_FOLDER_LABEL_CHARS);
  });

  it('nom de dossier de projet sans séparateur, ni dossier caché', () => {
    expect(projectDirName('Ventes 2026')).toBe('Ventes 2026');
    expect(projectDirName('Clients/Fournisseurs')).toBe('Clients-Fournisseurs');
    expect(projectDirName('a:b')).toBe('a-b');
    expect(projectDirName('..secret')).toBe('secret');
    expect(projectDirName('  Rapport   annuel ')).toBe('Rapport annuel');
    expect(projectDirName('///')).toBe('Projet');
    expect(projectDirName('   ')).toBe('Projet');
  });

  it('isSameOrInside compare des segments entiers', () => {
    expect(isSameOrInside('/a/b', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/b', '/a/b/c')).toBe(true);
    expect(isSameOrInside('/a/b/', '/a/b/c')).toBe(true);
    expect(isSameOrInside('/a/b', '/a/bc')).toBe(false);
    expect(isSameOrInside('/a/b/c', '/a/b')).toBe(false);
    expect(isSameOrInside('/', '/a')).toBe(true);
  });
});

describe('artefacts', () => {
  it('format d’après l’extension, sans tenir compte de la casse', () => {
    expect(artifactFormatOf('/p/Artefacts/tableau.html')).toBe('html');
    expect(artifactFormatOf('/p/page.HTM')).toBe('html');
    expect(artifactFormatOf('/p/rapport.md')).toBe('markdown');
    expect(artifactFormatOf('/p/notes.markdown')).toBe('markdown');
    expect(artifactFormatOf('/p/data.csv')).toBeUndefined();
    expect(artifactFormatOf('/p/.html')).toBeUndefined();
    expect(artifactFormatOf('/p.d/fichier')).toBeUndefined();
  });

  it('URL d’une version et de la dernière version', () => {
    expect(ARTIFACT_SCHEME).toBe('atelier-artifact');
    expect(artifactUrl('a1', 3)).toBe('atelier-artifact://a1/v3/');
    expect(artifactUrl('a1')).toBe('atelier-artifact://a1/latest/');
    expect(artifactUrl('a b', 1)).toBe('atelier-artifact://a%20b/v1/');
  });
});
