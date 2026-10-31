/**
 * Modale « Nouveau projet » (ADR-003 D7) : nom, description, dossier principal
 * (créé dans ~/Atelier/Projets, ou un dossier existant) et dossiers rattachés
 * facultatifs, en lecture seule ou en lecture et écriture.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import {
  defaultFolderLabel,
  projectDirName,
  validateProjectInput,
  type Project,
  type ProjectFolder,
} from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label, Select } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { useApp } from '@renderer/state/app-state';

/** Racine affichée quand le réglage n'est pas défini (le main crée `~/Atelier/Projets`). */
export const DEFAULT_PROJECTS_ROOT = '~/Atelier/Projets';

export function NewProjectDialog({
  onCreated,
  onCancel,
}: {
  onCreated: (project: Project) => void;
  onCancel: () => void;
}) {
  const { state } = useApp();
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'create' | 'existing'>('create');
  const [existing, setExisting] = useState<string | undefined>();
  const [extra, setExtra] = useState<ProjectFolder[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const root = state.settings.projectsDir ?? DEFAULT_PROJECTS_ROOT;
  const choose = async (title: string): Promise<string | null> =>
    call('dialog:choose-directory', { title });

  const addFolder = async (): Promise<void> => {
    const dir = await choose('Dossier à rattacher au projet');
    if (dir === null) return;
    setExtra((list) => [...list, { path: dir, label: defaultFolderLabel(dir), access: 'write' }]);
  };

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const issue = validateProjectInput({ name, description });
    if (issue) {
      setError(issue.message);
      return;
    }
    if (mode === 'existing' && existing === undefined) {
      setError('Choisissez le dossier principal du projet.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const primary: ProjectFolder[] =
        mode === 'existing' && existing !== undefined
          ? [{ path: existing, label: defaultFolderLabel(existing), access: 'write' }]
          : [];
      let project = await call('project:create', {
        project: {
          name,
          ...(description.trim() !== '' ? { description } : {}),
          ...(primary.length > 0 ? { folders: [...primary, ...extra] } : {}),
        },
      });
      // Dossier créé par l'app : les dossiers rattachés s'ajoutent ensuite.
      if (primary.length === 0 && extra.length > 0) {
        project = await call('project:update', {
          id: project.id,
          patch: { folders: [...project.folders, ...extra] },
        });
      }
      onCreated(project);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border bg-background p-6 shadow-lg"
      >
        <form onSubmit={(e) => void submit(e)} className="space-y-5" noValidate>
          <h2 id={titleId} className="text-lg font-semibold">
            Nouveau projet
          </h2>
          <p className="text-sm text-muted-foreground">
            Un projet regroupe vos conversations, vos tâches planifiées, vos pages publiées et une
            mémoire commune, sur un ou plusieurs dossiers.
          </p>
          <div className="space-y-2">
            <Label htmlFor={nameId}>Nom</Label>
            <Input
              id={nameId}
              ref={nameInput}
              value={name}
              placeholder="Ventes 2026"
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={descriptionId}>Description (facultative)</Label>
            <Input
              id={descriptionId}
              value={description}
              placeholder="Suivi mensuel des ventes et rapport hebdo"
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Dossier principal</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="primary"
                checked={mode === 'create'}
                onChange={() => {
                  setMode('create');
                }}
                className="mt-1"
              />
              <span>
                Créer un dossier pour ce projet
                <Hint>
                  {root}/{projectDirName(name || 'Projet')}
                </Hint>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="primary"
                checked={mode === 'existing'}
                onChange={() => {
                  setMode('existing');
                }}
                className="mt-1"
              />
              <span className="min-w-0 flex-1 space-y-1">
                Utiliser un dossier existant
                {mode === 'existing' ? (
                  <span className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void choose('Dossier principal du projet').then((dir) => {
                          if (dir !== null) setExisting(dir);
                        });
                      }}
                    >
                      <FolderOpen className="size-4" aria-hidden />
                      {existing ? 'Changer…' : 'Choisir…'}
                    </Button>
                    <span className="truncate text-muted-foreground" title={existing}>
                      {existing ?? 'Aucun dossier choisi'}
                    </span>
                  </span>
                ) : null}
              </span>
            </label>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Autres dossiers (facultatif)</legend>
            {extra.length > 0 ? (
              <ul className="space-y-2" aria-label="Dossiers rattachés">
                {extra.map((folder, index) => (
                  <li key={folder.path} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate" title={folder.path}>
                      {folder.label}
                    </span>
                    <Select
                      aria-label={`Accès au dossier ${folder.label}`}
                      value={folder.access}
                      onChange={(e) => {
                        const access = e.target.value === 'read' ? 'read' : 'write';
                        setExtra((list) =>
                          list.map((f, i) => (i === index ? { ...f, access } : f)),
                        );
                      }}
                      className="h-8 w-44 text-xs"
                    >
                      <option value="write">Lecture et écriture</option>
                      <option value="read">Lecture seule</option>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Retirer le dossier ${folder.label}`}
                      onClick={() => {
                        setExtra((list) => list.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void addFolder()}>
              <FolderPlus className="size-4" aria-hidden />
              Ajouter un dossier
            </Button>
            <Hint>
              L’assistant peut lire et, selon l’accès choisi, écrire dans ces dossiers. Vous pourrez
              en ajouter plus tard.
            </Hint>
          </fieldset>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Annuler
            </Button>
            <Button type="submit" disabled={saving}>
              Créer le projet
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
