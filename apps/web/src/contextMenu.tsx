import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createStore, type MenuItem, type MenuSpec, matches, useLayer, useStore } from "./ui.js";

// Linear-style right-click menus: a compact list at the pointer whose entries either act at
// once or open a submenu beside them. Submenus take the same `MenuSpec` as the command menu,
// so the status, assignee and label pickers behave the same from either place.

export interface ContextItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** The shortcut that does the same, like "S" or "⇧P". Pressing it in the menu picks the entry. */
  hint?: string;
  /** Destructive, like Delete: shown in red. */
  danger?: boolean;
  /** Opens a submenu beside the entry, built when it opens. */
  submenu?: () => MenuSpec | undefined | Promise<MenuSpec | undefined>;
  onSelect?: () => unknown;
}

/** An entry, a divider, or nothing (so builders can write `cond && {...}`). */
export type ContextEntry = ContextItem | "divider" | false | null | undefined;

interface OpenMenu {
  x: number;
  y: number;
  entries: (ContextItem | "divider")[];
  /** Where focus goes back to when the menu closes. */
  restore: Element | null;
}

const contextStore = createStore<OpenMenu | null>(null);

const closeContextMenu = () => contextStore.set(null);

/** Drops empty entries, and dividers that would sit at an edge or next to another. */
function tidy(entries: ContextEntry[]): (ContextItem | "divider")[] {
  const out: (ContextItem | "divider")[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "divider" && (!out.length || out[out.length - 1] === "divider")) continue;
    out.push(entry);
  }
  if (out[out.length - 1] === "divider") out.pop();
  return out;
}

/**
 * Opens a context menu for a `contextmenu` event. Text fields and selected text keep the
 * browser's own menu, so copy and paste still work there.
 */
export function openContextMenu(event: MouseEvent, entries: ContextEntry[]) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input:not([type="checkbox"]), textarea, [contenteditable="true"]')) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) {
    return;
  }
  const items = tidy(entries);
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();
  let { clientX: x, clientY: y } = event;
  // From the keyboard (the menu key, Shift+F10) there's no pointer: open under the element.
  if (x === 0 && y === 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    x = rect.left + 12;
    y = rect.bottom;
  }
  contextStore.set({ x, y, entries: items, restore: document.activeElement });
}

/** An `onContextMenu` handler that builds its entries when the menu opens. */
export function contextMenu(build: () => ContextEntry[]) {
  return (event: MouseEvent) => openContextMenu(event, build());
}

/**
 * iOS Safari never sends `contextmenu`, so a long press sends one, like a native app. Where the
 * browser sends its own (Android), whichever comes first wins and the other is dropped.
 */
function useLongPress() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | null = null;
    let opened = false;
    const cancel = () => {
      clearTimeout(timer);
      start = null;
    };
    const onTouchStart = (event: TouchEvent) => {
      cancel();
      opened = false;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !(event.target instanceof Element)) return;
      const target = event.target;
      start = { x: touch.clientX, y: touch.clientY };
      timer = setTimeout(() => {
        const { x, y } = start ?? { x: 0, y: 0 };
        start = null;
        const menu = new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        });
        opened = !target.dispatchEvent(menu);
      }, 500);
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
        cancel();
      }
    };
    // The press that opened the menu doesn't also click what's under it.
    const onClick = (event: Event) => {
      if (!opened) return;
      opened = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const onNative = (event: Event) => {
      if (!event.isTrusted) return;
      if (opened) {
        event.preventDefault();
        event.stopPropagation();
      } else cancel();
    };
    const listeners = [
      ["touchstart", onTouchStart],
      ["touchmove", onTouchMove],
      ["touchend", cancel],
      ["touchcancel", cancel],
      ["click", onClick],
      ["contextmenu", onNative],
    ] as const;
    for (const [type, listener] of listeners) {
      window.addEventListener(type, listener as EventListener, { capture: true, passive: false });
    }
    return () => {
      cancel();
      for (const [type, listener] of listeners) {
        window.removeEventListener(type, listener as EventListener, { capture: true });
      }
    };
  }, []);
}

