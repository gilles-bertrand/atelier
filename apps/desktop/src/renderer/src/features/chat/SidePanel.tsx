/**
 * Panneau de suivi de la conversation : tâches en direct, fichiers créés ou
 * modifiés. L'environnement (VM, réseau, serveur) est en pied de colonne gauche.
 */
import { useId, type ReactNode } from 'react';
import { FileText, ListChecks, type LucideIcon } from 'lucide-react';
import type { ChatMessage, FileCard as FileCardData } from '@atelier/shared';
import type { SessionView } from '@renderer/state/chat-reducer';
import { FileCard, TodoList } from './ToolDisplays';

/**
 * Fichiers créés, modifiés ou présentés pendant la conversation (dernier état
 * par chemin, le plus récent en premier).
 */
export function changedFiles(messages: readonly ChatMessage[]): FileCardData[] {
  const byPath = new Map<string, FileCardData>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_call') continue;
      // Carte propre de l'outil (write_file, present_file…) puis fichiers détectés (bash, MCP…).
      const files = [
        ...(part.display?.type === 'file' ? [part.display.file] : []),
        ...(part.files ?? []),
      ];
      for (const file of files) {
        const previous = byPath.get(file.path);
        byPath.delete(file.path);
        // « Créé » reste « Créé » même si le fichier est ensuite retouché.
        byPath.set(
          file.path,
          previous?.action === 'created' && file.action !== 'created'
            ? { ...file, action: 'created' }
            : file,
        );
      }
    }
  }
  return [...byPath.values()].reverse();
}

/**
 * Nombre de passages de chaque fichier dans la conversation (par chemin absolu) :
 * l'aperçu se recharge dès qu'un outil retouche le fichier.
 */
export function fileRevisions(messages: readonly ChatMessage[]): Map<string, number> {
  const revisions = new Map<string, number>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_call') continue;
      const files = [
        ...(part.display?.type === 'file' ? [part.display.file] : []),
        ...(part.files ?? []),
      ];
      for (const file of files) {
        revisions.set(file.absolutePath, (revisions.get(file.absolutePath) ?? 0) + 1);
      }
    }
  }
  return revisions;
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <h2
        id={id}
        className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SidePanel({ id, view }: { id: string; view: SessionView }) {
  const files = changedFiles(view.live ? [...view.messages, view.live] : view.messages);
  return (
    <aside
      id={id}
      aria-label="Suivi de la conversation"
      className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-l bg-muted/20 px-4 py-5"
    >
      <Section title="Tâches" icon={ListChecks}>
        {view.todos.length > 0 ? (
          <div aria-live="polite">
            <TodoList todos={view.todos} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Pour une demande en plusieurs étapes, l’assistant affiche ici son plan.
          </p>
        )}
      </Section>

      <Section title="Fichiers" icon={FileText}>
        {files.length > 0 ? (
          <ul className="space-y-2">
            {files.map((file) => (
              <li key={file.path}>
                <FileCard file={file} compact />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Les fichiers créés ou modifiés apparaîtront ici.
          </p>
        )}
      </Section>
    </aside>
  );
}
