import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createStore, Modal, useLayer, useStore } from "./ui.js";

// Linear-style replacements for the browser's own alert, confirm, prompt,
// <select>, date and time pickers, and title tooltips.

// Popover -------------------------------------------------------------------

/**
 * A floating panel anchored to a trigger. A clear backdrop catches outside
 * clicks so they close only the popover, like a native menu.
 */
export function Popover({
  anchor,
  onClose,
  children,
  label,
  align = "start",
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  label: string;
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  useLayer(onClose);

  useLayoutEffect(() => {
    const place = () => {
      const panel = ref.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const { width, height } = panel.getBoundingClientRect();
      const gap = 4;
      const below = window.innerHeight - a.bottom - gap;
      const top = below >= height || a.top < height ? a.bottom + gap : a.top - gap - height;
      const left = align === "end" ? a.right - width : a.left;
      setStyle({
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        minWidth: Math.min(a.width, window.innerWidth - 16),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, align]);

  // Hand focus back to the trigger, so keyboard users stay where they were.
  useEffect(() => () => anchor?.focus({ preventScroll: true }), [anchor]);

  return createPortal(
    // Clicks inside stay inside: React would otherwise bubble them to the trigger's ancestors.
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops propagation
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys must still reach the Escape handler
    <div
      className="fixed inset-0 z-[60]"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        style={style}
        className="popover fixed max-h-[min(360px,70vh)] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-line bg-panel text-[13px] shadow-2xl"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0 text-faint">
      <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

// Select --------------------------------------------------------------------

export interface SelectOption<T> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Extra words to match when filtering. */
  keywords?: string;
}

/** Long lists get a filter box, like Linear's pickers. */
const FILTER_AT = 9;

/**
 * A dropdown in place of `<select>`. The trigger is a button, so a wrapping
 * `<label>` still names it and opens it.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
  placeholder = "Select…",
  ...rest
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={ref}
        type="button"
        {...rest}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex items-center gap-2 text-left ${className}`}
      >
        {current?.icon && (
          <span aria-hidden className="flex shrink-0">
            {current.icon}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate ${current ? "" : "text-faint"}`}>
          {current?.label ?? placeholder}
        </span>
        <Chevron />
      </button>
      {open && (
        <Popover
          anchor={ref.current}
          label={rest["aria-label"] ?? placeholder}
          onClose={() => setOpen(false)}
        >
          <OptionList
            options={options}
            value={value}
            onChoose={(next) => {
              setOpen(false);
              if (next !== value) onChange(next);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function OptionList<T extends string | number>({
  options,
  value,
  onChoose,
}: {
  options: SelectOption<T>[];
  value: T;
  onChoose: (value: T) => void;
}) {
  const filterable = options.length >= FILTER_AT;
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return options;
    return options.filter((o) => {
      const text = `${o.label} ${o.keywords ?? ""} ${o.value}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [options, query]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  useEffect(() => {
    if (!filterable) listRef.current?.focus({ preventScroll: true });
  }, [filterable]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(event: KeyboardEvent) {
    const last = visible.length - 1;
    if (event.key === "ArrowDown") setActive((i) => Math.min(i + 1, last));
    else if (event.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(last);
    else if (event.key === "Enter" || (event.key === " " && !filterable)) {
      const option = visible[active];
      if (option) onChoose(option.value);
    } else if (event.key === "Tab") {
      event.preventDefault();
    } else if (!filterable && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      // Type-ahead: jump to the first option starting with what was typed.
      const now = Date.now();
      const text = (now - typed.current.at < 700 ? typed.current.text : "") + event.key;
      typed.current = { text: text.toLowerCase(), at: now };
      const found = visible.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (found >= 0) setActive(found);
      return;
    } else return;
    event.preventDefault();
  }

  return (
    <div className="flex max-h-[inherit] flex-col">
      {filterable && (
        <input
          // biome-ignore lint/a11y/noAutofocus: a long picker opens to be typed into
          autoFocus
          aria-label="Filter"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Filter…"
          className="w-full border-b border-line bg-transparent px-3 py-2 outline-none placeholder:text-faint"
        />
      )}
      <div
        ref={listRef}
        role="listbox"
        tabIndex={-1}
        onKeyDown={filterable ? undefined : onKeyDown}
        className="min-h-0 overflow-y-auto p-1 outline-none"
      >
        {visible.length === 0 && <p className="px-2.5 py-3 text-center text-faint">No results</p>}
        {visible.map((option, index) => (
          <button
            key={String(option.value)}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={option.value === value}
            data-index={index}
            onMouseMove={() => setActive(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(option.value)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left whitespace-nowrap ${
              index === active ? "bg-raised text-ink" : "text-muted"
            }`}
          >
            {option.icon && (
              <span aria-hidden className="flex shrink-0">
                {option.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span
              aria-hidden
              className={`text-accent ${option.value === value ? "" : "invisible"}`}
            >
              ✓
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Dates ---------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
/** Dates are plain `YYYY-MM-DD` strings in local time, as `<input type="date">` gave. */
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Reads what people type into a date picker: "tomorrow", "fri", "in 2 weeks",
 * "next week", "oct 20", "20 oct" or "2026-10-20".
 */
export function parseDate(text: string, today = new Date()): string | null {
  const t = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) {
    const d = fromIso(t);
    return Number.isNaN(d.getTime()) ? null : isoDate(d);
  }
  if (t === "today" || t === "now") return isoDate(base);
  if (t === "tomorrow" || t === "tmr") return isoDate(addDays(base, 1));
  if (t === "yesterday") return isoDate(addDays(base, -1));
  if (t === "next week") return isoDate(addDays(base, (8 - base.getDay()) % 7 || 7));
  if (t === "next month") return isoDate(new Date(base.getFullYear(), base.getMonth() + 1, 1));
  const rel = t.match(/^in (\d+|a|an|one) (day|week|month|year)s?$/);
  if (rel) {
    const n = /^\d+$/.test(rel[1] ?? "") ? Number(rel[1]) : 1;
    const unit = rel[2];
    if (unit === "day") return isoDate(addDays(base, n));
    if (unit === "week") return isoDate(addDays(base, n * 7));
    if (unit === "month")
      return isoDate(new Date(base.getFullYear(), base.getMonth() + n, base.getDate()));
    return isoDate(new Date(base.getFullYear() + n, base.getMonth(), base.getDate()));
  }
  const weekday = WEEKDAYS.findIndex(
    (w) => t.replace(/^next /, "").length >= 3 && w.startsWith(t.replace(/^next /, "")),
  );
  if (weekday >= 0) {
    const ahead = (weekday - base.getDay() + 7) % 7 || 7;
    return isoDate(addDays(base, ahead));
  }
  const monthDay =
    t.match(/^([a-z]{3,}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/) ??
    t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,})(?: (\d{4}))?$/);
  if (monthDay) {
    const [a, b, year] = monthDay.slice(1);
    const [name, day] = /^\d/.test(a ?? "") ? [b, a] : [a, b];
    const month = MONTHS.findIndex((m) => name && m.startsWith(name));
    const n = Number(day);
    if (month < 0 || n < 1 || n > 31) return null;
    let d = new Date(year ? Number(year) : base.getFullYear(), month, n);
    // A bare "jan 5" in December means the coming one.
    if (!year && d < base) d = new Date(base.getFullYear() + 1, month, n);
    return d.getDate() === n ? isoDate(d) : null;
  }
  return null;
}

export function formatDate(value: string) {
  const d = fromIso(value);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** A date field in place of `<input type="date">`: a button that opens a calendar. */
export function DatePicker({
  value,
  onChange,
  placeholder = "Set date",
  className = "",
  clearable = true,
  ...rest
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  className?: string;
  clearable?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        {...rest}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 text-left ${className}`}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className="shrink-0 opacity-70">
          <rect x="1.5" y="2.5" width="11" height="10" rx="2" fill="none" stroke="currentColor" />
          <path d="M1.5 5.5h11M4.5 1v3M9.5 1v3" stroke="currentColor" />
        </svg>
        <span className={`min-w-0 flex-1 truncate ${value ? "" : "text-faint"}`}>
          {value ? formatDate(value) : placeholder}
        </span>
      </button>
      {open && (
        <Popover
          anchor={ref.current}
          label={rest["aria-label"] ?? "Date"}
          onClose={() => setOpen(false)}
        >
          <Calendar
            value={value}
            clearable={clearable}
            onChoose={(next) => {
              setOpen(false);
              if (next !== value) onChange(next);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function Calendar({
  value,
  clearable,
  onChoose,
}: {
  value: string | null;
  clearable: boolean;
  onChoose: (value: string | null) => void;
}) {
  const today = isoDate(new Date());
  const [focus, setFocus] = useState(() => fromIso(value ?? today));
  const [text, setText] = useState("");
  const parsed = parseDate(text);
  const gridRef = useRef<HTMLDivElement>(null);
  const month = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(month, -month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weekdayNames = days
    .slice(0, 7)
    .map((d) => d.toLocaleDateString(undefined, { weekday: "narrow" }));
  const shiftMonth = (n: number) =>
    setFocus((f) => {
      const target = new Date(f.getFullYear(), f.getMonth() + n, 1);
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      return new Date(target.getFullYear(), target.getMonth(), Math.min(f.getDate(), last));
    });

  useEffect(() => {
    if (document.activeElement && gridRef.current?.contains(document.activeElement)) {
      gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    }
  });

  function onGridKey(event: KeyboardEvent) {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const move = moves[event.key];
    if (move) setFocus((f) => addDays(f, move));
    else if (event.key === "PageUp") shiftMonth(-1);
    else if (event.key === "PageDown") shiftMonth(1);
    else return;
    event.preventDefault();
  }

  return (
    <div className="w-[248px] p-2">
      <input
        // biome-ignore lint/a11y/noAutofocus: a date picker opens to type a date
        autoFocus
        aria-label="Type a date"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseDate(e.target.value);
          if (next) setFocus(fromIso(next));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (parsed) onChoose(parsed);
          } else if (e.key === "ArrowDown" && !text) {
            e.preventDefault();
            gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
          }
        }}
        placeholder="Try “tomorrow” or “in 2 weeks”"
        className="mb-2 w-full rounded-md border border-line bg-canvas px-2 py-1.5 outline-none placeholder:text-faint focus:border-faint"
      />
      {text && (
        <p className="-mt-1 mb-2 px-1 text-[12px] text-faint">
          {parsed ? `${formatDate(parsed)} · press Enter` : "Not a date we know"}
        </p>
      )}
      <div className="mb-1 flex items-center px-1">
        <span className="flex-1 font-medium">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => shiftMonth(-1)}
          className="rounded px-1.5 text-muted hover:bg-raised hover:text-ink"
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => shiftMonth(1)}
          className="rounded px-1.5 text-muted hover:bg-raised hover:text-ink"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-faint">
        {weekdayNames.map((name, i) => (
          <span key={WEEKDAYS[i]} className="py-1">
            {name}
          </span>
        ))}
      </div>
      <div ref={gridRef} className="grid grid-cols-7 gap-px">
        {days.map((day) => {
          const iso = isoDate(day);
          const selected = iso === value;
          const focused = iso === isoDate(focus);
          const outside = day.getMonth() !== month.getMonth();
          return (
            <button
              key={iso}
              type="button"
              aria-pressed={selected}
              aria-label={day.toLocaleDateString(undefined, { dateStyle: "full" })}
              tabIndex={focused ? 0 : -1}
              onClick={() => onChoose(iso)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onChoose(iso);
                } else onGridKey(e);
              }}
              className={`h-8 rounded-md text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                selected
                  ? "bg-accent text-white"
                  : `hover:bg-raised ${iso === today ? "font-semibold text-accent" : outside ? "text-faint" : "text-ink"}`
              }`}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1 border-t border-line pt-2">
        <button
          type="button"
          onClick={() => onChoose(today)}
          className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => onChoose(isoDate(addDays(new Date(), 1)))}
          className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
        >
          Tomorrow
        </button>
        {clearable && value && (
          <button
            type="button"
            onClick={() => onChoose(null)}
            className="ml-auto rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// Times ---------------------------------------------------------------------

const timeLabel = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return new Date(2000, 0, 1, h ?? 0, m ?? 0).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
};

/** A time of day (`HH:MM`) in place of `<input type="time">`, in 15 minute steps. */
export function TimeSelect({
  value,
  onChange,
  className,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const options = useMemo(() => {
    const times = Array.from(
      { length: 96 },
      (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`,
    );
    if (value && !times.includes(value)) times.push(value);
    return times.sort().map((t) => ({ value: t, label: timeLabel(t), keywords: t }));
  }, [value]);
  return (
    <Select value={value} options={options} onChange={onChange} className={className} {...rest} />
  );
}

