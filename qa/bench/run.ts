/**
 * Mesures de performance : débit du modèle (Ollama), démarrage de la VM,
 * changement de dossier, et (option) premier lancement complet de la VM.
 * Le temps de lancement de l'app se mesure côté Playwright (e2e/perf.spec.ts).
 *
 *   pnpm --filter @atelier/qa bench -- [--llm] [--vm] [--first-boot] [--runs 3]
 *
 * L'app ne doit pas tourner pendant `--vm` (même instance `atelier`).
 * `--first-boot` crée une instance jetable `atelier-bench` dans un LIMA_HOME
 * temporaire (le cache d'images de Lima, partagé, peut éviter le téléchargement).
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSystemPrompt } from '@atelier/agent-core';
import { LimaSandbox } from '@atelier/sandbox';

const REPO = resolve(import.meta.dirname, '..', '..');
const LLM_URL = process.env['ATELIER_LLM_URL'] ?? 'http://localhost:11434';
const MODEL = process.env['ATELIER_MODEL'] ?? 'atelier';
const LIMACTL =
  process.env['ATELIER_LIMACTL'] ??
  join(REPO, 'apps', 'desktop', 'resources', 'lima', 'bin', 'limactl');

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    llm: { type: 'boolean', default: false },
    vm: { type: 'boolean', default: false },
    'first-boot': { type: 'boolean', default: false },
    runs: { type: 'string', default: '3' },
  },
});
const RUNS = Number.parseInt(values.runs, 10);

type Stats = { min: number; median: number; max: number; samples: number[] };
function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? Number.NaN,
    median: sorted[Math.floor(sorted.length / 2)] ?? Number.NaN,
    max: sorted.at(-1) ?? Number.NaN,
    samples,
  };
}
const fmt = (s: Stats, unit: string, digits = 1): string =>
  `${s.median.toFixed(digits)} ${unit} (min ${s.min.toFixed(digits)}, max ${s.max.toFixed(digits)}, n=${String(s.samples.length)})`;

const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  model: MODEL,
  url: LLM_URL,
};
const lines: string[] = [];

/** Débit du modèle : génération, préremplissage et temps avant le premier token. */
async function benchLlm(): Promise<void> {
  // Prompt réaliste : le prompt système de l'app + une demande d'analyse.
  const system = buildSystemPrompt({
    workspace: '/Users/demo/Atelier-demo/ventes',
    now: new Date('2026-10-29T09:00:00Z'),
    skills: [
      {
        name: 'xlsx',
        description: 'Créer un classeur Excel (.xlsx) avec formules, totaux et graphiques.',
        path: '/Users/demo/Atelier/skills/xlsx/SKILL.md',
        guestPath: '/skills/xlsx/SKILL.md',
      },
    ],
    toolNames: [
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'glob',
      'grep',
      'bash',
      'todo_write',
      'present_file',
      'look_at',
      'web_search',
      'web_fetch',
      'tool_search',
    ],
    sandboxAvailable: true,
  });
  const csv = await readFile(join(REPO, 'fixtures', 'demo-ventes', 'ventes-namur.csv'), 'utf8');
  const user = `Voici un extrait de ventes :\n\n${csv.split('\n').slice(0, 150).join('\n')}\n\nRésume les tendances en 10 points détaillés.`;

  // Modèle chargé (le premier appel peut inclure le chargement en mémoire).
  const warm = (await (
    await fetch(`${LLM_URL}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({
        model: MODEL,
        prompt: 'Bonjour',
        stream: false,
        think: false,
        options: { num_predict: 1 },
      }),
    })
  ).json()) as { load_duration?: number };
  report['llm_load_ms'] = (warm.load_duration ?? 0) / 1e6;

  const gen: number[] = [];
  const prefill: number[] = [];
  const promptTokens: number[] = [];
  const ttft: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    // 1. /api/chat : compteurs exacts d'Ollama. Préfixe unique : pas de cache de prompt.
    const res = (await (
      await fetch(`${LLM_URL}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          think: false,
          messages: [
            { role: 'system', content: `[run ${String(i)}-${String(Date.now())}]\n${system}` },
            { role: 'user', content: user },
          ],
          options: { num_predict: 400, temperature: 0 },
        }),
      })
    ).json()) as {
      eval_count: number;
      eval_duration: number;
      prompt_eval_count: number;
      prompt_eval_duration: number;
    };
    gen.push(res.eval_count / (res.eval_duration / 1e9));
    prefill.push(res.prompt_eval_count / (res.prompt_eval_duration / 1e9));
    promptTokens.push(res.prompt_eval_count);

    // 2. /v1/chat/completions en streaming (le chemin de l'app) : temps avant le premier token.
    const t0 = performance.now();
    const response = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        reasoning_effort: 'none',
        max_tokens: 50,
        messages: [
          { role: 'system', content: `[ttft ${String(i)}-${String(Date.now())}]\n${system}` },
          { role: 'user', content: user },
        ],
      }),
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let first: number | undefined;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first === undefined && /"content":"[^"]/.test(decoder.decode(value)))
        first = performance.now() - t0;
    }
    ttft.push(first ?? Number.NaN);
  }
  const g = stats(gen);
  const p = stats(prefill);
  const t = stats(ttft);
  report['llm'] = { generation_tps: g, prefill_tps: p, ttft_ms: t, prompt_tokens: promptTokens };
  lines.push(
    `## Modèle ${MODEL}`,
    '',
    `- Chargement initial en mémoire : ${(report['llm_load_ms'] as number).toFixed(0)} ms (0 si déjà chargé)`,
    `- Génération : **${fmt(g, 'tokens/s')}**`,
    `- Préremplissage (prompt de ~${String(promptTokens[0])} tokens) : ${fmt(p, 'tokens/s', 0)}`,
    `- Premier token via /v1 en streaming (thinking coupé) : ${fmt(t, 'ms', 0)}`,
    '',
  );
}

