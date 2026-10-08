import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Label, StateType } from "./data.js";

/** A minimal external store, for app-wide UI like the command menu and modals. */
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type Store<T> = ReturnType<typeof createStore<T>>;

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Linear-style single-key shortcuts. Keys are like "c", "mod+k", "shift+?".
 * Plain keys are ignored while typing; `mod` combos work everywhere.
 */
export function useHotkeys(
  bindings: Record<string, (event: KeyboardEvent) => void>,
  enabled = true,
) {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      // The editor already handled it, like Cmd+B for bold or Cmd+K for a link.
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod && (isTyping(event.target) || menuStore.get() || modalOpen())) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const shift = event.shiftKey && /^[a-z]$/i.test(event.key) ? "shift+" : "";
      const combo = `${mod ? "mod+" : ""}${event.altKey ? "alt+" : ""}${shift}${key}`;
      const handler = ref.current[combo];
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export function StatusIcon({
  type,
  color,
  size = 14,
}: {
  type: StateType;
  color: string;
  size?: number;
}) {
  const r = 6;
  const common = { width: size, height: size, viewBox: "0 0 14 14", className: "shrink-0" };
  switch (type) {
    case "triage":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />
          <path d="M4.5 7h5M7 4.5v5" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case "backlog":
      return (
        <svg {...common} aria-hidden>
          <circle
            cx="7"
            cy="7"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray="2 2"
          />
        </svg>
      );
    case "unstarted":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case "started":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={color} />
        </svg>
      );
    case "completed":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="7" fill={color} />
          <path
            d="M4.2 7.2l1.9 1.9 3.7-3.9"
            fill="none"
            stroke="var(--color-canvas)"
            strokeWidth="1.5"
          />
        </svg>
      );
    case "canceled":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="7" fill={color} />
          <path
            d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4"
            stroke="var(--color-canvas)"
            strokeWidth="1.5"
          />
        </svg>
      );
  }
}

export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", className: "shrink-0" };
  if (priority === 1) {
    return (
      <svg {...common} aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#f2994a" />
        <path
          d="M7 3.5v4.2M7 9.6v.9"
          stroke="var(--color-canvas)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (priority === 0) {
    return (
      <svg {...common} aria-hidden>
        {[2, 6, 10].map((x) => (
          <rect key={x} x={x} y="6.25" width="2" height="1.5" rx="0.5" fill="#5c6068" />
        ))}
      </svg>
    );
  }
  const filled = 5 - priority; // high 3, medium 2, low 1
  return (
    <svg {...common} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4}
          y={9 - i * 3}
          width="3"
          height={3 + i * 3}
          rx="0.75"
          fill={i < filled ? "#8a8f98" : "#3a3d44"}
        />
      ))}
    </svg>
  );
}

export function Avatar({
  name,
  kind,
  size = 18,
}: {
  name: string;
  kind?: "owner" | "agent";
  size?: number;
}) {
  return (
    <span
      title={name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium ${
        kind === "agent" ? "bg-accent/25 text-accent" : "bg-raised text-ink ring-1 ring-line"
      }`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function UnassignedIcon({ size = 18 }: { size?: number }) {
  return (
    <span
      title="Unassigned"
      style={{ width: size, height: size }}
      className="inline-block shrink-0 rounded-full border border-dashed border-faint"
    />
  );
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex max-w-40 items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">
      <span className="size-2 shrink-0 rounded-full" style={{ background: label.color }} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-raised px-1.5 py-px font-sans text-[11px] text-muted">
      {children}
    </kbd>
  );
}

// Modals --------------------------------------------------------------------

let openModals = 0;
const modalOpen = () => openModals > 0;

export function Modal({
  onClose,
  children,
  label,
  wide,
}: {
  onClose: () => void;
  children: ReactNode;
  label: string;
  wide?: boolean;
}) {
  useEffect(() => {
    openModals++;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !menuStore.get()) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      openModals--;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-3 pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-xl border border-line bg-panel shadow-2xl`}
      >
        {children}
      </div>
    </div>
  );
}

// Command menu --------------------------------------------------------------

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: ReactNode;
  section?: string;
  /** Shown with a check mark, for the current value or selected labels. */
  checked?: boolean;
  /** Extra words to match when filtering. */
  keywords?: string;
  /** Return another menu to drill into it; return nothing to close. */
  onSelect: () => MenuSpec | undefined | void | Promise<void> | Promise<MenuSpec | undefined>;
}

