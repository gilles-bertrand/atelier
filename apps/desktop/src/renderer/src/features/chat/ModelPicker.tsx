/**
 * Choix du modèle de la conversation, dans la barre du Composer (#13, D1 à D3).
 * Bouton compact + liste déroulante accessible (motif « listbox » de l'APG) :
 * flèches, Début / Fin, Entrée, Échap ; le focus revient au bouton à la fermeture.
 * La liste est relue à chaque ouverture : l'état chargé / à froid change vite.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Brain, Check, ChevronDown, Eye, Loader2, Wrench } from 'lucide-react';
import type { LlmModelInfo } from '@atelier/shared';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatBytes, formatContext } from '@renderer/lib/format';
import {
  chatModels,
  isTestedModel,
  NO_TOOLS_REASON,
  profileLabel,
  supportsTools,
} from '@renderer/lib/models';
import { cn } from '@renderer/lib/utils';
import { sameModel } from '../../../../common/model-name';

type ListState = { ok: true; models: LlmModelInfo[] } | { ok: false; error: string };

/** Pastille prêt (en mémoire sur le serveur) / à froid ; rien si l'état est inconnu. */
export function ReadyDot({ loaded }: { loaded: boolean | undefined }) {
  if (loaded === undefined) return null;
  const label = loaded ? 'prêt' : 'à froid';
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span
        className={cn('size-2 rounded-full', loaded ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
        aria-hidden
      />
      {label}
    </span>
  );
}

const CAPABILITY_ICONS = [
  { capability: 'tools', label: 'outils', Icon: Wrench },
  { capability: 'vision', label: 'images', Icon: Eye },
  { capability: 'thinking', label: 'réflexion', Icon: Brain },
] as const;

function ModelOption({
  model,
  all,
  id,
  selected,
  active,
  onPick,
  onHover,
}: {
  model: LlmModelInfo;
  all: readonly LlmModelInfo[];
  id: string;
  selected: boolean;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const usable = supportsTools(model);
  const profile = profileLabel(model.name);
  const details = [
    profile,
    model.sizeBytes !== undefined ? formatBytes(model.sizeBytes) : undefined,
    model.contextWindow !== undefined
      ? `contexte ${formatContext(model.contextWindow)}`
      : undefined,
  ].filter((d): d is string => d !== undefined);
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={usable ? undefined : true}
      onMouseDown={(e) => {
        // Garde le focus sur la liste (sinon elle se ferme avant le clic).
        e.preventDefault();
      }}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        'flex gap-2 rounded-md px-2.5 py-2 text-sm',
        usable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
        active ? 'bg-accent' : undefined,
      )}
    >
      <Check
        className={cn('mt-0.5 size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
        aria-hidden
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{model.name}</span>
          {!isTestedModel(model, all) ? (
            <span className="shrink-0 rounded border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              non testé
            </span>
          ) : null}
          <span className="ml-auto shrink-0">
            <ReadyDot loaded={model.loaded} />
          </span>
        </span>
        <span className="flex items-start gap-2 text-xs text-muted-foreground">
          {details.length > 0 ? <span className="min-w-0">{details.join(' · ')}</span> : null}
          {model.capabilities ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {CAPABILITY_ICONS.filter(({ capability }) =>
                model.capabilities?.includes(capability),
              ).map(({ capability, label, Icon }) => (
                <span key={capability} title={label}>
                  <Icon className="size-3.5" aria-hidden />
                  <span className="sr-only">{label}</span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
        {!usable ? (
          <span className="block text-xs text-muted-foreground">
            Indisponible : {NO_TOOLS_REASON}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function ModelPicker({
  model,
  disabled,
  open,
  onOpenChange,
  onSelect,
  onModels,
}: {
  /** Modèle effectif de la conversation. */
  model: string;
  /** Pendant un tour : le modèle ne change qu'entre deux messages (D1). */
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Modèle choisi (différent de l'actuel et utilisable). */
  onSelect: (model: LlmModelInfo) => void;
  /** Liste lue sur le serveur (capacités, état chargé), pour le reste de la vue. */
  onModels?: (models: LlmModelInfo[]) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLUListElement>(null);
  const [list, setList] = useState<ListState | undefined>();
  const [active, setActive] = useState(0);
  const models = list?.ok ? list.models : [];

  // Relue à chaque ouverture ; `list` est remis à zéro à la fermeture.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    call('llm:list-models').then(
      (all) => {
        if (cancelled) return;
        const shown = chatModels(all);
        setList({ ok: true, models: shown });
        setActive(
          Math.max(
            0,
            shown.findIndex((m) => sameModel(m.name, model)),
          ),
        );
        onModels?.(all);
      },
      (e: unknown) => {
        if (!cancelled) setList({ ok: false, error: errorMessage(toSerializedError(e)) });
      },
    );
    return () => {
      cancelled = true;
    };
    // Une lecture par ouverture : le modèle courant ne change pas liste ouverte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) listbox.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${String(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  const close = (focusButton: boolean): void => {
    setList(undefined);
    onOpenChange(false);
    if (focusButton) button.current?.focus();
  };

  const pick = (index: number): void => {
    const target = models[index];
    if (!target || !supportsTools(target)) return;
    close(true);
    // « atelier:latest » choisi pour une conversation sur « atelier » : même modèle, rien à changer.
    if (!sameModel(target.name, model)) onSelect(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const last = models.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        setActive((i) => Math.min(last, i + 1));
        break;
      case 'ArrowUp':
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(Math.max(0, last));
        break;
      case 'Enter':
      case ' ':
        pick(active);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Modèle : ${model}`}
        title={disabled ? 'Modifiable entre deux messages' : 'Changer de modèle'}
        disabled={disabled}
        onClick={() => {
          if (open) close(false);
          else onOpenChange(true);
        }}
        className="inline-flex max-w-48 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        <span className="truncate">{model}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>

      {open ? (
        <div className="absolute bottom-full right-0 z-20 mb-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Modèle de cette conversation
          </p>
          {!list ? (
            <p
              className="flex items-center gap-2 px-2.5 py-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Lecture des modèles du serveur…
            </p>
          ) : !list.ok ? (
            <p className="px-2.5 py-2 text-sm text-destructive" role="alert">
              Liste des modèles indisponible : {list.error}
            </p>
          ) : models.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-muted-foreground" role="status">
              Aucun modèle sur le serveur.
            </p>
          ) : null}
          <ul
            ref={listbox}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label="Modèles du serveur"
            aria-activedescendant={models.length > 0 ? `${listId}-${String(active)}` : undefined}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
              // Clic ailleurs : fermeture (le bouton gère lui-même la bascule).
              if (!root.current?.contains(e.relatedTarget)) close(false);
            }}
            className="max-h-80 overflow-y-auto outline-none"
          >
            {models.map((m, i) => (
              <ModelOption
                key={m.name}
                id={`${listId}-${String(i)}`}
                model={m}
                all={models}
                selected={sameModel(m.name, model)}
                active={i === active}
                onPick={() => {
                  pick(i);
                }}
                onHover={() => {
                  setActive(i);
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
