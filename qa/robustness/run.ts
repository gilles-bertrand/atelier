/**
 * Campagne de robustesse avec un vrai modèle : chaque scénario est rejoué N fois
 * et jugé automatiquement. Rapport Markdown + JSON dans qa/reports/.
 *
 *   pnpm --filter @atelier/qa robustness -- [--runs 3] [--only id1,id2] [--vm] [--no-thinking]
 *
 * `--vm` utilise la VM Lima de l'app (instance `atelier`, LIMA_HOME par défaut) :
 * l'app ne doit pas tourner en même temps. Variables : ATELIER_LLM_URL,
 * ATELIER_MODEL (défaut `atelier`), ATELIER_LIMACTL (défaut : ressources du dépôt).
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Sandbox } from '@atelier/shared';
import { LimaSandbox } from '@atelier/sandbox';
import { installExampleSkills, loadSkills } from '@atelier/skills';
import { LLM_MODEL, LLM_URL, runAgent, type RunTrace } from './harness.js';
import { newCanary, SCENARIOS, type Scenario, type Verdict } from './scenarios.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    runs: { type: 'string', default: '3' },
    only: { type: 'string' },
    vm: { type: 'boolean', default: false },
    thinking: { type: 'boolean', default: true },
  },
  allowNegative: true,
});

interface RunResult {
  scenario: string;
  run: number;
  verdict: Verdict;
  trace: Omit<RunTrace, 'reasoning'> & { reasoningChars: number };
}

/** Sondes réseau déterministes dans la VM (sans modèle), réseau coupé. */
const NETWORK_PROBES: { label: string; command: string }[] = [
  {
    label: 'HTTPS par nom',
    command: 'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com',
  },
  { label: 'HTTP par IP', command: 'curl -sS -m 8 -o /dev/null -w "%{http_code}" http://1.1.1.1' },
  { label: 'Résolution DNS', command: 'getent hosts example.com' },
  {
    label: 'Python urllib',
    command:
      'python3 -c "import urllib.request;print(urllib.request.urlopen(\'https://example.com\',timeout=8).status)"',
  },
  {
    label: 'TCP brut (nc)',
    command: 'timeout 8 bash -c "echo > /dev/tcp/1.1.1.1/443" && echo ouvert',
  },
  { label: 'ICMP (ping)', command: 'ping -c1 -W3 1.1.1.1' },
  { label: 'IPv6', command: 'curl -6 -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com' },
  {
    label: 'Ollama de l’hôte (host.lima.internal)',
    command: 'curl -sS -m 8 http://host.lima.internal:11434/api/version',
  },
  {
    label: 'Passerelle de l’hôte (192.168.5.2)',
    command: 'curl -sS -m 8 http://192.168.5.2:11434/api/version',
  },
  {
    label: 'SearXNG local de la VM',
    command: 'curl -sS -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:8888/healthz"',
  },
];

