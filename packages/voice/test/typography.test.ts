import { describe, expect, it } from 'vitest';
import {
  NBSP,
  NNBSP,
  applyFrenchTypography,
  assembleSegments,
  detectTextLanguage,
} from '../src/typography.js';

describe('applyFrenchTypography', () => {
  it('ajoute une espace fine insécable avant ; ! ?', () => {
    expect(applyFrenchTypography('Tu viens? Oui! Bon; on y va.')).toBe(
      `Tu viens${NNBSP}? Oui${NNBSP}! Bon${NNBSP}; on y va.`,
    );
  });

  it('remplace l’espace ordinaire avant la ponctuation haute', () => {
    expect(applyFrenchTypography('Pourquoi ? Voici : trois points')).toBe(
      `Pourquoi${NNBSP}? Voici${NBSP}: trois points`,
    );
  });

  it('ajoute une espace insécable à l’intérieur des guillemets', () => {
    expect(applyFrenchTypography('Il a dit «bonjour» puis « au revoir ».')).toBe(
      `Il a dit «${NBSP}bonjour${NBSP}» puis «${NBSP}au revoir${NBSP}».`,
    );
  });

  it('laisse intacts les heures, les adresses et les ponctuations doubles', () => {
    expect(applyFrenchTypography('Rendez-vous à 10:30 sur https://atelier.local')).toBe(
      'Rendez-vous à 10:30 sur https://atelier.local',
    );
    expect(applyFrenchTypography('Vraiment?!')).toBe(`Vraiment${NNBSP}?!`);
  });

  it('ne touche pas une ponctuation en début de texte', () => {
    expect(applyFrenchTypography('? bizarre')).toBe('? bizarre');
  });

  it('est idempotente', () => {
    const once = applyFrenchTypography('Tu viens ? Il a dit « oui » : parfait !');
    expect(applyFrenchTypography(once)).toBe(once);
  });
});

describe('detectTextLanguage', () => {
  it('reconnaît le français', () => {
    expect(detectTextLanguage('Peux-tu ouvrir le fichier des ventes de mars ?')).toBe('fr');
    expect(detectTextLanguage("C'est très bien, merci.")).toBe('fr');
  });

  it('reconnaît une autre langue', () => {
    expect(detectTextLanguage('Can you open the sales file?')).toBe('other');
    expect(detectTextLanguage('Kun je het bestand van maart openen?')).toBe('other');
  });

  it('rend unknown pour un texte trop court', () => {
    expect(detectTextLanguage('OK ?')).toBe('unknown');
    expect(detectTextLanguage('')).toBe('unknown');
  });

  it('préfère la langue fournie par le moteur', () => {
    expect(detectTextLanguage('the file', '<|fr|>')).toBe('fr');
    expect(detectTextLanguage('le fichier', 'nl')).toBe('other');
    expect(detectTextLanguage('le fichier', '')).toBe('fr');
  });
});

describe('assembleSegments', () => {
  it('joint les segments par une espace et ignore les vides', () => {
    expect(assembleSegments(['  Bonjour.  ', '', 'Ouvre   le dossier.', ' '])).toBe(
      'Bonjour. Ouvre le dossier.',
    );
    expect(assembleSegments([])).toBe('');
  });
});
