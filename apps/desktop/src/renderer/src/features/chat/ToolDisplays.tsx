/**
 * Affichages riches des résultats d'outils : carte de fichier cliquable,
 * résultats web, page lue, commande, modification, liste de tâches.
 */
import { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  CircleDot,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
} from 'lucide-react';
import type {
  FileCard as FileCardData,
  TodoItem,
  ToolDisplay,
  WebSearchResult,
} from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatBytes } from '@renderer/lib/format';
import { fileName, hostname, safeHttpUrl } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';

const ACTION_LABELS: Record<FileCardData['action'], string> = {
  created: 'Créé',
  modified: 'Modifié',
  presented: 'Fichier',
};

/** Carte de fichier : ouverture avec l'application par défaut, ou dans le Finder. */
export function FileCard({ file, compact = false }: { file: FileCardData; compact?: boolean }) {
  const [error, setError] = useState<string | undefined>();
  const run = async (channel: 'file:open' | 'file:reveal'): Promise<void> => {
    setError(undefined);
    try {
      await call(channel, { absolutePath: file.absolutePath });
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.path}>
            {fileName(file.path)}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {ACTION_LABELS[file.action]}
            {file.size !== undefined ? ` · ${formatBytes(file.size)}` : ''}
            {!compact && file.path.includes('/') ? ` · ${file.path}` : ''}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void run('file:open')}>
          Ouvrir
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Afficher ${fileName(file.path)} dans le Finder`}
          title="Afficher dans le Finder"
          onClick={() => void run('file:reveal')}
        >
          <FolderOpen className="size-4" aria-hidden />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Lien vers une page web (navigateur système). */
export function WebLink({ result }: { result: WebSearchResult }) {
  const url = safeHttpUrl(result.url);
  return (
    <li className="space-y-0.5">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-sm font-medium underline-offset-2 hover:underline"
        >
          {result.title || hostname(result.url)}
          <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
          <span className="sr-only"> (s’ouvre dans le navigateur)</span>
        </a>
      ) : (
        <span className="text-sm font-medium">{result.title}</span>
      )}
      <p className="text-xs text-muted-foreground">{hostname(result.url)}</p>
      {result.snippet ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{result.snippet}</p>
      ) : null}
    </li>
  );
}

const TODO_ICONS: Record<TodoItem['status'], typeof Circle> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CheckCircle2,
};
const TODO_STATUS: Record<TodoItem['status'], string> = {
  pending: 'à faire',
  in_progress: 'en cours',
  completed: 'terminée',
};

export function TodoList({ todos }: { todos: readonly TodoItem[] }) {
  return (
    <ul className="space-y-1">
      {todos.map((todo) => {
        const Icon = TODO_ICONS[todo.status];
        return (
          <li key={todo.id} className="flex items-start gap-2 text-sm">
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                todo.status === 'completed' ? 'text-emerald-600' : 'text-muted-foreground',
              )}
              aria-hidden
            />
            <span
              className={cn(todo.status === 'completed' && 'text-muted-foreground line-through')}
            >
              {todo.title}
              <span className="sr-only"> ({TODO_STATUS[todo.status]})</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Vrai si l'affichage doit rester visible même bloc replié (carte, liens). */
export function isProminentDisplay(display: ToolDisplay): boolean {
  return display.type === 'file' || display.type === 'web_results' || display.type === 'web_page';
}

/** Rendu d'un affichage riche. */
export function ToolDisplayView({ display }: { display: ToolDisplay }) {
  switch (display.type) {
    case 'file':
      return <FileCard file={display.file} />;
    case 'web_results':
      return (
        <ul className="space-y-2.5 rounded-lg border bg-card px-3 py-2.5">
          {display.results.map((r) => (
            <WebLink key={r.url} result={r} />
          ))}
        </ul>
      );
    case 'web_page': {
      const url = safeHttpUrl(display.url);
      return (
        <p className="flex items-center gap-2 text-sm">
          <Globe className="size-4 text-muted-foreground" aria-hidden />
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="underline-offset-2 hover:underline"
            >
              {display.title ?? hostname(display.url)}
            </a>
          ) : (
            display.url
          )}
        </p>
      );
    }
    case 'command':
      return (
        <div className="space-y-1">
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
            $ {display.command}
          </pre>
          {display.output ? (
            <pre className="max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {display.output}
            </pre>
          ) : null}
          <p className="text-xs text-muted-foreground">Code de sortie : {display.exitCode}</p>
        </div>
      );
    case 'diff':
      return (
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <p className="mb-1 font-medium text-muted-foreground">Avant</p>
            <pre className="max-h-48 overflow-auto rounded-md bg-red-50 p-2 font-mono dark:bg-red-950/30">
              {display.before}
            </pre>
          </div>
          <div>
            <p className="mb-1 font-medium text-muted-foreground">Après</p>
            <pre className="max-h-48 overflow-auto rounded-md bg-emerald-50 p-2 font-mono dark:bg-emerald-950/30">
              {display.after}
            </pre>
          </div>
        </div>
      );
    case 'todos':
      return <TodoList todos={display.todos} />;
  }
}
