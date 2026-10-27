/** Statut d'une tâche de la liste de progression de l'agent. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Élément de la liste de tâches affichée dans le panneau latéral.
 * L'outil `todo_write` remplace la liste complète à chaque appel.
 */
export interface TodoItem {
  /** Identifiant stable choisi par le modèle (ex. "1", "lire-csv"). */
  id: string;
  /** Intitulé lisible par un non-développeur. */
  title: string;
  /** Avancement de la tâche. */
  status: TodoStatus;
}
