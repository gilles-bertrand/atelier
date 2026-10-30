/** Briques communes des Réglages : section, ligne de champ, état d'enregistrement. */
import { useState, type ReactNode } from 'react';
import { Card } from '@renderer/components/ui/primitives';
import { toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-5 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </Card>
  );
}

/** Résultat d'une action : message de réussite ou d'erreur, effacé à la suivante. */
export type Feedback = { tone: 'success' | 'error'; message: string } | undefined;

/**
 * Exécute une action asynchrone avec indicateur d'occupation et retour lisible.
 * `run(task, succès)` ; l'erreur est traduite en français.
 */
export function useAction(): {
  busy: boolean;
  feedback: Feedback;
  run: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const run = async (task: () => Promise<unknown>, success?: string): Promise<boolean> => {
    setBusy(true);
    setFeedback(undefined);
    try {
      await task();
      if (success) setFeedback({ tone: 'success', message: success });
      return true;
    } catch (e) {
      setFeedback({ tone: 'error', message: errorMessage(toSerializedError(e)) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    feedback,
    run,
    clear: () => {
      setFeedback(undefined);
    },
  };
}

/** Message de retour sous un formulaire (annoncé). */
export function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.tone === 'error' ? 'alert' : 'status'}
      className={
        feedback.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-success-text'
      }
    >
      {feedback.message}
    </p>
  );
}