// Confirm and prompt --------------------------------------------------------

type DialogSpec =
  | {
      kind: "confirm";
      title: string;
      body?: ReactNode;
      confirmLabel: string;
      destructive: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      title: string;
      label?: string;
      initial: string;
      placeholder?: string;
      confirmLabel: string;
      resolve: (value: string | null) => void;
    };

const dialogStore = createStore<DialogSpec | null>(null);

function show(spec: DialogSpec) {
  // A dialog that's already open answers "no" before the next one replaces it.
  const open = dialogStore.get();
  if (open?.kind === "confirm") open.resolve(false);
  else if (open?.kind === "prompt") open.resolve(null);
  dialogStore.set(spec);
}

/** Asks before something hard to undo, in place of `window.confirm`. */
export function confirmDialog(options: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) =>
    show({
      kind: "confirm",
      confirmLabel: "Confirm",
      destructive: false,
      ...options,
      resolve,
    }),
  );
}

/** Asks for a short piece of text, in place of `window.prompt`. Resolves null when canceled. */
export function promptDialog(options: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) =>
    show({ kind: "prompt", initial: "", confirmLabel: "Save", ...options, resolve }),
  );
}

export function DialogHost() {
  const spec = useStore(dialogStore);
  if (!spec) return null;
  return <Dialog key={spec.title + spec.kind} spec={spec} />;
}

