import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Label, StateType } from "./data.js";
import { eyebrow } from "./layout.js";

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

/** Whether the key belongs to what has focus: text being typed, or a button Enter presses. */
function isTyping(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (["Enter", " "].includes(event.key) && target.matches("button, a[href], [role=button]"))
    return true;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** `mod` combos that work while typing or in a menu, like opening the command menu. */
const GLOBAL = new Set(["mod+k"]);

/**
 * Linear-style single-key shortcuts. Keys are like "c", "mod+k", "shift+?".
 * They're ignored while typing or with a menu or modal open, except the `GLOBAL` ones.
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
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const shift = event.shiftKey && /^[a-z]$/i.test(event.key) ? "shift+" : "";
      const combo = `${mod ? "mod+" : ""}${event.altKey ? "alt+" : ""}${shift}${key}`;
      if (!GLOBAL.has(combo) && (isTyping(event) || menuStore.get() || modalOpen())) return;
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

/** A stored colour, or the theme's grey when it has no hue, so greys follow light and dark. */
export function tint(color: string | null | undefined, grey: string) {
  const [r = 0, g = 0, b = 0] = (color?.match(/[0-9a-f]{2}/gi) ?? []).map((c) => parseInt(c, 16));
  return color && Math.max(r, g, b) - Math.min(r, g, b) > 12 ? color : grey;
}

/** Greys for states without a colour of their own: the shape still tells them apart. */
const STATUS_TONE: Record<StateType, string> = {
  triage: "var(--color-muted)",
  backlog: "var(--color-faint)",
  unstarted: "var(--color-muted)",
  started: "var(--color-ink)",
  completed: "var(--color-muted)",
  canceled: "var(--color-faint)",
};

export function StatusIcon({
  type,
  color: stored,
  size = 14,
}: {
  type: StateType;
  color?: string;
  size?: number;
}) {
  const color = tint(stored, STATUS_TONE[type]);
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
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--color-urgent)" />
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
          <rect key={x} x={x} y="6.25" width="2" height="1.5" rx="0.5" fill="var(--color-faint)" />
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
          fill={i < filled ? "var(--color-muted)" : "var(--color-line)"}
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
  // Each agent keeps one of Linear's hues, picked by name; the owner stays grey.
  const hue = `var(--color-hue-${1 + ([...name].reduce((sum, c) => sum + (c.codePointAt(0) ?? 0), 0) % 7)})`;
  return (
    <span
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        ...(kind === "agent" && {
          color: hue,
          background: `color-mix(in srgb, ${hue} 20%, transparent)`,
        }),
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium ${
        kind === "agent" ? "" : "bg-raised text-ink ring-1 ring-line"
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

export function ProjectDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-[3px]"
      style={{ width: size, height: size, background: tint(color, "var(--color-muted)") }}
      aria-hidden
    />
  );
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex max-w-40 items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: tint(label.color, "var(--color-muted)") }}
      />
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

// Motion --------------------------------------------------------------------

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keeps the last value around for `ms` after it goes away, so it can play an exit animation.
 * A new value replaces a leaving one at once.
 */
export function usePresence<T>(value: T | null, ms = 140): { shown: T | null; leaving: boolean } {
  const [shown, setShown] = useState(value);
  if (value !== null && value !== shown) setShown(value);
  useEffect(() => {
    if (value !== null || shown === null) return;
    const timer = setTimeout(() => setShown(null), reducedMotion() ? 0 : ms);
    return () => clearTimeout(timer);
  }, [value, shown, ms]);
  return { shown, leaving: value === null && shown !== null };
}

// Modals --------------------------------------------------------------------

/**
 * Modals, dialogs and popovers stack as layers: Escape closes only the top one,
 * and single-key shortcuts pause while any is open.
 */
const layers: { escape: () => void }[] = [];
const modalOpen = () => layers.length > 0;

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || menuStore.get()) return;
    const top = layers[layers.length - 1];
    if (!top) return;
    event.preventDefault();
    top.escape();
  });
}

export function useLayer(onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const layer = { escape: () => ref.current() };
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
    };
  }, []);
}

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
  useLayer(onClose);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center px-3 pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 animate-fade-in cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative w-full ${wide ? "max-w-2xl" : "max-w-lg"} animate-dialog-in rounded-xl border border-line bg-panel shadow-2xl`}
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
  // The frame stays put while drilling into a submenu, so only the contents change.
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[14vh]">
      <button
        type="button"
        aria-label="Close menu"
        className="absolute inset-0 animate-fade-in cursor-default bg-black/40"
        onClick={closeMenu}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={spec.placeholder}
        className="relative w-full max-w-xl animate-dialog-in overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
      >
        <CommandMenu key={stack.length} spec={spec} depth={stack.length} />
      </div>
    </div>
  );
}

export function matches(item: MenuItem, query: string) {
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
    } else if (/^\d$/.test(event.key) && !query && visible.some((i) => i.hint === event.key)) {
      // Number hints pick directly, like the status menu's 1–7.
      event.preventDefault();
      void choose(visible.find((i) => i.hint === event.key));
    }
  }

  let lastSection: string | undefined;
  return (
    <div className="animate-fade-in">
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
                    className={`flex size-3.5 items-center justify-center rounded-sm border text-[10px] transition-colors ${
                      item.checked ? "border-accent bg-accent text-on-accent" : "border-faint"
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
      ? "border-critical/40 text-critical"
      : hours < 24
        ? "border-warning/40 text-warning"
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

/**
 * Linear's detail page: the content on the left, a properties sidebar on the right. On a phone
 * the sidebar sits between the heading and the content, so the facts come before the long read.
 */
export function DetailLayout({
  head,
  side,
  children,
}: {
  head: ReactNode;
  side: ReactNode;
  children: ReactNode;
}) {
  return (
    // Sized by its pane, not the window, so it fits beside the Inbox list too.
    <div className="@container h-full">
      <div className="mx-auto grid max-w-6xl grid-cols-1 @4xl:min-h-full @4xl:grid-cols-[minmax(0,1fr)_18rem] @4xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 px-4 pt-6 @xl:px-10">{head}</div>
        <aside className="mx-4 mt-6 border-y border-line py-3 @xl:mx-10 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1 @4xl:m-0 @4xl:border-y-0 @4xl:border-l @4xl:px-5 @4xl:py-6">
          {side}
        </aside>
        <div className="min-w-0 px-4 pt-8 pb-16 @xl:px-10">{children}</div>
      </div>
    </div>
  );
}

/**
 * A group of properties in a properties sidebar, with an optional heading. Each label sits above
 * its value, so the value gets the sidebar's whole width; where the sidebar runs across the page,
 * above the content, they sit side by side.
 */
export function PropertyList({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="not-first:mt-4 not-first:border-t not-first:border-line not-first:pt-4">
      {title && <h2 className={`mb-2 px-2 ${eyebrow}`}>{title}</h2>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 @xl:grid-cols-3 @4xl:grid-cols-1">
        {children}
      </dl>
    </section>
  );
}

/**
 * One property: a quiet label over its value. Plain values get a property button's padding so
 * they line up with the controls; a `control` value brings its own.
 */
export function Property({
  label,
  control,
  children,
}: {
  label: string;
  control?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="px-2 text-[12px] text-faint">{label}</dt>
      <dd
        className={`flex min-h-7 min-w-0 items-center gap-2 text-muted ${control ? "" : "px-2 py-1"}`}
      >
        {children}
      </dd>
    </div>
  );
}

/** The class for a clickable value in a properties sidebar, matching the issue page's. */
export const propertyButton =
  "flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ink hover:bg-raised disabled:hover:bg-transparent";
