/**
 * Configuration commune des tests de composants (matchers DOM, nettoyage).
 * Chargée seulement sous jsdom : les tests du main restent en Node pur.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
