import { describe, expect, it } from 'vitest';
import type { DeniedAction, ScheduledPermissions } from '@atelier/shared';
import {
  formatDuration,
  mcpToolChoices,
  parseList,
  plainSummary,
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

describe('connecteurs en écriture : cases par serveur', () => {
  it('outils en écriture des serveurs connectés ; outils enregistrés indisponibles gardés', () => {
    const { groups, unavailable } = mcpToolChoices(
      [
        {
          name: 'github',
          transport: 'stdio',
          state: 'connected',
          toolCount: 3,
          reconnectAttempts: 0,
          tools: [
            { name: 'mcp__github__create_issue', title: 'Créer un ticket', readOnly: false },
            { name: 'mcp__github__list_issues', readOnly: true },
            { name: 'mcp__github__comment', readOnly: false },
          ],
        },
        {
          name: 'jira',
          transport: 'http',
          state: 'reconnecting',
          toolCount: 0,
          reconnectAttempts: 2,
        },
      ],
      ['mcp__github__create_issue', 'mcp__github__gone', 'mcp__jira__add', 'mcp__slack__post'],
    );
    expect(groups).toEqual([
      {
        server: 'github',
        connected: true,
        tools: [
          { name: 'mcp__github__create_issue', label: 'Créer un ticket' },
          { name: 'mcp__github__comment', label: 'comment' },
        ],
      },
      { server: 'jira', connected: false, tools: [] },
    ]);
    expect(unavailable).toEqual([
      { name: 'mcp__github__gone', reason: 'missing_tool' },
      { name: 'mcp__jira__add', reason: 'disconnected' },
      { name: 'mcp__slack__post', reason: 'missing_server' },
    ]);
  });
});

describe('compte rendu en texte simple (#116)', () => {
  it('réduit le markdown à son texte, sur une ligne', () => {
    expect(
      plainSummary(
        [
          '## Bilan',
          '**Résultats :**',
          '- **Bruxelles** : 12 ventes',
          '* _Liège_ : `8` ventes',
          '1. Voir [le rapport](rapport.md) et ![graphique](g.png)',
          '> Note : ~~ancien~~ mis à jour',
          '---',
          '```',
          'code',
          '```',
        ].join('\n'),
      ),
    ).toBe(
      'Bilan · Résultats : · Bruxelles : 12 ventes · Liège : 8 ventes · Voir le rapport et graphique · Note : ancien mis à jour · code',
    );
  });

  it('garde les noms de fichiers, les astérisques isolés et les balises inoffensives en texte', () => {
    expect(plainSummary('Fichier rapport_mensuel_v2.xlsx, total 3 * 4 <b>gras</b>')).toBe(
      'Fichier rapport_mensuel_v2.xlsx, total 3 * 4 gras',
    );
  });
});
