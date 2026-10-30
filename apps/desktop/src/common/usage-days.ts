/**
 * Jours des statistiques d'utilisation (ADR-001) : jour local et début de
 * période. Code pur partagé par le main (registre) et le renderer (barres).
 */
import type { UsagePeriod } from '@atelier/shared';

/** Jour local AAAA-MM-JJ (les barres quotidiennes suivent l'heure de l'utilisateur). */
export function localDay(date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Premier jour inclus d'une période (aujourd'hui compris), `undefined` pour « Tout ». */
export function periodStartDay(period: UsagePeriod, now: Date): string | undefined {
  if (period === 'all') return undefined;
  const days = period === '7d' ? 7 : 30;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return localDay(start);
}
