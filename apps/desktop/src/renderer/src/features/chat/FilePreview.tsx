/**
 * Aperçu d'un fichier de la conversation dans le panneau droit, à la manière de
 * Claude : image, PDF (visionneuse de Chromium), markdown rendu, tableau
 * CSV, texte ou code en source. Le main sert le fichier par `atelier-file://`
 * après vérification (dossier de travail, liste blanche, rien d'exécutable).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ExternalLink, FolderOpen, Loader2, RotateCw, X } from 'lucide-react';
import type { FileCard } from '@atelier/shared';
import { FileTypeIcon } from '@renderer/components/FileTypeIcon';
import { Button } from '@renderer/components/ui/button';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import {
  detectDelimiter,
  filePreviewUrl,
  parseDelimited,
  previewMode,
  type PreviewMode,
} from '@renderer/lib/file-preview';
import { formatBytes } from '@renderer/lib/format';
import { fileName } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import type { WorkbookPreview } from '../../../../common/file-preview';
import { Markdown } from './Markdown';
import { MIN_CHAT_WIDTH, ResizeHandle, usePreviewWidth } from './ResizeHandle';

/** Lignes affichées au plus dans l'aperçu d'un tableau. */
const MAX_TABLE_ROWS = 500;

type TextState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string; truncated: boolean };

/** Contenu texte d'un fichier, relu à chaque changement d'URL (révision, rechargement). */
function useFileText(url: string): TextState {
  // Résultat étiqueté par son URL : une autre URL repart sur « chargement » sans effet de bord.
  const [result, setResult] = useState<{ url: string; state: TextState } | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    const settle = (state: TextState): void => {
      if (!controller.signal.aborted) setResult({ url, state });
    };
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        settle(
          response.ok
            ? {
                status: 'ready',
                text,
                truncated: response.headers.get('X-Atelier-Truncated') === '1',
              }
            : { status: 'error', message: text || 'Aperçu impossible.' },
        );
      })
      .catch((error: unknown) => {
        settle({
          status: 'error',
          message: error instanceof Error ? error.message : 'Aperçu impossible.',
        });
      });
    return () => {
      controller.abort();
    };
  }, [url]);
  return result?.url === url ? result.state : { status: 'loading' };
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <Centered>
      <AlertCircle className="size-5 text-destructive" aria-hidden />
      <p role="alert">{message}</p>
    </Centered>
  );
}

function Loading() {
  return (
    <Centered>
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <p role="status">Chargement de l’aperçu…</p>
    </Centered>
  );
}

