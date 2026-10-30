/**
 * Activité des conversations pour la colonne de gauche : l'assistant travaille,
 * ou attend votre accord. Pur et testable, dérivé du magasin des conversations.
 */
import { isRunning, type ChatState } from '@renderer/state/chat-reducer';

export type SessionActivity = 'running' | 'waiting';

export const ACTIVITY_LABELS: Record<SessionActivity, string> = {
  running: 'L’assistant travaille',
  waiting: 'En attente de votre accord',
};

/** Une demande d'accord prime sur le travail en cours : c'est elle qui attend l'utilisateur. */
export function sessionActivity(state: ChatState): ReadonlyMap<string, SessionActivity> {
  const activity = new Map<string, SessionActivity>();
  for (const [sessionId, view] of Object.entries(state)) {
    if (view.permissions.length > 0) activity.set(sessionId, 'waiting');
    else if (isRunning(view)) activity.set(sessionId, 'running');
  }
  return activity;
}
