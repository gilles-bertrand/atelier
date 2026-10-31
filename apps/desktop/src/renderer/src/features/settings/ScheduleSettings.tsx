/** Réglages › Tâches planifiées : ouvrir Atelier à la connexion (ADR-002 D1). */
import { useId } from 'react';
import { Hint, Switch } from '@renderer/components/ui/primitives';
import { useApp } from '@renderer/state/app-state';
import { FeedbackLine, SettingsSection, useAction } from './common';

export function ScheduleSettings() {
  const { state, actions } = useApp();
  const id = useId();
  const save = useAction();
  return (
    <SettingsSection
      title="Tâches planifiées"
      description="Les tâches s’exécutent tant qu’Atelier est ouvert, même fenêtre fermée. Une tâche manquée (Mac éteint ou en veille) s’exécute une fois au retour."
    >
      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="space-y-0.5">
          <label htmlFor={id} className="text-sm font-medium">
            Ouvrir Atelier à la connexion
          </label>
          <Hint id={`${id}-hint`}>Fenêtre masquée : l’app attend vos tâches sans s’afficher.</Hint>
        </div>
        <Switch
          id={id}
          aria-describedby={`${id}-hint`}
          checked={state.settings.openAtLogin === true}
          onCheckedChange={(openAtLogin) =>
            void save.run(() => actions.updateSettings({ openAtLogin }))
          }
        />
      </div>
      <FeedbackLine feedback={save.feedback} />
    </SettingsSection>
  );
}
