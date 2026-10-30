/** Skills (dossier, liste) et connecteurs MCP (état, édition de mcp.json). */
import { useEffect, useId, useState } from 'react';
import { Folder, Loader2, Sparkles } from 'lucide-react';
import type { McpServerState, McpStatus, SkillInfo } from '@atelier/shared';
import { StatusDot, type StatusTone } from '@renderer/components/status/StatusDot';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Label } from '@renderer/components/ui/primitives';
import { atelier, call } from '@renderer/lib/api';
import { useApp } from '@renderer/state/app-state';
import { FeedbackLine, SettingsSection, useAction } from './common';

export function SkillsSettings() {
  const { state, actions } = useApp();
  const [skills, setSkills] = useState<SkillInfo[] | undefined>();
  const load = useAction();
  const change = useAction();
  const dir = state.settings.skillsDir;

  useEffect(() => {
    void load.run(async () => {
      setSkills(await call('skills:list'));
    });
    // Relu quand le dossier change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  return (
    <SettingsSection
      title="Skills"
      description="Des guides prêts à l’emploi (tableurs, rapports…) que l’assistant suit quand une demande s’y prête."
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm" title={dir}>
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-xs">{dir}</span>
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={change.busy}
          onClick={() =>
            void change.run(async () => {
              const chosen = await call('dialog:choose-directory', {
                title: 'Choisir le dossier des skills',
                defaultPath: dir,
              });
              if (chosen !== null) await actions.updateSettings({ skillsDir: chosen });
            })
          }
        >
          Changer…
        </Button>
      </div>
      <Hint>La machine isolée voit ce dossier en lecture seule après son prochain démarrage.</Hint>
      <FeedbackLine feedback={change.feedback ?? load.feedback} />
      {skills === undefined ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun skill dans ce dossier.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {skills.map((skill) => (
            <li key={skill.path} className="flex gap-2.5 px-3 py-2.5">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium">{skill.name}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

const MCP_STATES: Record<McpServerState, { label: string; tone: StatusTone }> = {
  connecting: { label: 'connexion…', tone: 'busy' },
  connected: { label: 'connecté', tone: 'ok' },
  reconnecting: { label: 'reconnexion…', tone: 'busy' },
  failed: { label: 'en échec', tone: 'error' },
  stopped: { label: 'arrêté', tone: 'idle' },
};

/** Erreur de syntaxe JSON lisible, ou `undefined`. */
export function jsonError(text: string): string | undefined {
  if (text.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'Le fichier doit contenir un objet JSON { "mcpServers": { … } }.';
    }
    return undefined;
  } catch (e) {
    return `JSON invalide : ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function McpSettings() {
  const editorId = useId();
  const hintId = useId();
  const [status, setStatus] = useState<McpStatus | undefined>();
  const [text, setText] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  const load = useAction();
  const save = useAction();

  useEffect(() => {
    void load.run(async () => {
      const [config, current] = await Promise.all([call('mcp:read-config'), call('mcp:status')]);
      setText(config);
      setSaved(config);
      setStatus(current);
    });
    return atelier().on('mcp:status', setStatus);
    // Chargement initial uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const error = text === undefined ? undefined : jsonError(text);
  const dirty = text !== saved;

  return (
    <SettingsSection
      title="Connecteurs (MCP)"
      description="Des services externes (agenda, notes, outils internes…) que l’assistant peut utiliser. Toute action d’écriture demande votre accord."
    >
      {status && status.servers.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {status.servers.map((server) => (
            <li key={server.name} className="space-y-1 px-3 py-2.5">
              <p className="flex items-center gap-2 text-sm">
                <StatusDot tone={MCP_STATES[server.state].tone} />
                <span className="font-medium">{server.name}</span>
                <span className="text-muted-foreground">
                  {MCP_STATES[server.state].label} · {server.toolCount} outil(s)
                </span>
              </p>
              {server.error ? (
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-destructive">
                  {server.error}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : status ? (
        <p className="text-sm text-muted-foreground">Aucun connecteur configuré.</p>
      ) : null}
      {status && status.issues.length > 0 ? (
        <Alert tone="warning" title="Connecteurs ignorés">
          <ul className="list-disc pl-4">
            {status.issues.map((issue) => (
              <li key={issue.server}>
                <strong className="font-medium">{issue.server}</strong> : {issue.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={editorId}>mcp.json</Label>
        {text === undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Chargement…
          </p>
        ) : (
          <textarea
            id={editorId}
            value={text}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(e) => {
              setText(e.target.value);
              save.clear();
            }}
            className="block h-64 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
          />
        )}
        <Hint id={hintId} className={error ? 'text-destructive' : undefined}>
          {error ??
            'Format Claude Desktop : { "mcpServers": { "nom": { "command": …, "args": […] } } }.'}
        </Hint>
      </div>
      <div className="flex items-center gap-3">
        <Button
          disabled={text === undefined || Boolean(error) || !dirty || save.busy}
          onClick={() =>
            void save.run(async () => {
              if (text === undefined) return;
              await call('mcp:write-config', { json: text });
              setSaved(text);
            }, 'Enregistré : les connecteurs modifiés redémarrent.')
          }
        >
          Enregistrer
        </Button>
        <FeedbackLine feedback={save.feedback ?? load.feedback} />
      </div>
    </SettingsSection>
  );
}
