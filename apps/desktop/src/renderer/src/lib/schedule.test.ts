import { describe, expect, it } from 'vitest';
import type { DeniedAction, ScheduledPermissions } from '@atelier/shared';
import {
  formatDuration,
  parseList,
  permissionsAfterDenied,
  relativeNext,
  runDayBars,
  upcomingRuns,
} from './schedule';

const NOW = new Date(2026, 9, 31, 9, 0);

describe('affichage des tâches planifiées', () => {
  it('trois prochaines exécutions, rien si la récurrence est invalide', () => {
    expect(upcomingRuns({ kind: 'daily', time: '08:00' }, NOW).map((d) => d.getDate())).toEqual([
      1, 2, 3,
    ]);
    expect(upcomingRuns({ kind: 'interval', every: 5, unit: 'minutes' }, NOW)).toEqual([]);
  });

  it('échéance relative', () => {
    expect(relativeNext(new Date(2026, 9, 31, 9, 12), NOW)).toBe('dans 12 min');
    expect(relativeNext(new Date(2026, 9, 31, 13, 0), NOW)).toBe('dans 4 h');
    expect(relativeNext(new Date(2026, 10, 1, 8, 0), NOW)).toBe('demain à 08:00');
    expect(relativeNext(new Date(2026, 10, 3, 8, 0), NOW)).toBe('le 3 nov. à 08:00');
    expect(relativeNext(new Date(2026, 9, 31, 8, 0), NOW)).toBe('en retard');
  });

  it('durées', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(125_000)).toBe('2 min 05 s');
    expect(formatDuration(3_780_000)).toBe('1 h 03 min');
  });

  it('barres : jours sans run inclus sur 7 jours', () => {
    const bars = runDayBars([{ day: '2026-10-30', success: 2, error: 1, skipped: 0 }], '7d', NOW);
    expect(bars).toHaveLength(7);
    expect(bars.at(-2)).toEqual({ day: '2026-10-30', success: 2, error: 1, skipped: 0 });
    expect(bars.at(-1)).toEqual({ day: '2026-10-31', success: 0, error: 0, skipped: 0 });
  });

  it('« Autoriser pour cette tâche » coche les cases des refus, jamais suppression ni action inconnue', () => {
    const policy: ScheduledPermissions = {
      fileWrite: false,
      commands: false,
      webDomains: ['a.fr'],
      mcpTools: [],
    };
    const denied: DeniedAction[] = [
      { toolName: 'write_file', kind: 'file_write', scopeKey: 'write_file', title: 'Écrire a.md' },
      { toolName: 'bash', kind: 'command', scopeKey: 'bash', title: 'Lancer ls' },
      { toolName: 'web_fetch', kind: 'network', scopeKey: 'web_fetch:b.fr', title: 'Lire b.fr' },
      { toolName: 'mcp__gh__issue', kind: 'mcp_write', scopeKey: 'mcp__gh__issue', title: 'Issue' },
      {
        toolName: 'delete_file',
        kind: 'file_delete',
        scopeKey: 'delete_file',
        title: 'Supprimer x',
      },
    ];
    const { permissions, notGrantable } = permissionsAfterDenied(policy, denied);
    expect(permissions).toEqual({
      fileWrite: true,
      commands: true,
      webDomains: ['a.fr', 'b.fr'],
      mcpTools: ['mcp__gh__issue'],
    });
    expect(notGrantable.map((d) => d.title)).toEqual(['Supprimer x']);
    // La politique d'origine n'est pas modifiée.
    expect(policy.webDomains).toEqual(['a.fr']);
  });

  it('listes saisies : séparateurs souples, sans doublon ni vide', () => {
    expect(parseList(' a.fr, b.fr\n\na.fr ;c.fr ')).toEqual(['a.fr', 'b.fr', 'c.fr']);
  });
});
