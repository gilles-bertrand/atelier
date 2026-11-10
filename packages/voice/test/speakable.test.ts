import { describe, expect, it } from 'vitest';
import {
  dateToFrench,
  digitStringToFrench,
  integerToFrench,
  ordinalToFrench,
  timeToFrench,
} from '../src/french-numbers.js';
import {
  amountToFrench,
  isPendingLineStart,
  numberToFrench,
  speakableFrench,
  speakableLine,
} from '../src/speakable.js';

describe('nombres en toutes lettres', () => {
  it.each([
    [0, 'zéro'],
    [1, 'un'],
    [16, 'seize'],
    [17, 'dix-sept'],
    [21, 'vingt et un'],
    [22, 'vingt-deux'],
    [61, 'soixante et un'],
    [70, 'soixante-dix'],
    [71, 'soixante et onze'],
    [77, 'soixante-dix-sept'],
    [80, 'quatre-vingts'],
    [81, 'quatre-vingt-un'],
    [90, 'quatre-vingt-dix'],
    [91, 'quatre-vingt-onze'],
    [99, 'quatre-vingt-dix-neuf'],
    [100, 'cent'],
    [101, 'cent un'],
    [200, 'deux cents'],
    [201, 'deux cent un'],
    [280, 'deux cent quatre-vingts'],
    [1000, 'mille'],
    [1001, 'mille un'],
    [1999, 'mille neuf cent quatre-vingt-dix-neuf'],
    [2026, 'deux mille vingt-six'],
    [80_000, 'quatre-vingt mille'],
    [200_000, 'deux cent mille'],
    [1_000_000, 'un million'],
    [2_500_000, 'deux millions cinq cent mille'],
    [200_000_000, 'deux cents millions'],
    [1_000_000_000, 'un milliard'],
  ])('%i → %s', (n, words) => {
    expect(integerToFrench(n)).toBe(words);
  });

  it('accorde le « un » final au féminin seulement', () => {
    expect(integerToFrench(1, { feminine: true })).toBe('une');
    expect(integerToFrench(21, { feminine: true })).toBe('vingt et une');
    expect(integerToFrench(81, { feminine: true })).toBe('quatre-vingt-une');
    expect(integerToFrench(1_000_001, { feminine: true })).toBe('un million une');
    expect(integerToFrench(1_000_000, { feminine: true })).toBe('un million');
  });

  it('lit chiffre par chiffre au-delà de mille milliards et garde les zéros de tête', () => {
    expect(integerToFrench(1_000_000_000_000)).toBe(
      'un zéro zéro zéro zéro zéro zéro zéro zéro zéro zéro zéro zéro',
    );
    expect(digitStringToFrench('007')).toBe('zéro zéro sept');
    expect(digitStringToFrench('05')).toBe('zéro cinq');
  });

  it('ordinaux, dates et heures', () => {
    expect(ordinalToFrench(1)).toBe('premier');
    expect(ordinalToFrench(1, true)).toBe('première');
    expect(ordinalToFrench(2)).toBe('deuxième');
    expect(ordinalToFrench(3)).toBe('troisième');
    expect(ordinalToFrench(4)).toBe('quatrième');
    expect(ordinalToFrench(5)).toBe('cinquième');
    expect(ordinalToFrench(9)).toBe('neuvième');
    expect(ordinalToFrench(21)).toBe('vingt et unième');
    expect(ordinalToFrench(80)).toBe('quatre-vingtième');
    expect(ordinalToFrench(100)).toBe('centième');
    expect(dateToFrench(1, 11, 2026)).toBe('premier novembre deux mille vingt-six');
    expect(dateToFrench(10, 11)).toBe('dix novembre');
    expect(dateToFrench(10, 13, 2026)).toBeUndefined();
    expect(timeToFrench(1)).toBe('une heure');
    expect(timeToFrench(21, 1)).toBe('vingt et une heures une');
    expect(timeToFrench(14, 30)).toBe('quatorze heures trente');
    expect(timeToFrench(0, 5)).toBe('zéro heure cinq');
  });

  it('nombres écrits : virgule décimale, point de version, milliers', () => {
    expect(numberToFrench('3,5')).toBe('trois virgule cinq');
    expect(numberToFrench('3,05')).toBe('trois virgule zéro cinq');
    expect(numberToFrench('3.5')).toBe('trois point cinq');
    expect(numberToFrench('1 234')).toBe('mille deux cent trente-quatre');
  });

  it('montants', () => {
    expect(amountToFrench('12,50', '€')).toBe('douze euros cinquante');
    expect(amountToFrench('12,5', '€')).toBe('douze euros cinquante');
    expect(amountToFrench('1', '€')).toBe('un euro');
    expect(amountToFrench('0,99', '€')).toBe('quatre-vingt-dix-neuf centimes');
    expect(amountToFrench('0,01', '€')).toBe('un centime');
    expect(amountToFrench('1,05', '€')).toBe('un euro cinq');
    expect(amountToFrench('12,00', '€')).toBe('douze euros');
    expect(amountToFrench('1 000 000', '€')).toBe('un million d’euros');
    expect(amountToFrench('2,5', '€', 'M')).toBe('deux virgule cinq millions d’euros');
    expect(amountToFrench('1,5', '€', 'M')).toBe('un virgule cinq million d’euros');
    expect(amountToFrench('15', '€', 'k')).toBe('quinze mille euros');
    expect(amountToFrench('1,2', '€', 'k')).toBe('mille deux cents euros');
    expect(amountToFrench('5', '$')).toBe('cinq dollars');
    expect(amountToFrench('1', '£')).toBe('une livre');
    expect(amountToFrench('21', '£')).toBe('vingt et une livres');
  });
});

