import { describe, expect, it } from 'vitest';
import { pinnedUserDataDir } from './user-data.js';

describe('pinnedUserDataDir', () => {
  const appData = '/Users/test/Library/Application Support';

  it('épingle @atelier/desktop quand rien n’est imposé (le renommage YodAI ne le déplace pas)', () => {
    expect(pinnedUserDataDir(appData, false)).toBe(`${appData}/@atelier/desktop`);
  });

  it('laisse le --user-data-dir de la ligne de commande (e2e, QA, mesures)', () => {
    expect(pinnedUserDataDir(appData, true)).toBeUndefined();
  });
});