async function probeNetwork(
  sandbox: Sandbox,
): Promise<{ label: string; command: string; exitCode: number | null; output: string }[]> {
  const out = [];
  for (const probe of NETWORK_PROBES) {
    const result = await sandbox.exec(probe.command, { timeoutMs: 20_000 });
    out.push({
      ...probe,
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`.trim().slice(0, 200),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const runs = Number.parseInt(values.runs, 10);
  const only = values.only?.split(',').map((s) => s.trim());
  const selected = SCENARIOS.filter((s) => !only || only.includes(s.id));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-robustness-')));
  const skillsDir = join(root, 'skills');
  await mkdir(skillsDir, { recursive: true });
  await installExampleSkills(join(REPO, 'packages', 'skills', 'examples'), skillsDir);
  const skills = await loadSkills(skillsDir);

  let sandbox: LimaSandbox | undefined;
  if (values.vm) {
    sandbox = new LimaSandbox({
      limactlPath:
        process.env['ATELIER_LIMACTL'] ??
        join(REPO, 'apps', 'desktop', 'resources', 'lima', 'bin', 'limactl'),
      templatesDir: join(REPO, 'lima'),
      skillsDir,
      resources: { cpus: 4, memoryGiB: 4, diskGiB: 30 },
      networkEnabled: false,
      log: (m) => {
        if (process.env['QA_VERBOSE']) console.log(`[vm] ${m}`);
      },
    });
    const t0 = Date.now();
    await sandbox.ensureReady((p) => {
      if (process.env['QA_VERBOSE']) console.log(`[vm] ${p.phase}`);
    });
    console.log(`VM prête en ${String(Date.now() - t0)} ms`);
  }

  const results: RunResult[] = [];
  let probes: Awaited<ReturnType<typeof probeNetwork>> | undefined;
  try {
    for (const scenario of selected) {
      if (scenario.needsVm && !sandbox) {
        console.log(`- ${scenario.id} : ignoré (VM requise, relancer avec --vm)`);
        continue;
      }
      for (let run = 1; run <= runs; run++) {
        results.push(await runOnce(scenario, run, root, skills, sandbox));
      }
    }
    if (sandbox) {
      await sandbox.setNetwork(false);
      probes = await probeNetwork(sandbox);
    }
  } finally {
    if (sandbox) await sandbox.stop().catch(() => undefined);
  }

  await writeReport(results, probes, runs);
  await rm(root, { recursive: true, force: true });
}

async function runOnce(
  scenario: Scenario,
  run: number,
  root: string,
  skills: Awaited<ReturnType<typeof loadSkills>>,
  sandbox: LimaSandbox | undefined,
): Promise<RunResult> {
  const dir = join(root, `${scenario.id}-${String(run)}`);
  const workspace = join(dir, 'workspace');
  const outside = join(dir, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const ctx = { workspace, outside, canary: newCanary(), ...(sandbox ? { sandbox } : {}) };
  await writeFile(join(outside, 'secret.txt'), `Secret : ${ctx.canary}\n`);
  const prepared = await scenario.setup(ctx);
  if (sandbox && scenario.needsVm) {
    await sandbox.setWorkspace(workspace);
    await sandbox.setNetwork(false);
  }
  process.stdout.write(`- ${scenario.id} #${String(run)} … `);
  let trace: RunTrace;
  try {
    trace = await runAgent({
      ...prepared,
      workspace,
      skills,
      thinking: values.thinking,
      ...(sandbox && scenario.needsVm ? { sandbox } : {}),
    });
  } catch (error) {
    trace = {
      prompt: prepared.prompt,
      toolCalls: [],
      permissions: [],
      text: '',
      reasoning: '',
      reason: 'error',
      error: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      repairs: 0,
      compactions: 0,
      continuations: 0,
      logs: [],
    };
  }
  const verdict = await scenario.judge(trace, ctx);
  console.log(
    `${verdict.pass ? 'OK' : 'ÉCHEC'} (${String(Math.round(trace.durationMs / 1000))} s, ${String(trace.toolCalls.length)} outils)`,
  );
  for (const note of verdict.notes) console.log(`    ${note}`);
  const { reasoning, ...rest } = trace;
  return {
    scenario: scenario.id,
    run,
    verdict,
    trace: { ...rest, reasoningChars: reasoning.length },
  };
}

async function writeReport(
  results: RunResult[],
  probes: Awaited<ReturnType<typeof probeNetwork>> | undefined,
  runs: number,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  // Campagne partielle (--only) : rapport distinct, la campagne complète n'est pas écrasée.
  const name = `robustness-${date}${values.only ? `-${values.only.replace(/,/g, '+')}` : ''}`;
  const dir = join(REPO, 'qa', 'reports');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.json`),
    JSON.stringify({ model: LLM_MODEL, url: LLM_URL, results, probes }, null, 2),
  );

  const lines = [
    `# Robustesse avec ${LLM_MODEL} (${date})`,
    '',
    `Serveur ${LLM_URL}, ${String(runs)} exécution(s) par scénario, thinking ${values.thinking ? 'on' : 'off'}, permissions acceptées sauf mention contraire.`,
    '',
    '| Scénario | Catégorie | Réussites | Durée moyenne | Outils (moy.) | Constats |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const scenario of SCENARIOS) {
    const rs = results.filter((r) => r.scenario === scenario.id);
    if (rs.length === 0) continue;
    const ok = rs.filter((r) => r.verdict.pass).length;
    const avg = (f: (r: RunResult) => number): number =>
      rs.reduce((s, r) => s + f(r), 0) / rs.length;
    const notes = [...new Set(rs.flatMap((r) => r.verdict.notes))]
      .slice(0, 4)
      .join('<br>')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
    lines.push(
      `| ${scenario.id} | ${scenario.category} | ${String(ok)}/${String(rs.length)} | ${String(Math.round(avg((r) => r.trace.durationMs) / 1000))} s | ${avg((r) => r.trace.toolCalls.length).toFixed(1)} | ${notes} |`,
    );
  }
  if (probes) {
    lines.push(
      '',
      '## Sondes réseau dans la VM (réseau coupé, sans modèle)',
      '',
      '| Sonde | Code de sortie | Sortie |',
      '| --- | ---: | --- |',
    );
    for (const p of probes)
      lines.push(
        `| ${p.label} | ${String(p.exitCode)} | \`${p.output.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)}\` |`,
      );
  }
  await writeFile(join(dir, `${name}.md`), `${lines.join('\n')}\n`);
  console.log(`\nRapport : qa/reports/${name}.md`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
