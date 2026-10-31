/**
 * Scénarios du faux modèle (mode mock) pour les critères d'acceptation 2 à 5
 * de docs/BRIEF.md. Les demandes sont celles du brief, mot pour mot. Le faux
 * modèle joue la séquence d'outils qu'on attend d'un bon modèle ; l'e2e
 * vérifie ce que l'app en fait (tâches, permissions, cartes, VM, vision).
 */
import type { ChatMessage, MockScenario, MockStep, StepContext } from './mock-llm.js';
import { textOf } from './mock-llm.js';

export const PROMPTS = {
  excel: 'Fais-moi un Excel récapitulatif par mois avec un graphique, puis un résumé en markdown',
  node: 'Quelle est la dernière version LTS de Node.js ?',
  documents: 'Résume le rapport et fais un tableau des montants de la facture et du ticket',
  network: 'Lance `curl https://example.com` dans la VM',
} as const;

/** Totaux mensuels attendus (tous magasins), docs/DEMO.md. */
export const MONTHLY_TOTALS: Record<string, number> = {
  '2026-01': 15_211.4,
  '2026-02': 14_122.7,
  '2026-03': 14_655.2,
  '2026-04': 14_914.3,
  '2026-05': 15_083.2,
  '2026-06': 15_250.3,
};
export const GRAND_TOTAL = 89_237.1;

const todos = (
  statuses: ('pending' | 'in_progress' | 'completed')[],
  titles: string[],
): MockStep => ({
  toolCalls: [
    {
      name: 'todo_write',
      args: {
        todos: titles.map((title, i) => ({ id: String(i + 1), title, status: statuses[i] })),
      },
    },
  ],
});

const EXCEL_TASKS = [
  'Lire les 3 fichiers de ventes',
  'Créer recap.xlsx avec le skill xlsx',
  'Rédiger resume.md',
];

const RESUME_MD = `# Ventes janvier à juin 2026

| Mois | Total (€) |
| --- | ---: |
| 2026-01 | 15 211,40 |
| 2026-02 | 14 122,70 |
| 2026-03 | 14 655,20 |
| 2026-04 | 14 914,30 |
| 2026-05 | 15 083,20 |
| 2026-06 | 15 250,30 |
| **Total** | **89 237,10** |

Bruxelles réalise la plus grosse part des ventes, devant Liège et Namur.
`;

function concat(steps: MockStep[]): MockStep {
  return { toolCalls: steps.flatMap((s) => s.toolCalls ?? []) };
}

export const excelScenario: MockScenario = {
  name: 'critère 2 : excel',
  match: (t) => t.includes('Excel récapitulatif par mois'),
  steps: [
    todos(['in_progress', 'pending', 'pending'], EXCEL_TASKS),
    {
      toolCalls: ['bruxelles', 'liege', 'namur'].map((m) => ({
        name: 'read_file',
        args: { path: `ventes-${m}.csv` },
      })),
    },
    concat([
      todos(['completed', 'in_progress', 'pending'], EXCEL_TASKS),
      {
        toolCalls: [
          {
            name: 'bash',
            args: {
              command:
                'node /skills/xlsx/scripts/build-workbook.cjs /workspace/.atelier/recap-spec.json /workspace/recap.xlsx',
            },
          },
        ],
      },
    ]),
    concat([
      todos(['completed', 'completed', 'in_progress'], EXCEL_TASKS),
      { toolCalls: [{ name: 'write_file', args: { path: 'resume.md', content: RESUME_MD } }] },
    ]),
    concat([
      todos(['completed', 'completed', 'completed'], EXCEL_TASKS),
      { toolCalls: [{ name: 'present_file', args: { path: 'resume.md' } }] },
    ]),
    { text: 'Voici le résumé des ventes : 89 237,10 € sur six mois, tous magasins confondus.' },
  ],
};

export const NODE_SOURCE = 'https://nodejs.org/en/about/previous-releases';

export const nodeScenario: MockScenario = {
  name: 'critère 3 : web',
  match: (t) => t.includes('dernière version LTS de Node.js'),
  steps: [
    {
      toolCalls: [
        { name: 'web_search', args: { query: 'Node.js dernière version LTS', max_results: 5 } },
      ],
    },
    { toolCalls: [{ name: 'web_fetch', args: { url: NODE_SOURCE } }] },
    {
      text: `La dernière version LTS de Node.js est indiquée sur la page des versions.\n\nSources :\n- ${NODE_SOURCE}`,
    },
  ],
};

