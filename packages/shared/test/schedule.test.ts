/** Récurrences des tâches planifiées (ADR-002), en heure locale `Europe/Paris` (vitest.config.ts). */
import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  MIN_INTERVAL_MINUTES,
  nextRunAt,
  validateSchedule,
  type Schedule,
} from '../src/index.js';

/** Date locale : mois de 1 à 12. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date =>
  new Date(y, mo - 1, d, h, mi);

describe('nextRunAt', () => {
  it('le fuseau des tests est bien Europe/Paris (heure d’été en juillet)', () => {
    expect(local(2026, 7, 1, 12).toISOString()).toBe('2026-07-01T10:00:00.000Z');
  });

  it('interval : ancré sur le dernier run, sans alignement sur l’horloge', () => {
    const lastRun = local(2026, 10, 31, 9, 7);
    expect(nextRunAt({ kind: 'interval', every: 15, unit: 'minutes' }, lastRun)).toEqual(
      local(2026, 10, 31, 9, 22),
    );
    expect(nextRunAt({ kind: 'interval', every: 2, unit: 'hours' }, lastRun)).toEqual(
      local(2026, 10, 31, 11, 7),
    );
  });

  it('daily : le jour même si l’heure n’est pas passée, sinon le lendemain', () => {
    const daily: Schedule = { kind: 'daily', time: '08:00' };
    expect(nextRunAt(daily, local(2026, 10, 31, 7, 59))).toEqual(local(2026, 10, 31, 8));
    // Strictement après : un run à 08:00 ne se reprogramme pas à 08:00.
    expect(nextRunAt(daily, local(2026, 10, 31, 8))).toEqual(local(2026, 11, 1, 8));
    // Fin d'année.
    expect(nextRunAt(daily, local(2026, 12, 31, 9))).toEqual(local(2027, 1, 1, 8));
  });

  it('weekly : prochain jour coché de la semaine', () => {
    const mondayThursday: Schedule = { kind: 'weekly', days: [1, 4], time: '08:00' };
    // Samedi 31 octobre 2026 → lundi 2 novembre.
    expect(nextRunAt(mondayThursday, local(2026, 10, 31, 10))).toEqual(local(2026, 11, 2, 8));
    // Lundi après 08:00 → jeudi.
    expect(nextRunAt(mondayThursday, local(2026, 11, 2, 8, 30))).toEqual(local(2026, 11, 5, 8));
    // Un seul jour, déjà passé aujourd'hui → la semaine suivante.
    expect(nextRunAt({ kind: 'weekly', days: [1], time: '08:00' }, local(2026, 11, 2, 9))).toEqual(
      local(2026, 11, 9, 8),
    );
  });

  it('monthly : le 31 est borné au dernier jour du mois (février, avril)', () => {
    const last: Schedule = { kind: 'monthly', day: 31, time: '09:00' };
    expect(nextRunAt(last, local(2027, 2, 1))).toEqual(local(2027, 2, 28, 9));
    expect(nextRunAt(last, local(2028, 2, 1))).toEqual(local(2028, 2, 29, 9));
    expect(nextRunAt(last, local(2027, 4, 1))).toEqual(local(2027, 4, 30, 9));
    // Le 31 janvier passé → fin février.
    expect(nextRunAt(last, local(2027, 1, 31, 10))).toEqual(local(2027, 2, 28, 9));
    expect(nextRunAt({ kind: 'monthly', day: 1, time: '09:00' }, local(2026, 12, 15))).toEqual(
      local(2027, 1, 1, 9),
    );
  });

  it('yearly : le 29 février devient le 28 les années non bissextiles', () => {
    const leap: Schedule = { kind: 'yearly', month: 2, day: 29, time: '10:00' };
    expect(nextRunAt(leap, local(2026, 3, 1))).toEqual(local(2027, 2, 28, 10));
    expect(nextRunAt(leap, local(2027, 3, 1))).toEqual(local(2028, 2, 29, 10));
    const bastille: Schedule = { kind: 'yearly', month: 7, day: 14, time: '08:00' };
    expect(nextRunAt(bastille, local(2026, 7, 14, 9))).toEqual(local(2027, 7, 14, 8));
  });

  it('heure d’été : 02:30 n’existe pas le 29 mars 2026 → 03:00', () => {
    const at = nextRunAt({ kind: 'daily', time: '02:30' }, local(2026, 3, 28, 12));
    expect(at.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect([at.getHours(), at.getMinutes()]).toEqual([3, 0]);
    // Le lendemain, 02:30 existe de nouveau.
    expect(nextRunAt({ kind: 'daily', time: '02:30' }, at).toISOString()).toBe(
      '2026-03-30T00:30:00.000Z',
    );
  });

  it('heure d’hiver : 02:30 existe deux fois le 25 octobre 2026 → la première', () => {
    const at = nextRunAt({ kind: 'daily', time: '02:30' }, local(2026, 10, 24, 12));
    // Première occurrence, encore en heure d'été (UTC+2).
    expect(at.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // Pas de second run à la seconde occurrence de 02:30 (UTC+1) : lendemain.
    expect(nextRunAt({ kind: 'daily', time: '02:30' }, at).toISOString()).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });

  it('l’heure locale est conservée de part et d’autre du changement d’heure', () => {
    const daily: Schedule = { kind: 'daily', time: '08:00' };
    expect(nextRunAt(daily, local(2026, 3, 28, 9)).toISOString()).toBe('2026-03-29T06:00:00.000Z');
    expect(nextRunAt(daily, local(2026, 10, 24, 9)).toISOString()).toBe('2026-10-25T07:00:00.000Z');
  });

  it('refuse une récurrence invalide', () => {
    expect(() =>
      nextRunAt({ kind: 'interval', every: 5, unit: 'minutes' }, local(2026, 10, 31)),
    ).toThrow(RangeError);
  });
});

describe('validateSchedule', () => {
  it(`refuse un intervalle de moins de ${String(MIN_INTERVAL_MINUTES)} minutes`, () => {
    expect(validateSchedule({ kind: 'interval', every: 14, unit: 'minutes' })).toBe(
      'L’intervalle doit être d’au moins 15 minutes.',
    );
    expect(validateSchedule({ kind: 'interval', every: 15, unit: 'minutes' })).toBeUndefined();
    expect(validateSchedule({ kind: 'interval', every: 1, unit: 'hours' })).toBeUndefined();
    expect(validateSchedule({ kind: 'interval', every: 0.5, unit: 'hours' })).toBe(
      'L’intervalle doit être un nombre entier positif.',
    );
  });

  it('refuse une heure qui n’est pas au format HH:MM', () => {
    for (const time of ['8:00', '24:00', '08:60', '0800', '']) {
      expect(validateSchedule({ kind: 'daily', time })).toMatch(/^Heure invalide/);
    }
    expect(validateSchedule({ kind: 'daily', time: '23:59' })).toBeUndefined();
  });

  it('refuse une semaine sans jour et des jours hors bornes', () => {
    expect(validateSchedule({ kind: 'weekly', days: [], time: '08:00' })).toBe(
      'Choisissez au moins un jour de la semaine.',
    );
    expect(validateSchedule({ kind: 'weekly', days: [8 as unknown as 1], time: '08:00' })).toBe(
      'Jour de la semaine invalide.',
    );
  });

  it('jour du mois et de l’année', () => {
    expect(validateSchedule({ kind: 'monthly', day: 32, time: '08:00' })).toBeDefined();
    expect(validateSchedule({ kind: 'monthly', day: 31, time: '08:00' })).toBeUndefined();
    expect(validateSchedule({ kind: 'yearly', month: 2, day: 29, time: '08:00' })).toBeUndefined();
    expect(validateSchedule({ kind: 'yearly', month: 2, day: 30, time: '08:00' })).toBe(
      'Ce jour n’existe pas dans ce mois.',
    );
    expect(validateSchedule({ kind: 'yearly', month: 13, day: 1, time: '08:00' })).toBe(
      'Mois invalide.',
    );
  });

  it('valeur venue de l’IPC : type inconnu ou absent', () => {
    expect(validateSchedule({ kind: 'cron' } as unknown as Schedule)).toBe(
      'Type de récurrence inconnu.',
    );
    expect(validateSchedule(null as unknown as Schedule)).toBe('Récurrence manquante.');
  });
});

describe('describeSchedule', () => {
  it('libellés en français', () => {
    expect(describeSchedule({ kind: 'interval', every: 15, unit: 'minutes' })).toBe(
      'Toutes les 15 minutes',
    );
    expect(describeSchedule({ kind: 'interval', every: 1, unit: 'hours' })).toBe(
      'Toutes les heures',
    );
    expect(describeSchedule({ kind: 'interval', every: 6, unit: 'hours' })).toBe(
      'Toutes les 6 heures',
    );
    expect(describeSchedule({ kind: 'daily', time: '08:00' })).toBe('Chaque jour à 08:00');
    expect(describeSchedule({ kind: 'weekly', days: [4, 1], time: '08:00' })).toBe(
      'Tous les lundis et jeudis à 08:00',
    );
    expect(describeSchedule({ kind: 'weekly', days: [1, 3, 5], time: '07:30' })).toBe(
      'Tous les lundis, mercredis et vendredis à 07:30',
    );
    expect(describeSchedule({ kind: 'weekly', days: [5], time: '17:00' })).toBe(
      'Chaque vendredi à 17:00',
    );
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })).toBe(
      'Du lundi au vendredi à 09:00',
    );
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], time: '09:00' })).toBe(
      'Chaque jour à 09:00',
    );
    expect(describeSchedule({ kind: 'monthly', day: 1, time: '08:00' })).toBe(
      'Le 1er de chaque mois à 08:00',
    );
    expect(describeSchedule({ kind: 'monthly', day: 31, time: '08:00' })).toBe(
      'Le 31 de chaque mois (ou le dernier jour du mois) à 08:00',
    );
    expect(describeSchedule({ kind: 'yearly', month: 7, day: 14, time: '08:00' })).toBe(
      'Chaque année le 14 juillet à 08:00',
    );
    expect(describeSchedule({ kind: 'yearly', month: 2, day: 29, time: '08:00' })).toBe(
      'Chaque année le 29 février (le 28 les autres années) à 08:00',
    );
  });
});