async function benchVm(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-bench-')));
  const skillsDir = join(root, 'skills');
  const a = join(root, 'dossier-a');
  const b = join(root, 'dossier-b');
  await Promise.all([mkdir(skillsDir), mkdir(a), mkdir(b)]);
  const sandbox = new LimaSandbox({
    limactlPath: LIMACTL,
    templatesDir: join(REPO, 'lima'),
    skillsDir,
    resources: { cpus: 4, memoryGiB: 4, diskGiB: 30 },
    networkEnabled: false,
  });
  try {
    await sandbox.ensureReady(() => undefined);
    await sandbox.setWorkspace(a);
    const boots: number[] = [];
    const switches: number[] = [];
    const execs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await sandbox.stop();
      let t0 = performance.now();
      await sandbox.ensureReady(() => undefined);
      boots.push((performance.now() - t0) / 1000);

      t0 = performance.now();
      await sandbox.setWorkspace(i % 2 === 0 ? b : a);
      switches.push((performance.now() - t0) / 1000);

      for (let k = 0; k < 5; k++) {
        t0 = performance.now();
        await sandbox.exec('true', { timeoutMs: 10_000 });
        execs.push(performance.now() - t0);
      }
    }
    const bs = stats(boots);
    const ss = stats(switches);
    const es = stats(execs);
    report['vm'] = { boot_s: bs, switch_s: ss, exec_ms: es };
    lines.push(
      '## VM Lima (instance provisionnée, 4 CPU / 4 Gio)',
      '',
      `- Démarrage (arrêtée → prête) : **${fmt(bs, 's')}**`,
      `- Changement de dossier (arrêt + remontage + démarrage) : **${fmt(ss, 's')}** (objectif < 15 s)`,
      `- Aller-retour d'une commande (\`true\`) : ${fmt(es, 'ms', 0)}`,
      '',
    );
  } finally {
    await sandbox.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function benchFirstBoot(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-firstboot-')));
  const skillsDir = join(root, 'skills');
  await mkdir(skillsDir);
  // Chemin court : le socket SSH de Lima doit tenir dans UNIX_PATH_MAX (104 caractères),
  // ce que le dossier temporaire de macOS (/var/folders/…) dépasse.
  const limaHome = await realpath(await mkdtemp('/tmp/alb-'));
  const sandbox = new LimaSandbox({
    limactlPath: LIMACTL,
    templatesDir: join(REPO, 'lima'),
    skillsDir,
    limaHome,
    instanceName: 'atelier-bench',
    resources: { cpus: 4, memoryGiB: 4, diskGiB: 30 },
    networkEnabled: false,
  });
  const phases: { phase: string; at: number; message: string }[] = [];
  const t0 = performance.now();
  try {
    await sandbox.ensureReady((p) => {
      const last = phases.at(-1);
      if (last?.phase !== p.phase)
        phases.push({ phase: p.phase, at: (performance.now() - t0) / 1000, message: p.message });
    });
    const total = (performance.now() - t0) / 1000;
    report['first_boot'] = { total_s: total, phases };
    lines.push(
      '## Premier lancement de la VM (instance neuve, cache d’images Lima partagé)',
      '',
      `- Total jusqu'à « prête » : **${(total / 60).toFixed(1)} min** (${total.toFixed(0)} s)`,
      ...phases.map((p) => `  - ${p.at.toFixed(0)} s : ${p.phase} (${p.message})`),
      '',
    );
  } finally {
    await sandbox.reset().catch(() => undefined);
    await sandbox.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(limaHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const all = !values.llm && !values.vm && !values['first-boot'];
  if (values.llm || all) await benchLlm();
  if (values.vm || all) await benchVm();
  if (values['first-boot']) await benchFirstBoot();
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(REPO, 'qa', 'reports');
  await mkdir(dir, { recursive: true });
  const suffix = [values.llm && 'llm', values.vm && 'vm', values['first-boot'] && 'first-boot']
    .filter(Boolean)
    .join('-');
  const name = `bench-${date}${suffix ? `-${suffix}` : ''}`;
  await writeFile(join(dir, `${name}.json`), JSON.stringify(report, null, 2));
  await writeFile(join(dir, `${name}.md`), `# Mesures (${date})\n\n${lines.join('\n')}`);
  console.log(lines.join('\n'));
  console.log(`Rapport : qa/reports/${name}.md`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
