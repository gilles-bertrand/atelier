/**
 * Écran de conversation : en-tête (titre, dossier, état du serveur, panneau de
 * suivi), fil des messages, saisie, et dépôt de fichiers sur toute la zone.
 */
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  FileSpreadsheet,
  FileText,
  Folder,
  Globe,
  PanelRight,
  ScanEye,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import type { FileCard, LlmModelInfo, SessionSummary } from '@atelier/shared';
import { AtelierMark } from '@renderer/components/AtelierMark';
import { ServerStatusBadge } from '@renderer/components/status/ServerStatusBadge';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { canReadImages, isImage } from '@renderer/lib/models';
import { fileName } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { isRunning } from '@renderer/state/chat-reducer';
import { useChat, useSessionView } from '@renderer/state/chat-store';
import { deriveSessionTitle } from '../../../../common/chat-reducer';
import { sameModel } from '../../../../common/model-name';
import { headerInset, SidebarOpenButton, useShellChrome } from '../sidebar/shell-chrome';
import { Composer, type PendingAttachment } from './Composer';
import { ContextGauge } from './ContextGauge';
import { FilePreviewContext, type FilePreviewControls } from './file-preview-context';
import { FilePreview } from './FilePreview';
import { MessageList } from './MessageList';
import { ModelPicker } from './ModelPicker';
import { changedFiles, fileRevisions, SidePanel } from './SidePanel';

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * Demandes types de la conversation vide : elles préremplissent la saisie (début
 * de phrase à compléter) sans rien envoyer. Teintes des familles de fichiers.
 */
export const SUGGESTIONS: readonly {
  label: string;
  prompt: string;
  icon: LucideIcon;
  tile: string;
}[] = [
  {
    label: 'Résumer un document',
    prompt: 'Résume le document ',
    icon: FileText,
    tile: 'bg-file-doc-soft text-file-doc',
  },
  {
    label: 'Créer un tableau Excel',
    prompt: 'Crée un tableau Excel qui ',
    icon: FileSpreadsheet,
    tile: 'bg-file-sheet-soft text-file-sheet',
  },
  {
    label: 'Chercher sur le web',
    prompt: 'Cherche sur le web ',
    icon: Globe,
    tile: 'bg-info-soft text-info-text',
  },
  {
    label: 'Lire une facture scannée',
    prompt: 'Lis la facture scannée ',
    icon: ScanEye,
    tile: 'bg-file-image-soft text-file-image',
  },
];

