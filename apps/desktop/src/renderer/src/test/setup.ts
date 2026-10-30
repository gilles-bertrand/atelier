/**
 * Configuration commune des tests de composants (matchers DOM, nettoyage).
 * Chargée seulement sous jsdom : les tests du main restent en Node pur.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  // Fenêtre d'Atelier par défaut (1280 px) : la colonne de gauche est affichée.
  Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
  // jsdom n'implémente pas le défilement (listes déroulantes).
  Element.prototype.scrollIntoView = () => undefined;
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.innerWidth = 1280;
  });
}