export function ContextMenuHost() {
  useLongPress();
  const menu = useStore(contextStore);
  return menu ? <ContextMenu key={`${menu.x},${menu.y}`} menu={menu} /> : null;
}

/** Matches a key press to a hint like "S" or "⇧P". */
function hintOf(event: KeyboardEvent) {
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return null;
  return `${event.shiftKey ? "⇧" : ""}${event.key.toUpperCase()}`;
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0 text-faint">
      <path d="M4 2.5 6.5 5 4 7.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

const PANEL =
  "fixed animate-pop-in rounded-lg border border-line bg-panel text-[13px] shadow-2xl outline-none";
const ROW = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left whitespace-nowrap";

function ContextMenu({ menu }: { menu: OpenMenu }) {
  const ref = useRef<HTMLDivElement>(null);
  const entries = menu.entries;
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const withIcons = entries.some((e) => e !== "divider" && e.icon);
  useLayer(closeContextMenu);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const { width, height } = panel.getBoundingClientRect();
    // Like a native menu: open toward the room there is, growing from the pointer.
    const flipX = menu.x + width > window.innerWidth - 8;
    const flipY = menu.y + height > window.innerHeight - 8;
    panel.style.left = `${Math.max(8, flipX ? menu.x - width : menu.x)}px`;
    panel.style.top = `${Math.max(8, flipY ? menu.y - height : menu.y)}px`;
    panel.style.transformOrigin = `${flipX ? "right" : "left"} ${flipY ? "bottom" : "top"}`;
    panel.style.visibility = "visible";
    panel.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      // Hand focus back, so keyboard users stay where they were.
      if (menu.restore instanceof HTMLElement && menu.restore.isConnected) {
        menu.restore.focus({ preventScroll: true });
      }
    };
  }, [menu]);

  const itemAt = (index: number) => {
    const entry = entries[index];
    return entry && entry !== "divider" ? entry : undefined;
  };

  function pick(index: number, viaKeyboard: boolean) {
    const item = itemAt(index);
    if (!item) return;
    clearTimeout(timer.current);
    setActive(index);
    if (item.submenu) {
      setSub({ index, focus: viaKeyboard });
      return;
    }
    closeContextMenu();
    void item.onSelect?.();
  }

  // Hovering opens a submenu after a beat; a longer one when another is open, so the pointer
  // can cross other entries on its way into it.
  function hover(index: number) {
    setActive(index);
    clearTimeout(timer.current);
    const item = itemAt(index);
    if (sub?.index === index) return;
    timer.current = setTimeout(
      () => setSub(item?.submenu ? { index, focus: false } : null),
      sub ? 160 : 60,
    );
  }

  function step(from: number, delta: number) {
    for (let i = 1; i <= entries.length; i++) {
      const index = (from + delta * i + entries.length * 2) % entries.length;
      if (itemAt(index)) return index;
    }
    return from;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.target !== ref.current) return;
    if (event.key === "ArrowDown") setActive((i) => step(i < 0 ? -1 : i, 1));
    else if (event.key === "ArrowUp") setActive((i) => step(i < 0 ? 0 : i, -1));
    else if (event.key === "Home") setActive(step(-1, 1));
    else if (event.key === "End") setActive(step(0, -1));
    else if (event.key === "ArrowRight" && itemAt(active)?.submenu) pick(active, true);
    else if (event.key === "Enter" || event.key === " ") pick(active, true);
    else if (event.key === "Tab") setActive((i) => step(i, event.shiftKey ? -1 : 1));
    else {
      const hint = hintOf(event);
      const index = hint ? entries.findIndex((e) => e !== "divider" && e.hint === hint) : -1;
      if (index < 0) return;
      pick(index, true);
    }
    event.preventDefault();
  }

  const anchor = sub
    ? (ref.current?.querySelector<HTMLElement>(`[data-index="${sub.index}"]`) ?? null)
    : null;
  const subItem = sub ? itemAt(sub.index) : undefined;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: only keeps the browser's menu away
    <div
      className="fixed inset-0 z-[60]"
      onContextMenu={(e) => {
        e.preventDefault();
        closeContextMenu();
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close menu"
        className="absolute inset-0 cursor-default"
        onMouseDown={(e) => e.preventDefault()}
        onClick={closeContextMenu}
      />
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          if (!sub) setActive(-1);
        }}
        style={{ visibility: "hidden", left: menu.x, top: menu.y }}
        className={`${PANEL} max-h-[calc(100vh-16px)] min-w-52 overflow-y-auto p-1`}
      >
        {entries.map((entry, index) =>
          entry === "divider" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: dividers have no identity
            <hr key={`divider-${index}`} className="mx-1 my-1 h-px border-0 bg-line" />
          ) : (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-index={index}
              aria-haspopup={entry.submenu ? "menu" : undefined}
              aria-expanded={entry.submenu ? sub?.index === index : undefined}
              onMouseEnter={() => hover(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(index, false)}
              className={`${ROW} transition-none ${
                index === active || sub?.index === index
                  ? entry.danger
                    ? "bg-critical/10 text-critical"
                    : "bg-raised text-ink"
                  : entry.danger
                    ? "text-critical/90"
                    : "text-muted"
              }`}
            >
              {withIcons && (
                <span aria-hidden className="flex w-4 shrink-0 justify-center">
                  {entry.icon}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate pr-4">{entry.label}</span>
              {entry.hint && <span className="text-[12px] text-faint">{entry.hint}</span>}
              {entry.submenu && <Chevron />}
            </button>
          ),
        )}
      </div>
      {sub && subItem?.submenu && anchor && (
        <SubMenu
          key={sub.index}
          anchor={anchor}
          load={subItem.submenu}
          focus={sub.focus}
          onEnter={() => {
            clearTimeout(timer.current);
            setActive(sub.index);
          }}
          onBack={() => {
            setSub(null);
            ref.current?.focus({ preventScroll: true });
          }}
          onEmpty={() => setSub(null)}
        />
      )}
    </div>,
    document.body,
  );
}

