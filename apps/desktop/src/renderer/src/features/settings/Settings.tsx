/** Écran des Réglages : navigation par rubrique, une rubrique affichée à la fois. */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Box, ChartColumn, Globe, Plug, Server, Sparkles } from 'lucide-react';
import { ServerStatusBadge } from '@renderer/components/status/ServerStatusBadge';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { headerInset, SidebarOpenButton, useShellChrome } from '../sidebar/shell-chrome';
import { useApp } from '@renderer/state/app-state';
import { McpSettings, SkillsSettings } from './ExtensionsSettings';
import { SandboxSettings } from './SandboxSettings';
import { SearchSettings } from './SearchSettings';
import { ServerSettings } from './ServerSettings';
import { UsageSettings } from './UsageSettings';

const SECTIONS = [
  { id: 'server', label: 'Serveur et modèle', icon: Server },
  { id: 'usage', label: 'Utilisation', icon: ChartColumn },
  { id: 'sandbox', label: 'Machine isolée', icon: Box },
  { id: 'search', label: 'Recherche web', icon: Globe },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'Connecteurs', icon: Plug },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function Settings({ onClose }: { onClose: () => void }) {
  const { state } = useApp();
  const { sidebarOpen } = useShellChrome();
  const [section, setSection] = useState<SectionId>('server');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement)) onClose();
      }}
    >
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b pr-4 [-webkit-app-region:drag]',
          headerInset(sidebarOpen),
        )}
      >
        <div className="flex flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          <SidebarOpenButton />
          <Button variant="ghost" size="icon" aria-label="Fermer les réglages" onClick={onClose}>
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <h1 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
            Réglages
          </h1>
        </div>
        <ServerStatusBadge status={state.server} className="[-webkit-app-region:no-drag]" />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Rubriques des réglages" className="w-56 shrink-0 border-r bg-muted/20 p-3">
          <ul className="space-y-1">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setSection(s.id);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-brand-soft font-medium'
                        : 'text-muted-foreground hover:bg-accent/60',
                    )}
                  >
                    <Icon
                      className={cn('size-4 shrink-0', active ? 'text-brand-text' : undefined)}
                      aria-hidden
                    />
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-6">
            {section === 'server' ? <ServerSettings /> : null}
            {section === 'usage' ? <UsageSettings /> : null}
            {section === 'sandbox' ? <SandboxSettings /> : null}
            {section === 'search' ? <SearchSettings /> : null}
            {section === 'skills' ? <SkillsSettings /> : null}
            {section === 'mcp' ? <McpSettings /> : null}
          </div>
        </main>
      </div>
    </div>
  );
}
