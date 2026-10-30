/**
 * Icône de chaque outil de l'assistant (blocs du fil de conversation). Une seule
 * table : la forme de l'icône dit la famille de l'outil, la couleur reste
 * réservée au statut (en cours, terminé, refusé, échec).
 */
import {
  FileCheck,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  FolderTree,
  Globe,
  ListChecks,
  Plug,
  ScanEye,
  Search,
  Sparkles,
  SquareTerminal,
  TextSearch,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { skillName } from './tool-labels';

export const TOOL_ICONS = {
  read_file: FileText,
  skill: Sparkles,
  write_file: FilePlus,
  edit_file: FilePen,
  list_dir: FolderTree,
  glob: FolderSearch,
  grep: TextSearch,
  bash: SquareTerminal,
  web_search: Search,
  web_fetch: Globe,
  todo_write: ListChecks,
  look_at: ScanEye,
  present_file: FileCheck,
  connector: Plug,
  other: Wrench,
} as const satisfies Record<string, LucideIcon>;

export type ToolIconName = keyof typeof TOOL_ICONS;

function isToolIconName(name: string): name is ToolIconName {
  return Object.hasOwn(TOOL_ICONS, name);
}

/** Nom de l'icône d'un appel d'outil ; à lire dans {@link TOOL_ICONS}. */
export function toolIconName(toolName: string, input: unknown): ToolIconName {
  if (toolName === 'read_file' && skillName(input) !== undefined) return 'skill';
  if (toolName === 'tool_search' || toolName.startsWith('mcp__')) return 'connector';
  if (toolName === 'skill' || toolName === 'connector' || toolName === 'other') return 'other';
  return isToolIconName(toolName) ? toolName : 'other';
}