function Dialog({ spec }: { spec: DialogSpec }) {
  const [text, setText] = useState(spec.kind === "prompt" ? spec.initial : "");
  const finish = (answer: boolean) => {
    if (dialogStore.get() !== spec) return;
    dialogStore.set(null);
    if (spec.kind === "confirm") spec.resolve(answer);
    else spec.resolve(answer && text.trim() ? text.trim() : null);
  };
  const button = "rounded-md px-3 py-1.5";
  return (
    <Modal label={spec.title} onClose={() => finish(false)}>
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <h2 className="text-[15px] font-medium">{spec.title}</h2>
        {spec.kind === "confirm" && spec.body && (
          <div className="mt-2 leading-relaxed text-muted">{spec.body}</div>
        )}
        {spec.kind === "prompt" && (
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to be typed into
            autoFocus
            aria-label={spec.label ?? spec.title}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder={spec.placeholder ?? spec.label}
            className="mt-3 w-full rounded-md border border-line bg-canvas px-3 py-2 outline-none placeholder:text-faint focus:border-faint"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => finish(false)}
            className={`${button} text-muted hover:bg-raised hover:text-ink`}
          >
            Cancel
          </button>
          <button
            type="submit"
            // biome-ignore lint/a11y/noAutofocus: Enter confirms, like the browser's dialog
            autoFocus={spec.kind === "confirm"}
            disabled={spec.kind === "prompt" && !text.trim()}
            className={`${button} font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-40 ${
              spec.kind === "confirm" && spec.destructive
                ? "bg-red-500/90 hover:bg-red-500 focus-visible:ring-red-400"
                : "bg-accent hover:bg-accent-hover focus-visible:ring-accent"
            }`}
          >
            {spec.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Tooltips ------------------------------------------------------------------

/**
 * Shows `title` attributes as Linear-style tooltips instead of the browser's.
 * The title moves to `data-tooltip` on hover so the native one never appears;
 * a button named only by its title keeps that name as its aria-label.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    let warm = 0;
    const hide = () => {
      clearTimeout(timer);
      if (current) warm = Date.now();
      current = null;
      setTip(null);
    };
    const over = (event: Event) => {
      const target =
        event.target instanceof Element ? event.target.closest("[title], [data-tooltip]") : null;
      if (target === current) return;
      hide();
      if (!target) return;
      const title = target.getAttribute("title");
      if (title !== null) {
        target.removeAttribute("title");
        target.setAttribute("data-tooltip", title);
        if (!target.hasAttribute("aria-label") && !target.textContent?.trim()) {
          target.setAttribute("aria-label", title);
        }
      }
      const text = target.getAttribute("data-tooltip");
      if (!text) return;
      current = target;
      // Once one tooltip has shown, the next appears at once, like Linear.
      const delay = Date.now() - warm < 400 ? 0 : 500;
      timer = setTimeout(() => {
        if (current === target && target.isConnected) {
          setTip({ text, rect: target.getBoundingClientRect() });
        }
      }, delay);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return setPos(null);
    const { width, height } = el.getBoundingClientRect();
    const above = tip.rect.top - height - 6;
    const top = above >= 4 ? above : tip.rect.bottom + 6;
    const left = tip.rect.left + tip.rect.width / 2 - width / 2;
    setPos({ top, left: Math.max(4, Math.min(left, window.innerWidth - width - 4)) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={pos ?? { visibility: "hidden", top: 0, left: 0 }}
      className="tooltip pointer-events-none fixed z-[70] max-w-xs rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-ink shadow-lg"
    >
      {tip.text}
    </div>,
    document.body,
  );
}