export interface MenuSpec {
  placeholder: string;
  items: MenuItem[];
  /** Extra results for the typed text, e.g. issue search. */
  search?: (query: string) => Promise<MenuItem[]>;
  /** Multi-select menus (labels) stay open on select and rebuild their items. */
  multi?: boolean;
  refresh?: () => MenuItem[];
}

export const menuStore = createStore<MenuSpec[] | null>(null);

export function openMenu(spec: MenuSpec) {
  menuStore.set([spec]);
}

export function closeMenu() {
  menuStore.set(null);
}

export function MenuHost() {
  const stack = useStore(menuStore);
  if (!stack?.length) return null;
  const spec = stack[stack.length - 1];
  if (!spec) return null;
  return <CommandMenu key={stack.length} spec={spec} depth={stack.length} />;
}

function matches(item: MenuItem, query: string) {
  const text = `${item.label} ${item.keywords ?? ""} ${item.section ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

function CommandMenu({ spec, depth }: { spec: MenuSpec; depth: number }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [items, setItems] = useState(spec.items);
  const [extra, setExtra] = useState<MenuItem[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: typing resets the highlight
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  async function choose(item: MenuItem | undefined) {
    if (!item) return;
    const next = await item.onSelect();
    if (next) {
      menuStore.set([...(menuStore.get() ?? []), next]);
    } else if (spec.multi && spec.refresh) {
      setItems(spec.refresh());
    } else if (menuStore.get()) {
      closeMenu();
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void choose(visible[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const stack = menuStore.get() ?? [];
      menuStore.set(stack.length > 1 ? stack.slice(0, -1) : null);
    } else if (event.key === "Backspace" && !query && depth > 1) {
      menuStore.set((menuStore.get() ?? []).slice(0, -1));
    }
  }

  let lastSection: string | undefined;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-3 pt-[14vh]">
      <button
        type="button"
        aria-label="Close menu"
        className="absolute inset-0 cursor-default"
        onClick={closeMenu}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={spec.placeholder}
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
      >
        <input
          // biome-ignore lint/a11y/noAutofocus: a command menu opens to be typed into
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={spec.placeholder}
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-faint"
        />
        <div ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {visible.length === 0 && <p className="px-3 py-6 text-center text-faint">No results</p>}
          {visible.map((item, index) => {
            const header = item.section && item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            return (
              <div key={`${item.section ?? ""}:${item.id}`}>
                {header && (
                  <p className="px-3 pt-2.5 pb-1 text-[11px] font-medium text-faint">{header}</p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  // Keep focus in the search box, so Escape and arrows keep working after a click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void choose(item)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${
                    index === active ? "bg-raised text-ink" : "text-muted"
                  }`}
                >
                  {spec.multi && (
                    <span
                      className={`flex size-3.5 items-center justify-center rounded-sm border text-[10px] ${
                        item.checked ? "border-accent bg-accent text-white" : "border-faint"
                      }`}
                    >
                      {item.checked ? "✓" : ""}
                    </span>
                  )}
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {!spec.multi && item.checked && <span className="text-accent">✓</span>}
                  {item.hint && <span className="shrink-0 text-faint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Dates ---------------------------------------------------------------------

export function shortDate(value: string | number) {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function timeAgo(value: string | number) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return shortDate(value);
}

/** Due dates are calendar dates; parse them as local dates, not UTC midnight. */
export function dueLabel(date: string) {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const text =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days === -1
          ? "Yesterday"
          : shortDate(due.getTime());
  return { text, overdue: days < 0 };
}

/** "SLA 5h" while an open issue's SLA runs, red once it's breached; nothing otherwise. */
export function SlaBadge({ breachesAt, open }: { breachesAt: string | null; open: boolean }) {
  if (!breachesAt || !open) return null;
  const left = Date.parse(breachesAt) - Date.now();
  const hours = Math.round(left / 3_600_000);
  const text =
    left <= 0
      ? "SLA breached"
      : hours < 48
        ? `SLA ${Math.max(hours, 1)}h`
        : `SLA ${Math.round(hours / 24)}d`;
  const tone =
    left <= 0
      ? "border-red-500/40 text-red-400"
      : hours < 24
        ? "border-amber-500/40 text-amber-400"
        : "border-line text-muted";
  return (
    <span
      title={`Due by ${new Date(breachesAt).toLocaleString()}`}
      className={`shrink-0 rounded border px-1 text-[11px] ${tone}`}
    >
      {text}
    </span>
  );
}
