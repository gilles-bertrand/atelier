/**
 * Visionneuse d'artefact (ADR-003 D5) : la page publiée par l'agent, avec le
 * sélecteur de version.
 *
 * Une page HTML s'affiche dans une `<iframe sandbox="allow-scripts">` SANS
 * `allow-same-origin` : origine opaque, aucun accès à `window.atelier`, au
 * stockage ni aux cookies ; ni formulaire, ni fenêtre, ni navigation de l'app.
 * Le main y ajoute une CSP sans réseau et bloque toute navigation vers le web.
 * Un artefact Markdown est rendu par le composant Markdown (jamais de HTML brut).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { AppWindow, FolderOpen, X } from 'lucide-react';
import { artifactUrl, type Artifact, type ArtifactVersion } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Select } from '@renderer/components/ui/primitives';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { cn } from '@renderer/lib/utils';
import { Markdown } from '../chat/Markdown';

/** Attributs du bac à sable : scripts de la page, et rien d'autre. */
export const ARTIFACT_SANDBOX = 'allow-scripts';

/** « v12 · 31/10 à 08:00 · Rapport hebdo » */
export function versionLabel(
  version: Pick<ArtifactVersion, 'version' | 'createdAt' | 'taskName'>,
): string {
  const at = new Date(version.createdAt);
  const date = at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  const time = at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return [
    `v${String(version.version)}`,
    `${date} à ${time}`,
    version.taskName ?? 'conversation',
  ].join(' · ');
}

export function ArtifactViewer({
  id,
  onClose,
  className,
}: {
  id: string;
  /** Absent : pas de bouton de fermeture. */
  onClose?: () => void;
  className?: string;
}) {
  const selectId = useId();
  const [artifact, setArtifact] = useState<Artifact | undefined>();
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  /** Version choisie ; `undefined` : toujours la dernière. */
  const [chosen, setChosen] = useState<number | undefined>();
  /** Texte d'un artefact Markdown, rattaché à l'URL lue (une autre version le périme). */
  const [markdown, setMarkdown] = useState<{ url: string; text: string } | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(
    (): Promise<void> =>
      Promise.all([call('artifact:get', { id }), call('artifact:versions', { id })]).then(
        ([found, list]) => {
          setArtifact(found);
          setVersions(list);
          setError(undefined);
        },
        (e: unknown) => {
          setError(errorMessage(toSerializedError(e)));
        },
      ),
    [id],
  );

  useEffect(() => {
    void load();
    // Nouvelle version publiée (run planifié, conversation) : la vue suit.
    return atelier().on('artifact:changed', ({ artifact: changed, deleted }) => {
      if (changed.id !== id) return;
      if (deleted) {
        setArtifact(undefined);
        setError('Cet artefact a été retiré de l’app.');
        return;
      }
      void load();
    });
  }, [id, load]);

  const shown = chosen ?? artifact?.version;
  const url = shown !== undefined ? artifactUrl(id, shown) : undefined;
  const isMarkdown = artifact?.format === 'markdown';

  useEffect(() => {
    if (!isMarkdown || url === undefined) return;
    let cancelled = false;
    fetch(url)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('lecture'))))
      .then(
        (text) => {
          if (!cancelled) setMarkdown({ url, text });
        },
        () => {
          if (!cancelled) setError('Lecture de l’artefact impossible.');
        },
      );
    return () => {
      cancelled = true;
    };
  }, [isMarkdown, url]);

  const reveal = (): void => {
    if (!artifact) return;
    call('file:reveal', { absolutePath: artifact.path }).catch((e: unknown) => {
      setError(errorMessage(toSerializedError(e)));
    });
  };

  return (
    <section
      aria-label={artifact ? `Artefact « ${artifact.title} »` : 'Artefact'}
      className={cn('flex min-h-0 flex-col', className)}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <AppWindow className="size-4 shrink-0 text-brand-text" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{artifact?.title ?? 'Artefact'}</h2>
          {artifact?.description ? (
            <p className="truncate text-xs text-muted-foreground">{artifact.description}</p>
          ) : null}
        </div>
        {versions.length > 0 ? (
          <>
            <label htmlFor={selectId} className="sr-only">
              Version affichée
            </label>
            <Select
              id={selectId}
              value={String(shown ?? '')}
              onChange={(e) => {
                const value = Number(e.target.value);
                setChosen(value === artifact?.version ? undefined : value);
              }}
              className="h-8 max-w-64 text-xs"
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {versionLabel(v)}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Afficher le fichier dans le Finder"
          title="Afficher le fichier dans le Finder"
          disabled={!artifact}
          onClick={reveal}
        >
          <FolderOpen className="size-4" aria-hidden />
        </Button>
        {onClose ? (
          <Button variant="ghost" size="icon" aria-label="Fermer l’artefact" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </header>
      {error ? (
        <div className="p-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {url === undefined ? null : isMarkdown ? (
          markdown?.url === url ? (
            <div className="p-4 text-sm">
              <Markdown text={markdown.text} />
            </div>
          ) : null
        ) : (
          <iframe
            key={url}
            title={artifact ? `Page « ${artifact.title} »` : 'Page de l’artefact'}
            src={url}
            sandbox={ARTIFACT_SANDBOX}
            referrerPolicy="no-referrer"
            className="h-full min-h-96 w-full border-0 bg-white"
          />
        )}
      </div>
    </section>
  );
}
