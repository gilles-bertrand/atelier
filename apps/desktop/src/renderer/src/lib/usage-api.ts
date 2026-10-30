/** Lecture des statistiques d'utilisation (`usage:summary`, ADR-001). */
import type { UsagePeriod, UsageSummary } from '@atelier/shared';
import { call } from './api';

export function loadUsageSummary(period: UsagePeriod): Promise<UsageSummary> {
  return call('usage:summary', { period });
}
