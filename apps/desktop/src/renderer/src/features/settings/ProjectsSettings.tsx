/** Dossier où l'app crée les dossiers des nouveaux projets (ADR-003 D2). */
import { Folder } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Hint } from '@renderer/components/ui/primitives';
import { call } from '@renderer/lib/api';
import { useApp } from '@renderer/state/app-state';
import { DEFAULT_PROJECTS_ROOT } from '../projects/NewProjectDialog';
import { FeedbackLine, SettingsSection, useAction } from './common';

export function ProjectsSettings() {
  const { state, actions } = useApp();
  const change = useAction();
  const dir = state.settings.projectsDir;

  return (
    <SettingsSection
      title="Projets"
      description="Dossier où Atelier crée le dossier d’un nouveau projet (livrables, artefacts)."
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm" title={dir}>
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-xs">{dir ?? DEFAULT_PROJECTS_ROOT}</span>
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={change.busy}
          onClick={() =>
            void change.run(async () => {
              const chosen = await call('dialog:choose-directory', {
                title: 'Choisir le dossier des projets',
                ...(dir ? { defaultPath: dir } : {}),
              });
              if (chosen !== null) await actions.updateSettings({ projectsDir: chosen });
            })
          }
        >
          Changer…
        </Button>
        {dir ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={change.busy}
            onClick={() =>
              void change.run(async () => {
                await actions.updateSettings({ projectsDir: '' });
              })
            }
          >
            Dossier par défaut
          </Button>
        ) : null}
      </div>
      <Hint>
        Évitez un dossier synchronisé avec un service en ligne (iCloud « Bureau et Documents »…) :
        vos livrables et vos artefacts y seraient copiés.
      </Hint>
      <FeedbackLine feedback={change.feedback} />
    </SettingsSection>
  );
}