/** Chemin `.atelier/uploads/…` d'une pièce jointe mentionnée dans la conversation. */
export function uploadPath(messages: ChatMessage[], name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\.atelier/uploads/[^\\s\`'"()]*${escaped}`);
  for (const message of messages) {
    const match = pattern.exec(textOf(message.content));
    if (match) return match[0];
  }
  return `.atelier/uploads/${name}`;
}

const at =
  (build: (context: StepContext) => MockStep) =>
  (context: StepContext): MockStep =>
    build(context);

export const INVOICE_VISION =
  'Facture F-2026-0142 du 12/03/2026, Imprimerie Lambert SRL. Ramettes papier A4 80 g : 20 × 4,50 = 90,00 ; Cartouches toner noir : 3 × 62,00 = 186,00 ; Reliure de rapports : 12 × 7,25 = 87,00. Total HT 363,00 ; TVA 21 % 76,23 ; Total TTC 439,23 €.';
export const TICKET_VISION =
  'Ticket Boulangerie du Parc, 18/03/2026. Pain au levain 4,20 ; 4 × Croissant 5,20 ; Tarte aux pommes 12,50 ; 2 × Café 5,60. TOTAL EUR 27,50 dont TVA 6 % 1,56.';

export const documentsScenario: MockScenario = {
  name: 'critère 4 : documents',
  match: (t) => t.includes('Résume le rapport') || /facture|ticket/i.test(t),
  vision: (question) => (/ticket|caisse/i.test(question) ? TICKET_VISION : INVOICE_VISION),
  steps: [
    at(({ messages }) => ({
      toolCalls: ['1-10', '11-20', '21-30'].map((pages) => ({
        name: 'read_file',
        args: { path: uploadPath(messages, 'rapport-annuel-2025.pdf'), pages },
      })),
    })),
    at(({ messages }) => ({
      toolCalls: [
        {
          name: 'look_at',
          args: {
            path: uploadPath(messages, 'facture-scannee.pdf'),
            page: 1,
            question: 'Transcris les lignes de la facture et ses totaux.',
          },
        },
        {
          name: 'look_at',
          args: {
            path: uploadPath(messages, 'ticket-de-caisse.jpg'),
            question: 'Transcris les lignes du ticket de caisse et son total.',
          },
        },
      ],
    })),
    {
      text: [
        'Le rapport annuel 2025 décrit un chiffre d’affaires de 4,2 M€ (+12 %), 54 personnes et un résultat net de 238 000 €.',
        '',
        '| Document | Ligne | Montant |',
        '| --- | --- | ---: |',
        '| Facture F-2026-0142 | Total TTC | 439,23 |',
        '| Ticket Boulangerie du Parc | Total TTC | 27,50 |',
      ].join('\n'),
    },
  ],
};

export const networkScenario: MockScenario = {
  name: 'critère 5 : réseau',
  match: (t) => t.includes('curl https://example.com'),
  steps: [
    { toolCalls: [{ name: 'bash', args: { command: 'curl -sS -m 10 https://example.com' } }] },
    at(({ toolResults }) => ({
      text: /Example Domain/.test(toolResults.join('\n'))
        ? 'La commande a réussi : la page Example Domain a été téléchargée.'
        : 'La commande a échoué : la machine virtuelle n’a pas accès à Internet.',
    })),
  ],
};

/** Demandes des e2e du modèle par conversation (#13, #18). */
export const MODEL_PROMPTS = {
  first: 'Présente-toi en une phrase',
  second: 'Et maintenant, réponds avec l’autre modèle',
  slow: 'Prends ton temps pour répondre',
} as const;

/** Délai de la réponse « lente » : assez long pour agir pendant le tour. */
export const SLOW_REPLY_MS = 6_000;

export const modelScenario: MockScenario = {
  name: 'modèle par conversation',
  match: (t) => t === MODEL_PROMPTS.first || t === MODEL_PROMPTS.second,
  steps: [
    // Un court délai laisse voir « Chargement du modèle… » sur un modèle à froid.
    { text: 'Bonjour, je suis l’assistant d’Atelier.', promptTokens: 1_500, delayMs: 1_500 },
  ],
};