describe('speakableLine : markdown, URL et chemins', () => {
  it.each([
    ['**Bonjour** Gilles, *voici* le _résumé_ ~~faux~~.', 'Bonjour Gilles, voici le résumé faux.'],
    ['## Résultats', 'Résultats'],
    ['- Première ligne', 'Première ligne'],
    ['1. Étape une', 'Étape une'],
    ['> Citation', 'Citation'],
    ['- [x] Tâche faite', 'Tâche faite'],
    ['Lancez `npm install` ensuite.', 'Lancez npm install ensuite.'],
    ['Lisez [le rapport](https://example.com/r.pdf) avant.', 'Lisez le rapport avant.'],
    ['Voir https://example.com/docs?a=1&b=2. Merci.', 'Voir. Merci.'],
    ['Le site www.example.com est en ligne.', 'Le site est en ligne.'],
    ['Lien : <https://example.com>', 'Lien:'],
    ['Saut<br>de ligne', 'Saut de ligne'],
    ['Super 🎉 travail 👍🏽 !', 'Super travail!'],
  ])('%s', (input, expected) => {
    expect(speakableLine(input)).toBe(expected);
  });

  it('réduit un chemin complet au nom du fichier, lu « point csv »', () => {
    expect(speakableLine('J’ai lu /Users/gilles/Documents/ventes/mars.csv.')).toBe(
      'J’ai lu mars point csv.',
    );
    expect(speakableLine('Dans ~/YodAI/notes/compte_rendu.md, rien.')).toBe(
      'Dans compte rendu point md, rien.',
    );
    expect(speakableLine('Fichier `src/main/index.ts` modifié.')).toBe(
      'Fichier index point ts modifié.',
    );
    expect(speakableLine('Copié dans C:\\Users\\gilles\\rapport.pdf')).toBe(
      'Copié dans rapport point pdf',
    );
    expect(speakableLine('Le dossier /Users/gilles/Projets/ est vide.')).toBe(
      'Le dossier Projets est vide.',
    );
  });

  it('ne prend pas une unité, une fraction ou « et/ou » pour un chemin', () => {
    expect(speakableLine('À 90 km/h.')).toBe('À quatre-vingt-dix kilomètres par heure.');
    expect(speakableLine('Les 3/4 du budget.')).toBe('Les trois sur quatre du budget.');
    expect(speakableLine('Oui et/ou non.')).toBe('Oui et ou non.');
  });

  it('rend une chaîne vide quand il ne reste rien à dire', () => {
    expect(speakableLine('https://example.com/a')).toBe('');
    expect(speakableLine('---')).toBe('');
    expect(speakableLine('🎉')).toBe('');
  });
});