export function ChatView({
  session,
  onTitleChange,
  onSessionChange,
}: {
  session: SessionSummary;
  /** Titre dérivé du premier message (la colonne de gauche le reprend aussitôt). */
  onTitleChange?: (title: string) => void;
  /** Conversation mise à jour par le main (modèle choisi). */
  onSessionChange?: (session: SessionSummary) => void;
}) {
  const { state } = useApp();
  const { sidebarOpen } = useShellChrome();
  const { actions } = useChat();
  const view = useSessionView(session.id);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Le main nomme la session d'après le premier message : même règle ici.
  const [title, setTitle] = useState(session.title);
  const [panelOpen, setPanelOpen] = useState(true);
  const panelId = useId();
  // Fichier affiché dans l'aperçu (panneau droit, à la place du suivi).
  const [previewPath, setPreviewPath] = useState<string | undefined>();
  const previewId = useId();
  const [error, setError] = useState<string | undefined>();
  const dragDepth = useRef(0);
  const running = isRunning(view);
  // Conversation antérieure au choix par conversation : elle suit le défaut (D1).
  const model = session.model ?? state.settings.llm.model;
  const visionModel = state.settings.llm.visionModel;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Dernière liste lue sur le serveur : capacités et état chargé / à froid.
  const [models, setModels] = useState<LlmModelInfo[] | undefined>();
  const [coldChoice, setColdChoice] = useState<string | undefined>();
  const [modelLoading, setModelLoading] = useState(false);
  // « atelier » (conversation) correspond à « atelier:latest » (liste du serveur).
  const modelInfo = models?.find((m) => sameModel(m.name, model));
  const isCold = modelInfo?.loaded === false;
  const hasImage = pending.some((p) => isImage(p.attachment.mimeType));
  const visionSet = visionModel !== undefined && visionModel !== '';

  // Image jointe sans modèle vision réglé : capacités du modèle lues à la demande.
  useEffect(() => {
    if (!hasImage || visionSet || models) return;
    let cancelled = false;
    call('llm:list-models').then(
      (list) => {
        if (!cancelled) setModels(list);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [hasImage, visionSet, models]);
  const imageUnreadable = hasImage && canReadImages(modelInfo, visionModel) === false;

  const chooseModel = async (next: LlmModelInfo): Promise<void> => {
    setError(undefined);
    try {
      const updated = await call('session:set-model', { sessionId: session.id, model: next.name });
      onSessionChange?.(updated);
      setColdChoice(next.loaded === false ? next.name : undefined);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Suggestion choisie : curseur en fin de saisie, une fois le texte affiché.
  const [focusDraft, setFocusDraft] = useState(0);

  useEffect(() => {
    if (focusDraft === 0) return;
    const field = textarea.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [focusDraft]);

  useEffect(() => {
    if (view.loaded) return;
    actions.open(session.id).catch((e: unknown) => {
      setError(errorMessage(toSerializedError(e)));
    });
  }, [actions, session.id, view.loaded]);

  // Vignettes `blob:` créées : toutes libérées à la fermeture.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
  const revoke = (url: string | undefined): void => {
    if (!url) return;
    URL.revokeObjectURL(url);
    previews.current.delete(url);
  };

  const importFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setImporting(true);
    setError(undefined);
    try {
      const result = await atelier().importDroppedFiles(session.id, files);
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      setPending((current) => [
        ...current,
        ...result.value.map((attachment, i) => {
          const file = files[i];
          if (file?.type.startsWith('image/') !== true) return { attachment };
          const previewUrl = URL.createObjectURL(file);
          previews.current.add(previewUrl);
          return { attachment, previewUrl };
        }),
      ]);
    } finally {
      setImporting(false);
    }
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const attachments = pending.map((p) => p.attachment);
    if (text === '' && attachments.length === 0) return;
    setError(undefined);
    if (!view.messages.some((m) => m.role === 'user')) {
      const next = deriveSessionTitle(text, attachments[0]?.name);
      setTitle(next);
      onTitleChange?.(next);
    }
    setDraft('');
    for (const p of pending) revoke(p.previewUrl);
    setPending([]);
    // Premier message sur un modèle à froid : « Chargement du modèle… » (D3).
    setModelLoading(isCold);
    setColdChoice(undefined);
    if (isCold) {
      setModels((list) =>
        list?.map((m) => (sameModel(m.name, model) ? { ...m, loaded: true } : m)),
      );
    }
    try {
      await actions.send(session.id, text, attachments, model);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };

  // Dernière version connue de chaque fichier : l'aperçu suit les retouches de l'agent.
  const { files, revisions } = useMemo(() => {
    const all = view.live ? [...view.messages, view.live] : view.messages;
    return { files: changedFiles(all), revisions: fileRevisions(all) };
  }, [view.messages, view.live]);
  const [previewFallback, setPreviewFallback] = useState<FileCard | undefined>();
  const previewed =
    previewPath === undefined
      ? undefined
      : (files.find((f) => f.absolutePath === previewPath) ?? previewFallback);
  const previewControls = useMemo<FilePreviewControls>(
    () => ({
      selectedPath: previewPath,
      toggle: (file) => {
        setPreviewFallback(file);
        setPreviewPath((current) =>
          current === file.absolutePath ? undefined : file.absolutePath,
        );
      },
    }),
    [previewPath],
  );

  const guard = (task: Promise<void>): void => {
    task.catch((e: unknown) => {
      setError(errorMessage(toSerializedError(e)));
    });
  };

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b pr-4 [-webkit-app-region:drag]',
          headerInset(sidebarOpen),
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          <SidebarOpenButton />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">{title}</h1>
            <p
              className="flex items-center gap-1 truncate text-xs text-muted-foreground"
              title={session.workspace}
            >
              <Folder className="size-3" aria-hidden />
              {fileName(session.workspace)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <ServerStatusBadge status={state.server} />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Panneau de suivi"
            aria-expanded={previewed ? false : panelOpen}
            aria-controls={panelId}
            title={panelOpen && !previewed ? 'Masquer le suivi' : 'Afficher le suivi'}
            onClick={() => {
              // Depuis l'aperçu, le bouton revient au suivi.
              if (previewed) {
                setPreviewPath(undefined);
                setPanelOpen(true);
              } else setPanelOpen((open) => !open);
            }}
          >
            <PanelRight className="size-4" aria-hidden />
          </Button>
        </div>
      </header>

      <FilePreviewContext.Provider value={previewControls}>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {view.messages.length === 0 && !view.live && view.loaded ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-6 py-6 text-center">
                <AtelierMark className="mb-2 size-11" />
                <h2 className="text-lg font-semibold">Que puis-je faire pour vous ?</h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  Je travaille dans le dossier « {fileName(session.workspace)} » : je peux lire vos
                  documents, en créer de nouveaux, chercher sur internet et faire des calculs.
                </p>
                <ul
                  aria-label="Suggestions"
                  className="mt-4 grid w-full max-w-lg gap-2 sm:grid-cols-2"
                >
                  {SUGGESTIONS.map((suggestion) => {
                    const Icon = suggestion.icon;
                    return (
                      <li key={suggestion.label}>
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(suggestion.prompt);
                            setFocusDraft((n) => n + 1);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span
                            className={cn(
                              'flex size-7 shrink-0 items-center justify-center rounded-md',
                              suggestion.tile,
                            )}
                            aria-hidden
                          >
                            <Icon className="size-4" />
                          </span>
                          {suggestion.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <MessageList
                view={view}
                modelLoading={modelLoading}
                onRetry={() => {
                  setModelLoading(false);
                  guard(actions.retry(session.id, model));
                }}
                onChooseModel={() => {
                  setPickerOpen(true);
                }}
              />
            )}

            {error ? (
              <div className="mx-auto w-full max-w-3xl px-6 pb-2">
                <Alert tone="error">{error}</Alert>
              </div>
            ) : null}

            <Composer
              value={draft}
              onChange={setDraft}
              attachments={pending}
              onRemoveAttachment={(index) => {
                setPending((current) => {
                  const removed = current[index];
                  revoke(removed?.previewUrl);
                  return current.filter((_, i) => i !== index);
                });
              }}
              onSend={() => void send()}
              onStop={() => {
                guard(actions.stop(session.id));
              }}
              running={running}
              disabled={!view.loaded}
              importing={importing}
              status={
                <>
                  <ModelPicker
                    model={model}
                    disabled={running || !view.loaded}
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    onSelect={(next) => void chooseModel(next)}
                    onModels={setModels}
                  />
                  <ContextGauge sessionId={session.id} />
                </>
              }
              notice={
                imageUnreadable ? (
                  <Alert tone="warning">
                    Le modèle {model} ne lit pas les images et aucun modèle pour les images n’est
                    réglé : l’image jointe ne pourra pas être analysée. Choisissez un autre modèle,
                    ou réglez-en un dans Réglages › Serveur et modèle.
                  </Alert>
                ) : undefined
              }
              footer={
                coldChoice === model ? (
                  <Alert tone="warning">
                    Premier message plus lent : le serveur doit charger {model} (10 à 60 s). Les
                    autres utilisateurs du serveur peuvent être ralentis.
                  </Alert>
                ) : undefined
              }
              onAddFiles={(files) => void importFiles(files)}
              textareaRef={textarea}
            />
          </div>
          {previewed ? (
            <FilePreview
              key={previewed.absolutePath}
              id={previewId}
              file={previewed}
              revision={revisions.get(previewed.absolutePath) ?? 0}
              onClose={() => {
                setPreviewPath(undefined);
              }}
            />
          ) : panelOpen ? (
            <SidePanel id={panelId} view={view} />
          ) : null}
        </div>
      </FilePreviewContext.Provider>

      {dragging ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand/60 bg-background/90 text-sm"
        >
          <Upload className="size-6 text-brand" />
          Déposez vos fichiers : ils seront copiés dans le dossier de travail.
        </div>
      ) : null}
    </div>
  );
}