function SubMenu({
  anchor,
  load,
  focus,
  onEnter,
  onBack,
  onEmpty,
}: {
  anchor: HTMLElement;
  load: NonNullable<ContextItem["submenu"]>;
  focus: boolean;
  onEnter: () => void;
  onBack: () => void;
  onEmpty: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState<MenuSpec | null>(null);
  const [grabFocus, setGrabFocus] = useState(focus);

  // biome-ignore lint/correctness/useExhaustiveDependencies: built once, when it opens
  useEffect(() => {
    let alive = true;
    void Promise.resolve(load()).then((next) => {
      if (!alive) return;
      if (next) setSpec(next);
      else onEmpty();
    });
    return () => {
      alive = false;
    };
  }, []);

  // Beside the entry, on whichever side has room; kept on screen as its height changes.
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const a = anchor.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const fitsRight = a.right + 4 + width <= window.innerWidth - 8;
    const left = fitsRight ? a.right + 4 : Math.max(8, a.left - width - 4);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(8, Math.min(a.top - 5, window.innerHeight - height - 8))}px`;
    panel.style.transformOrigin = fitsRight ? "left top" : "right top";
    panel.style.visibility = "visible";
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only hands it keyboard focus
    <div
      ref={ref}
      style={{ visibility: "hidden" }}
      onMouseEnter={() => {
        onEnter();
        setGrabFocus(true);
      }}
      className={`${PANEL} flex max-h-[min(360px,70vh)] w-64 flex-col overflow-hidden`}
    >
      {spec ? (
        <MenuList
          key={spec.placeholder}
          spec={spec}
          focus={grabFocus}
          onDrill={setSpec}
          onBack={onBack}
        />
      ) : (
        <p className="px-3 py-2.5 text-faint">Loading…</p>
      )}
    </div>
  );
}

/** Lists past which a submenu offers a filter box, like Linear's pickers. */
const FILTER_AT = 7;

function MenuList({
  spec,
  focus,
  onDrill,
  onBack,
}: {
  spec: MenuSpec;
  focus: boolean;
  onDrill: (next: MenuSpec) => void;
  onBack: () => void;
}) {
  const filterable = !!spec.search || spec.items.length >= FILTER_AT;
  const [items, setItems] = useState(spec.items);
  const [query, setQuery] = useState("");
  const [extra, setExtra] = useState<MenuItem[]>([]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      spec.items.findIndex((i) => i.checked && !spec.multi),
    ),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) (inputRef.current ?? listRef.current)?.focus({ preventScroll: true });
  }, [focus]);

  useEffect(() => {
    if (!spec.search || !query.trim()) return setExtra([]);
    let alive = true;
    const timer = setTimeout(() => {
      spec.search?.(query.trim()).then((results) => alive && setExtra(results));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, spec]);

  const visible = useMemo(
    () => [...(query ? items.filter((item) => matches(item, query)) : items), ...extra],
    [items, extra, query],
  );

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  async function choose(item: MenuItem | undefined) {
    if (!item) return;
    const next = await item.onSelect();
    if (next) onDrill(next);
    else if (spec.multi && spec.refresh) setItems(spec.refresh());
    else closeContextMenu();
  }

  function onKeyDown(event: KeyboardEvent) {
    const last = visible.length - 1;
    if (event.key === "ArrowDown") setActive((i) => Math.min(i + 1, last));
    else if (event.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (event.key === "Home" && !filterable) setActive(0);
    else if (event.key === "End" && !filterable) setActive(last);
    else if (event.key === "Enter" || (event.key === " " && !filterable))
      void choose(visible[active]);
    else if (event.key === "ArrowLeft" && !query) onBack();
    else if (/^\d$/.test(event.key) && !query && visible.some((i) => i.hint === event.key))
      // Number hints pick directly, like the status menu's 1–7.
      void choose(visible.find((i) => i.hint === event.key));
    else if (event.key === "Tab") {
      // Stays in the menu.
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  let lastSection: string | undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: routes keys from the filter and the list
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      {filterable && (
        <input
          ref={inputRef}
          aria-label={spec.placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder={spec.placeholder}
          className="w-full border-b border-line bg-transparent px-3 py-2 outline-none placeholder:text-faint"
        />
      )}
      <div
        ref={listRef}
        role="menu"
        aria-label={spec.placeholder}
        tabIndex={-1}
        className="min-h-0 overflow-y-auto p-1 outline-none"
      >
        {visible.length === 0 && (
          <p className="px-2.5 py-3 text-center text-faint">
            {spec.search && !query ? "Type to search" : "No results"}
          </p>
        )}
        {visible.map((item, index) => {
          const header = item.section && item.section !== lastSection ? item.section : null;
          lastSection = item.section;
          return (
            <div key={`${item.section ?? ""}:${item.id}`}>
              {header && (
                <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">{header}</p>
              )}
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemcheckbox when it's checkable */}
              <button
                type="button"
                role={spec.multi ? "menuitemcheckbox" : "menuitem"}
                aria-checked={spec.multi ? !!item.checked : undefined}
                tabIndex={-1}
                data-index={index}
                onMouseMove={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void choose(item)}
                className={`${ROW} transition-none ${index === active ? "bg-raised text-ink" : "text-muted"}`}
              >
                {spec.multi && (
                  <span
                    aria-hidden
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] transition-colors ${
                      item.checked ? "border-accent bg-accent text-on-accent" : "border-faint"
                    }`}
                  >
                    {item.checked ? "✓" : ""}
                  </span>
                )}
                {item.icon && (
                  <span aria-hidden className="flex shrink-0">
                    {item.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && (
                  <span className="max-w-24 shrink-0 truncate text-[12px] text-faint">
                    {item.hint}
                  </span>
                )}
                {!spec.multi && (
                  <span aria-hidden className={`text-accent ${item.checked ? "" : "invisible"}`}>
                    ✓
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
