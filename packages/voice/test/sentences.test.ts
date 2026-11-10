import { describe, expect, it } from 'vitest';
import {
  FIRST_CLAUSE_MIN_CHARS,
  MAX_CHUNK_CHARS,
  SpeechChunker,
  findFirstClauseEnd,
  findSentenceEnd,
  splitSpeech,
} from '../src/sentences.js';

/** Pousse le texte caractère par caractère, comme un flux de tokens très fin. */
function streamByChar(text: string): { chunks: string[]; firstAt: number } {
  const chunker = new SpeechChunker();
  const chunks: string[] = [];
  let firstAt = -1;
  for (let i = 0; i < text.length; i += 1) {
    const out = chunker.push(text[i] ?? '');
    if (out.length > 0 && firstAt < 0) firstAt = i + 1;
    chunks.push(...out);
  }
  chunks.push(...chunker.flush());
  return { chunks, firstAt };
}

describe('découpage en phrases', () => {
  it('une phrase par morceau, filtrée, première phrase coupée à la virgule', () => {
    expect(
      splitSpeech(
        'Bonjour Gilles, je lance l’analyse du fichier des ventes. Elle prendra 2 min ! Prêt ?',
      ),
    ).toEqual([
      'Bonjour Gilles,',
      'je lance l’analyse du fichier des ventes.',
      'Elle prendra deux minutes!',
      'Prêt?',
    ]);
  });

  it('coupe au premier deux-points quand il vient avant la virgule', () => {
    expect(splitSpeech('Voici le résultat : 3 erreurs, toutes corrigées.')).toEqual([
      'Voici le résultat:',
      'Trois erreurs, toutes corrigées.',
    ]);
  });

  it(`premier morceau d'au moins ${String(FIRST_CLAUSE_MIN_CHARS)} caractères : la virgule suivante`, () => {
    expect(splitSpeech('Oui, bien sûr, je regarde ça tout de suite.')).toEqual([
      'Oui, bien sûr,',
      'je regarde ça tout de suite.',
    ]);
  });

  it('ne coupe pas quand le reste de la phrase est trop court', () => {
    expect(splitSpeech('Bonjour Gilles, ça va ? Oui, très bien, merci beaucoup.')).toEqual([
      'Bonjour Gilles, ça va?',
      'Oui, très bien, merci beaucoup.',
    ]);
  });

  it('ne coupe que la première phrase de la réponse', () => {
    expect(splitSpeech('C’est fait. Ensuite, je regarde les factures du mois de mars.')).toEqual([
      'C’est fait.',
      'Ensuite, je regarde les factures du mois de mars.',
    ]);
  });

  it('option : pas de coupure à la virgule', () => {
    expect(
      splitSpeech('Bonjour Gilles, je lance l’analyse du fichier.', { splitFirstClause: false }),
    ).toEqual(['Bonjour Gilles, je lance l’analyse du fichier.']);
  });

  it('ne coupe ni sur les abréviations, ni sur les initiales, ni dans les nombres', () => {
    expect(
      splitSpeech(
        'J’ai écrit à M. Dupont et à J. Martin, p. ex. pour le devis de 3.5 jours. C’est envoyé.',
        { splitFirstClause: false },
      ),
    ).toEqual([
      'J’ai écrit à monsieur Dupont et à J. Martin, par exemple pour le devis de trois point cinq jours.',
      'C’est envoyé.',
    ]);
  });

  it('« etc. » finit la phrase devant une majuscule seulement', () => {
    expect(findSentenceEnd('Des pommes, etc. Puis du pain.')).toBe(16);
    expect(findSentenceEnd('Des pommes, etc. et du pain.')).toBe(-1);
  });

  it('chaque ligne est un morceau ; titres, puces et tableaux', () => {
    expect(
      splitSpeech(
        [
          '## Résumé',
          '- 3 clients',
          '- 1 facture en retard',
          '',
          '| Client | Montant |',
          '|---|---|',
          '| Nox | 1 200 € |',
          '',
          'Voilà.',
        ].join('\n'),
        { splitFirstClause: false },
      ),
    ).toEqual(['Résumé.', 'Trois clients.', 'Une facture en retard.', 'Voilà.']);
  });

  it('ne prononce jamais un bloc de code', () => {
    expect(
      splitSpeech('Voici le script :\n```bash\necho "Bonjour."\nls -la\n```\nIl est prêt.'),
    ).toEqual(['Voici le script:', 'Il est prêt.']);
  });

  it('coupe une phrase trop longue à une virgule', () => {
    const long = `${'mot '.repeat(60)}, ${'suite '.repeat(30)}fin`;
    const chunker = new SpeechChunker({ splitFirstClause: false });
    const out = chunker.push(long);
    expect(out).toHaveLength(1);
    expect(out[0]?.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 1);
    expect(out[0]?.endsWith(',')).toBe(true);
    expect(chunker.flush()).toEqual([`${'suite '.repeat(30)}fin.`]);
  });

  it('ignore les morceaux sans rien à dire (URL seule, emoji)', () => {
    expect(splitSpeech('https://example.com/a\n🎉\nFini.')).toEqual(['Fini.']);
  });
});