/** Choix « Aperçu / Source » pour les formats rendus (markdown, tableau). */
function ViewToggle({
  source,
  onChange,
  renderedLabel,
}: {
  source: boolean;
  onChange: (source: boolean) => void;
  renderedLabel: string;
}) {
  const options = [
    { value: false, label: renderedLabel },
    { value: true, label: 'Source' },
  ];
  return (
    <div role="group" aria-label="Affichage" className="inline-flex rounded-md border p-0.5">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          aria-pressed={source === option.value}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(
            'rounded px-2 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            source === option.value
              ? 'bg-secondary font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Tableau de données (première ligne en en-tête) et note de troncature. */
function DataTable({ rows, note }: { rows: readonly string[][]; note?: string | undefined }) {
  const [header, ...body] = rows;
  if (!header) return <Centered>Aucune donnée.</Centered>;
  return (
    <div className="p-3">
      <div className="overflow-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  scope="col"
                  className="whitespace-nowrap border-b px-2 py-1.5 text-left font-medium"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="even:bg-muted/30">
                {row.map((cell, c) => (
                  <td key={c} className="whitespace-pre border-b px-2 py-1 align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function CsvTable({ text, path }: { text: string; path: string }) {
  const table = parseDelimited(text, detectDelimiter(text, path), MAX_TABLE_ROWS + 1);
  if (table.rows.length === 0) return <Centered>Fichier vide.</Centered>;
  const more = table.truncated || table.rows.length > MAX_TABLE_ROWS;
  return (
    <DataTable
      rows={table.rows.slice(0, MAX_TABLE_ROWS)}
      note={
        more ? `Seules les ${String(MAX_TABLE_ROWS)} premières lignes sont affichées.` : undefined
      }
    />
  );
}

function isWorkbook(value: unknown): value is WorkbookPreview {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { sheets?: unknown }).sheets)
  );
}

/** Classeur Excel converti par le main : un onglet par feuille. */
function WorkbookView({ json }: { json: string }) {
  const tabsId = useId();
  const [active, setActive] = useState(0);
  let workbook: WorkbookPreview | undefined;
  try {
    const value: unknown = JSON.parse(json);
    workbook = isWorkbook(value) ? value : undefined;
  } catch {
    workbook = undefined;
  }
  if (!workbook) return <PreviewError message="Aperçu du classeur illisible." />;
  if (workbook.sheets.length === 0) return <Centered>Classeur sans feuille.</Centered>;
  const index = Math.min(active, workbook.sheets.length - 1);
  const sheet = workbook.sheets[index];
  if (!sheet) return null;
  const notes = [
    sheet.totalRows > sheet.rows.length
      ? `${String(sheet.rows.length)} premières lignes sur ${String(sheet.totalRows)}.`
      : undefined,
    sheet.totalColumns > (sheet.rows[0]?.length ?? 0)
      ? `${String(sheet.rows[0]?.length ?? 0)} premières colonnes sur ${String(sheet.totalColumns)}.`
      : undefined,
  ].filter((n) => n !== undefined);
  const panelId = `${tabsId}-panel`;
  return (
    <div className="flex min-h-full flex-col">
      {workbook.sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label="Feuilles du classeur"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 pt-2"
          onKeyDown={(event) => {
            const count = workbook.sheets.length;
            const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (delta === 0) return;
            event.preventDefault();
            const next = (index + delta + count) % count;
            setActive(next);
            document.getElementById(`${tabsId}-tab-${String(next)}`)?.focus();
          }}
        >
          {workbook.sheets.map((s, i) => (
            <button
              key={`${s.name}-${String(i)}`}
              id={`${tabsId}-tab-${String(i)}`}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-controls={panelId}
              tabIndex={i === index ? 0 : -1}
              onClick={() => {
                setActive(i);
              }}
              className={cn(
                '-mb-px whitespace-nowrap rounded-t-md border border-b-0 px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                i === index
                  ? 'bg-background font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {s.name}
              {s.hidden ? <span className="text-muted-foreground"> (masquée)</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id={panelId}
        role={workbook.sheets.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={workbook.sheets.length > 1 ? `${tabsId}-tab-${String(index)}` : undefined}
      >
        {sheet.rows.length === 0 ? (
          <Centered>Feuille vide.</Centered>
        ) : (
          <DataTable rows={sheet.rows} note={notes.length > 0 ? notes.join(' ') : undefined} />
        )}
      </div>
    </div>
  );
}

function SourceText({ text }: { text: string }) {
  return (
    <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
      {text}
    </pre>
  );
}

function TextBody({
  mode,
  url,
  path,
  source,
}: {
  mode: Extract<PreviewMode, 'markdown' | 'table' | 'text' | 'document' | 'workbook'>;
  url: string;
  path: string;
  source: boolean;
}) {
  const state = useFileText(url);
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <PreviewError message={state.message} />;
  return (
    <>
      {state.truncated ? (
        <p className="border-b bg-warning-soft px-4 py-1.5 text-xs text-warning-text">
          Fichier volumineux : seul le début est affiché.
        </p>
      ) : null}
      {mode === 'workbook' ? (
        <WorkbookView json={state.text} />
      ) : mode === 'text' || source ? (
        <SourceText text={state.text} />
      ) : mode === 'markdown' || mode === 'document' ? (
        <div className="px-5 py-4 text-sm">
          {mode === 'document' ? (
            <p className="mb-3 text-xs text-muted-foreground">
              Aperçu simplifié : la mise en page d’origine (polices, marges, images) n’est pas
              reproduite.
            </p>
          ) : null}
          <Markdown text={state.text} />
        </div>
      ) : (
        <CsvTable text={state.text} path={path} />
      )}
    </>
  );
}

function ImageBody({ url, name }: { url: string; name: string }) {
  // Monté avec `key={url}` : une nouvelle version repart sans erreur.
  const [failed, setFailed] = useState(false);
  if (failed) return <PreviewError message="Impossible d’afficher cette image." />;
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <img
        src={url}
        alt={name}
        onError={() => {
          setFailed(true);
        }}
        className="max-h-full max-w-full rounded-md object-contain shadow-sm"
      />
    </div>
  );
}

export function FilePreview({
  id,
  file,
  revision,
  onClose,
}: {
  id: string;
  file: FileCard;
  /** Change quand un outil retouche le fichier : l'aperçu se recharge. */
  revision: number;
  onClose: () => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { width, setWidth } = usePreviewWidth();
  const [dragging, setDragging] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [source, setSource] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const name = fileName(file.path);
  const mode = previewMode(file.absolutePath);
  // Révision et rechargements manuels forment la clé de cache de l'URL.
  const url = filePreviewUrl(file.absolutePath, revision * 1000 + reloads);

  // Monté avec `key` = chemin : focus sur le titre à chaque nouveau fichier, le
  // lecteur d'écran annonce l'aperçu (et l'état local repart de zéro).
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const run = async (channel: 'file:open' | 'file:reveal'): Promise<void> => {
    setError(undefined);
    try {
      await call(channel, { absolutePath: file.absolutePath });
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };

  return (
    <aside
      id={id}
      ref={panel}
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      // Largeur choisie, jamais au point d'écraser la conversation si la fenêtre rétrécit.
      style={
        width !== undefined
          ? { width: `min(${String(width)}px, calc(100% - ${String(MIN_CHAT_WIDTH)}px))` }
          : undefined
      }
      className={cn(
        'relative flex min-w-80 shrink-0 flex-col border-l bg-background',
        width === undefined && 'w-[clamp(22rem,42%,48rem)]',
        dragging && 'select-none',
      )}
    >
      <ResizeHandle
        panel={panel}
        width={width}
        onResize={setWidth}
        onDragChange={setDragging}
        controls={id}
      />
      <div className="flex h-12 shrink-0 items-center gap-1 border-b pl-4 pr-2">
        <FileTypeIcon name={file.path} size="sm" />
        <div className="ml-1.5 min-w-0 flex-1">
          <h2
            id={headingId}
            ref={heading}
            tabIndex={-1}
            title={file.path}
            className="truncate text-sm font-medium focus:outline-none"
          >
            {name}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {[
              file.path.includes('/') ? file.path : undefined,
              file.size !== undefined ? formatBytes(file.size) : undefined,
            ]
              .filter((part) => part !== undefined)
              .join(' · ') || 'Aperçu'}
          </p>
        </div>
        {mode !== 'none' ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Recharger l’aperçu"
            title="Recharger"
            onClick={() => {
              setReloads((n) => n + 1);
            }}
          >
            <RotateCw className="size-4" aria-hidden />
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Ouvrir ${name}`}
          title="Ouvrir avec l’application par défaut"
          onClick={() => void run('file:open')}
        >
          <ExternalLink className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Afficher ${name} dans le Finder`}
          title="Afficher dans le Finder"
          onClick={() => void run('file:reveal')}
        >
          <FolderOpen className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Fermer l’aperçu"
          title="Fermer (Échap)"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      {mode === 'markdown' || mode === 'table' ? (
        <div className="flex shrink-0 items-center border-b px-4 py-1.5">
          <ViewToggle
            source={source}
            onChange={setSource}
            renderedLabel={mode === 'table' ? 'Tableau' : 'Aperçu'}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1',
          mode === 'pdf' ? 'overflow-hidden' : 'overflow-auto',
          // Pendant le glissement, l'iframe PDF ne doit pas capter le pointeur.
          dragging && 'pointer-events-none',
        )}
      >
        {mode === 'image' ? (
          <ImageBody key={url} url={url} name={name} />
        ) : mode === 'pdf' ? (
          <iframe key={url} src={url} title={`Aperçu de ${name}`} className="size-full border-0" />
        ) : mode === 'none' ? (
          <Centered>
            <FileTypeIcon name={file.path} />
            <p>Pas d’aperçu pour ce type de fichier.</p>
            <Button size="sm" variant="outline" onClick={() => void run('file:open')}>
              Ouvrir avec l’application par défaut
            </Button>
          </Centered>
        ) : (
          <TextBody mode={mode} url={url} path={file.path} source={source} />
        )}
      </div>
    </aside>
  );
}