export const slowScenario: MockScenario = {
  name: 'tour lent',
  match: (t) => t === MODEL_PROMPTS.slow,
  steps: [{ text: 'Voilà, j’ai pris mon temps.', delayMs: SLOW_REPLY_MS }],
};

/** Demande des tâches planifiées (ADR-002, QA #20) : une lecture, une écriture, un compte rendu. */
export const SCHEDULE_PROMPT = 'Résume les ventes de Bruxelles dans note-ventes.md';
export const SCHEDULE_FILE = 'note-ventes.md';

export const scheduleScenario: MockScenario = {
  name: 'tâche planifiée',
  match: (t) => t === SCHEDULE_PROMPT,
  steps: [
    { toolCalls: [{ name: 'read_file', args: { path: 'ventes-bruxelles.csv' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: SCHEDULE_FILE,
            content: '# Ventes de Bruxelles\n\nLes ventes sont stables sur le semestre.\n',
          },
        },
      ],
    },
    at(({ toolResults }) => ({
      text: /refus/i.test(toolResults.at(-1) ?? '')
        ? `Lu ventes-bruxelles.csv.\nL’écriture de ${SCHEDULE_FILE} a été refusée : aucun fichier produit.`
        : `Lu ventes-bruxelles.csv.\nFichier produit : ${SCHEDULE_FILE}.`,
    })),
  ],
};

/** Projets (ADR-003, L5) : mémoire, dossiers rattachés (écriture et lecture seule), artefact. */
export const PROJECT_PROMPT = 'Prépare la synthèse du projet et publie le tableau de bord';
export const PROJECT_NOTE = 'Le client veut une synthèse chaque mois.';
export const PROJECT_FOLLOWUP = 'Que sais-tu déjà de ce projet ?';
export const PROJECT_TASK_PROMPT = 'Mets à jour le tableau de bord du projet';
export const ARTIFACT_FILE = 'Artefacts/tableau.html';
export const ARTIFACT_TITLE = 'Tableau des ventes';

const tableau = (label: string): string =>
  `<!doctype html><html lang="fr"><body><h1>${ARTIFACT_TITLE}</h1><p>${label}</p><script>document.body.dataset.ok = '1';</script></body></html>`;

export const projectScenario: MockScenario = {
  name: 'projet',
  match: (t) => t === PROJECT_PROMPT,
  steps: [
    { toolCalls: [{ name: 'memory_add', args: { note: PROJECT_NOTE } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: { path: 'Compta/synthese.md', content: '# Synthèse\n\nVentes stables.\n' },
        },
      ],
    },
    { toolCalls: [{ name: 'write_file', args: { path: 'Archives/brouillon.md', content: 'x' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: ARTIFACT_FILE, content: tableau('v1') } }] },
    {
      toolCalls: [
        { name: 'publish_artifact', args: { path: ARTIFACT_FILE, title: ARTIFACT_TITLE } },
      ],
    },
    {
      text: 'Synthèse écrite dans Compta ; Archives est en lecture seule ; tableau de bord publié.',
    },
  ],
};

export const projectFollowupScenario: MockScenario = {
  name: 'projet : suite',
  match: (t) => t === PROJECT_FOLLOWUP,
  steps: [{ text: 'Le client veut une synthèse chaque mois.' }],
};

export const projectTaskScenario: MockScenario = {
  name: 'projet : tâche',
  match: (t) => t === PROJECT_TASK_PROMPT,
  steps: [
    { toolCalls: [{ name: 'write_file', args: { path: ARTIFACT_FILE, content: tableau('run') } }] },
    {
      toolCalls: [
        { name: 'publish_artifact', args: { path: ARTIFACT_FILE, title: ARTIFACT_TITLE } },
      ],
    },
    { text: `Tableau de bord mis à jour.\nFichier produit : ${ARTIFACT_FILE}.` },
  ],
};

export const ALL_SCENARIOS: MockScenario[] = [
  excelScenario,
  nodeScenario,
  documentsScenario,
  networkScenario,
  modelScenario,
  slowScenario,
  scheduleScenario,
  projectScenario,
  projectFollowupScenario,
  projectTaskScenario,
];
