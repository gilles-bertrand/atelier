import { describe, expect, it } from 'vitest';
import { errorMessage } from './error-messages';

describe('errorMessage', () => {
  it('tâche planifiée invalide : reprend le message de validateSchedule', () => {
    expect(
      errorMessage({
        code: 'schedule/invalid',
        message: 'L’intervalle doit être d’au moins 15 minutes.',
        details: { field: 'schedule' },
      }),
    ).toBe('L’intervalle doit être d’au moins 15 minutes.');
    expect(errorMessage({ code: 'schedule/invalid' })).toBe(
      'Cette tâche planifiée n’est pas valide.',
    );
  });

  it('les autres codes gardent leur message, jamais le message technique', () => {
    expect(errorMessage({ code: 'schedule/not_found', message: 'no row' })).toBe(
      'Cette tâche planifiée n’existe plus.',
    );
    expect(errorMessage({ code: 'settings/invalid', message: 'bad value' })).toBe(
      'Ce réglage n’est pas valide.',
    );
  });
});
