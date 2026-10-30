/**
 * Menu « … » (motif ARIA menu button) : ouverture au clic ou au clavier, flèches
 * pour se déplacer, Échap ou clic extérieur pour fermer, focus rendu au bouton.
 */
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  /** Action irréversible : en rouge, séparée des autres par un trait. */
  destructive?: boolean;
  icon?: LucideIcon;
}

export function ActionMenu({
  label,
  items,
  className,
}: {
  /** Nom accessible du bouton, ex. « Actions pour « Récap » ». */
  label: string;
  items: readonly ActionMenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);

  const itemsOf = (): HTMLButtonElement[] =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    itemsOf()[0]?.focus();
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (menu.current?.contains(target) || trigger.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = (focusTrigger: boolean): void => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const list = itemsOf();
    const index = list.findIndex((el) => el === document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list.at(-1)?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className={cn('relative', className)}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open ? (
        <ul
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-7 z-20 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((item, index) => {
            const Icon = item.icon;
            const separated = item.destructive === true && index > 0;
            return (
              <Fragment key={item.label}>
                {separated ? <li role="separator" className="-mx-1 my-1 h-px bg-border" /> : null}
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      close(false);
                      item.onSelect();
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                      item.destructive ? 'text-destructive' : undefined,
                    )}
                  >
                    {Icon ? (
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          item.destructive ? undefined : 'text-muted-foreground',
                        )}
                        aria-hidden
                      />
                    ) : null}
                    {item.label}
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