describe('speakableLine : nombres, montants, dates, heures, unités', () => {
  it.each([
    ['J’ai trouvé 3 fichiers.', 'J’ai trouvé trois fichiers.'],
    ['Il y a 1 erreur et 21 pages.', 'Il y a une erreur et vingt et une pages.'],
    [
      'Soit 1 234 567 lignes.',
      'Soit un million deux cent trente-quatre mille cinq cent soixante-sept lignes.',
    ],
    [
      'Soit 1.234.567 lignes.',
      'Soit un million deux cent trente-quatre mille cinq cent soixante-sept lignes.',
    ],
    ['Un taux de 3,5 ou -2.', 'Un taux de trois virgule cinq ou moins deux.'],
    [
      'Le total est de 1 234,50 € TTC.',
      'Le total est de mille deux cent trente-quatre euros cinquante toutes taxes comprises.',
    ],
    ['Prix : 12 € HT.', 'Prix: douze euros hors taxes.'],
    ['Il reste 0,99 €.', 'Il reste quatre-vingt-dix-neuf centimes.'],
    [
      'Budget de 2,5 M€ et 15 k€.',
      'Budget de deux virgule cinq millions d’euros et quinze mille euros.',
    ],
    ['Coût : €12 ou $5.', 'Coût: douze euros ou cinq dollars.'],
    ['En hausse de 12,5 % sur un an.', 'En hausse de douze virgule cinq pour cent sur un an.'],
    ['Le 10/11/2026.', 'Le dix novembre deux mille vingt-six.'],
    ['Le 1/3/26.', 'Le premier mars deux mille vingt-six.'],
    ['Le 2026-11-10.', 'Le dix novembre deux mille vingt-six.'],
    ['Le 10.11.2026.', 'Le dix novembre deux mille vingt-six.'],
    ['Le 1er novembre et le 1 décembre.', 'Le premier novembre et le premier décembre.'],
    ['De 2020-2026.', 'De deux mille vingt à deux mille vingt-six.'],
    ['À 14h30.', 'À quatorze heures trente.'],
    ['À 14 h 30.', 'À quatorze heures trente.'],
    ['À 9h.', 'À neuf heures.'],
    ['À 1h05.', 'À une heure cinq.'],
    ['À 21:00.', 'À vingt et une heures.'],
    ['Pendant 48 h.', 'Pendant quarante-huit heures.'],
    ['En 3 min et 1 s.', 'En trois minutes et une seconde.'],
    [
      'Un fichier de 2,5 Go, puis 512 Mo.',
      'Un fichier de deux virgule cinq gigaoctets, puis cinq cent douze mégaoctets.',
    ],
    [
      'Il fait 21 °C et -3 °C.',
      'Il fait vingt et un degrés Celsius et moins trois degrés Celsius.',
    ],
    ['Distance : 1,5 km ou 12 m.', 'Distance: un virgule cinq kilomètre ou douze mètres.'],
    ['Un débit de 104 tokens/s.', 'Un débit de cent quatre tokens par seconde.'],
    ['Trois fois plus vite : 3x.', 'Trois fois plus vite: trois fois.'],
    ['Le 2e, la 1re et le 21e.', 'Le deuxième, la première et le vingt et unième.'],
    ['Au XXIe siècle, en 1999.', 'Au XXIe siècle, en mille neuf cent quatre-vingt-dix-neuf.'],
    ['Dossier n° 3.', 'Dossier numéro trois.'],
    ['Version 2.0.1.', 'Version deux point zéro point un.'],
    ['Qwen3.5 sur le M4.', 'Qwen trois point cinq sur le M quatre.'],
    ['2 + 2 = 4', 'Deux plus deux égale quatre'],
    ['M. Dupont et Mme Martin.', 'monsieur Dupont et madame Martin.'],
  ])('%s', (input, expected) => {
    expect(speakableLine(input)).toBe(expected);
  });

  it('accepte les espaces insécables de la typographie française', () => {
    expect(speakableLine('Total\u00a0: 1\u202f234\u00a0€\u00a0!')).toBe(
      'Total: mille deux cent trente-quatre euros!',
    );
  });
});

describe('speakableFrench : texte complet', () => {
  it('retire tableaux, blocs de code et filets, ponctue titres et puces', () => {
    const text = [
      '## Ventes de mars',
      '',
      '| Mois | Total |',
      '|------|------:|',
      '| Mars | 12 € |',
      '',
      '```python',
      'print("1 234 €")',
      '```',
      '',
      '---',
      '- 3 clients',
      '- Total : 1 200 €',
      '',
      'Voilà le tableau.',
    ].join('\n');
    expect(speakableFrench(text)).toBe(
      'Ventes de mars. Trois clients. Total: mille deux cents euros. Voilà le tableau.',
    );
  });

  it('ne lit rien d’un bloc de code non fermé', () => {
    expect(speakableFrench('Voici :\n```\nrm -rf /\n')).toBe('Voici:');
  });
});

describe('isPendingLineStart', () => {
  it('attend la suite d’un préfixe ou d’un bloc', () => {
    for (const s of ['', '-', '- ', '##', '1', '12.', '- [', '- [ ]', '``', '|', '---', '***']) {
      expect(isPendingLineStart(s)).toBe(true);
    }
    for (const s of ['- P', '12 f', 'Bonjour', '## T']) expect(isPendingLineStart(s)).toBe(false);
  });

  it('reste linéaire sur une longue ligne de tirets', () => {
    const start = performance.now();
    isPendingLineStart(`${'-'.repeat(5000)}x`);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