describe('découpage au fil du flux', () => {
  const answer = [
    'Bonjour Gilles, j’ai lu /Users/gilles/ventes/mars.csv : 1 234,50 € au total.',
    '',
    '| Mois | Total |',
    '|---|---|',
    '| Mars | 1 234,50 € |',
    '',
    '1. Le 10/11/2026 à 14h30, réunion.',
    '2. Ensuite, **relance** des 3 clients.',
    '```',
    'SELECT 1;',
    '```',
    'C’est tout. Autre chose ?',
  ].join('\n');

  it('rend les mêmes morceaux qu’en une fois, quel que soit le découpage du flux', () => {
    const whole = splitSpeech(answer);
    expect(streamByChar(answer).chunks).toEqual(whole);
    // Morceaux de 7 caractères, comme des tokens.
    const chunker = new SpeechChunker();
    const out: string[] = [];
    for (let i = 0; i < answer.length; i += 7) out.push(...chunker.push(answer.slice(i, i + 7)));
    out.push(...chunker.flush());
    expect(out).toEqual(whole);
    expect(whole).toEqual([
      'Bonjour Gilles,',
      'j’ai lu mars point csv: mille deux cent trente-quatre euros cinquante au total.',
      'Le dix novembre deux mille vingt-six à quatorze heures trente, réunion.',
      'Ensuite, relance des trois clients.',
      'C’est tout.',
      'Autre chose?',
    ]);
  });

  it('le premier morceau part dès la virgule, sans attendre la fin de la phrase', () => {
    const text = 'Bonjour Gilles, je lance l’analyse du fichier des ventes de mars.';
    const { firstAt } = streamByChar(text);
    // Dès que 12 caractères suivent la virgule.
    expect(firstAt).toBe('Bonjour Gilles, je lance l’a'.length);
  });

  it('une phrase part dès l’espace qui suit sa ponctuation', () => {
    const chunker = new SpeechChunker({ splitFirstClause: false });
    expect(chunker.push('C’est fait.')).toEqual([]);
    expect(chunker.push(' ')).toEqual(['C’est fait.']);
  });

  it('attend la fin d’un préfixe de liste avant de parler', () => {
    const chunker = new SpeechChunker({ splitFirstClause: false });
    expect(chunker.push('1')).toEqual([]);
    expect(chunker.push('2. ')).toEqual([]);
    expect(chunker.push('Douze fichiers. ')).toEqual(['Douze fichiers.']);
  });

  it('flush vide le découpeur', () => {
    const chunker = new SpeechChunker();
    chunker.push('```\ncode');
    expect(chunker.flush()).toEqual([]);
    expect(chunker.push('Bonjour. ')).toEqual(['Bonjour.']);
    expect(chunker.count).toBe(1);
  });
});

describe('findFirstClauseEnd', () => {
  it('rend la position après la première virgule ou le premier deux-points assez loin', () => {
    expect(findFirstClauseEnd('Bonjour Gilles, ça va')).toBe(15);
    expect(findFirstClauseEnd('Oui, non')).toBe(-1);
    expect(findFirstClauseEnd('Le chiffre 3,5 est bon, oui')).toBe(23);
  });
});
