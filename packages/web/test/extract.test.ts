import { describe, expect, it } from 'vitest';
import { extractHtml } from '../src/index.js';
import { fixture } from './helpers.js';

describe('extractHtml', () => {
  const page = extractHtml(fixture('article.html'), 'https://journal.example/articles/node-24');

  it('récupère le titre de l’article', () => {
    expect(page.title).toMatch(/Node\.js 24/);
  });

  it('garde le contenu principal en markdown', () => {
    expect(page.markdown).toContain('**Node.js 24**');
    expect(page.markdown).toMatch(/^## Ce qui change$/m);
    expect(page.markdown).toMatch(/^- V8 13\.6$/m);
    expect(page.markdown).toContain('```\nnvm install 24\nnvm use 24\n```');
    expect(page.markdown).toContain('`URLPattern`');
  });

  it('rend les liens absolus', () => {
    expect(page.markdown).toContain(
      '[guide de migration](https://journal.example/articles/guide-migration-node-24)',
    );
  });

  it('écarte navigation, publicité, scripts et pied de page', () => {
    expect(page.markdown).not.toContain('NE DOIT PAS APPARAÎTRE');
    expect(page.markdown).not.toContain('INJECTION');
    expect(page.markdown).not.toContain('newsletter');
    expect(page.markdown).not.toContain('Rubriques');
    expect(page.markdown).not.toContain('tous droits réservés');
  });

  it('remplace les images par leur texte alternatif', () => {
    expect(page.markdown).toContain('[image : Logo de Node.js]');
    expect(page.markdown).not.toContain('base64');
  });

  it('se replie sur le body quand il n’y a pas d’article', () => {
    const short = extractHtml(
      '<html><head><title>Mini</title></head><body><p>Bonjour</p></body></html>',
      'https://a.example/',
    );
    expect(short.title).toBe('Mini');
    expect(short.markdown).toContain('Bonjour');
  });
});
