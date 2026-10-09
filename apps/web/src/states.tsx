import { type ReactNode, useLayoutEffect, useRef } from "react";

// Empty, loading and selected states, shared so every view moves and reads the same way.

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Selected pill -------------------------------------------------------------

const pills = new Map<string, { rect: DOMRect; at: number }>();

/**
 * The highlight behind the selected tab or nav item. Render it inside the selected item (which
 * needs `relative`, under an `isolate` container that the pill can glide across); when the selection moves within a `group`, the pill glides from the
 * old item to the new one, even if the whole row re-rendered or remounted in between.
 */
export function SelectedPill({ group, className }: { group: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const last = pills.get(group);
    if (last && performance.now() - last.at < 1000 && rect.width && !reducedMotion()) {
      const from = last.rect;
      const dx = from.left - rect.left;
      const dy = from.top - rect.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(from.width - rect.width) > 0.5) {
        el.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px)`,
              width: `${from.width}px`,
              height: `${from.height}px`,
            },
            { transform: "none", width: `${rect.width}px`, height: `${rect.height}px` },
          ],
          { duration: 260, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
      }
    }
    // Remember where it was, mid-glide included, for whichever item is selected next.
    return () => {
      const at = el.getBoundingClientRect();
      if (at.width) pills.set(group, { rect: at, at: performance.now() });
    };
  }, [group]);
  return (
    <span
      ref={ref}
      aria-hidden
      className={`pointer-events-none absolute inset-0 -z-10 ${className ?? "rounded-md bg-raised"}`}
    />
  );
}

// Loading -------------------------------------------------------------------

/** A shimmering placeholder bar. */
export function Bone({ className = "" }: { className?: string }) {
  return <span className={`skeleton block rounded ${className}`} />;
}

const WIDTHS = ["w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5", "w-1/2", "w-2/3", "w-1/3"];

/**
 * Rows standing in for a list while it loads. It waits a beat before showing, so a fast load goes
 * straight to the content without a flash of placeholders.
 */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden className="animate-skeleton-in">
      {WIDTHS.slice(0, rows).map((width, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          key={i}
          className="flex h-10 items-center gap-3 border-b border-line/60 px-4 md:px-6"
          style={{ opacity: 1 - i * 0.1 }}
        >
          <Bone className="size-3.5" />
          <Bone className="h-2.5 w-12 max-sm:hidden" />
          <Bone className="size-3.5 rounded-full" />
          <span className="min-w-0 flex-1">
            <Bone className={`h-2.5 ${width}`} />
          </span>
          <Bone className="h-2.5 w-10 max-sm:hidden" />
          <Bone className="size-4.5 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** A page's outline while it loads: a header, a title and a few paragraphs. */
export function PageSkeleton() {
  return (
    <div aria-hidden className="flex h-full animate-skeleton-in flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <Bone className="h-2.5 w-16" />
        <Bone className="h-2.5 w-28" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-8 md:px-6">
        <Bone className="mb-6 h-5 w-1/2" />
        <Bone className="h-2.5 w-full" />
        <Bone className="h-2.5 w-11/12" />
        <Bone className="h-2.5 w-4/5" />
        <Bone className="mt-6! h-2.5 w-full" />
        <Bone className="h-2.5 w-2/3" />
      </div>
    </div>
  );
}

// Empty states --------------------------------------------------------------

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const emptyIcons = {
  inbox: (
    <Glyph>
      <path d="M4 13.5 6.2 6.3A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.3L20 13.5" />
      <path d="M4 13.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5h-4.5l-1 2h-5l-1-2z" />
    </Glyph>
  ),
  issues: (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <path d="m8.8 12.2 2.2 2.2 4.2-4.6" />
    </Glyph>
  ),
  filter: (
    <Glyph>
      <path d="M4.5 6h15M7.5 12h9M10.5 18h3" />
    </Glyph>
  ),
  project: (
    <Glyph>
      <path d="M12 3.5 19.5 7.7v8.6L12 20.5l-7.5-4.2V7.7z" />
      <path d="M4.8 7.9 12 12l7.2-4.1M12 12v8.3" />
    </Glyph>
  ),
  roadmap: (
    <Glyph>
      <path d="M4 5.5v13M4 7.5h8M7 12h10M10 16.5h8" />
    </Glyph>
  ),
  initiative: (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </Glyph>
  ),
  document: (
    <Glyph>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z" />
      <path d="M14 3.5V8h4M9 12.5h6M9 16h4" />
    </Glyph>
  ),
  run: (
    <Glyph>
      <path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z" />
    </Glyph>
  ),
  machine: (
    <Glyph>
      <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
      <path d="M2.5 19h19M10 9l-2 1.5L10 12M13 12h2.5" />
    </Glyph>
  ),
  approval: (
    <Glyph>
      <path d="M12 3.5 19 6v5.5c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </Glyph>
  ),
  key: (
    <Glyph>
      <circle cx="8.5" cy="15.5" r="4" />
      <path d="m11.5 12.5 8-8M16.5 7.5l2 2M14.5 9.5l1.5 1.5" />
    </Glyph>
  ),
  cycle: (
    <Glyph>
      <path d="M19 12a7 7 0 0 1-12.2 4.7M5 12a7 7 0 0 1 12.2-4.7" />
      <path d="M17.5 3.8v3.7h-3.7M6.5 20.2v-3.7h3.7" />
    </Glyph>
  ),
  team: (
    <Glyph>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 6.3a3 3 0 0 1 0 5.4M17.5 14.2a5.5 5.5 0 0 1 3 4.8" />
    </Glyph>
  ),
  search: (
    <Glyph>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </Glyph>
  ),
  select: (
    <Glyph>
      <path d="m6 4 12.5 6.5-5.5 1.5-2 5.5z" />
      <path d="m13 12 5 5" />
    </Glyph>
  ),
  compass: (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <path d="m14.8 9.2-1.6 4-4 1.6 1.6-4z" />
    </Glyph>
  ),
  chart: (
    <Glyph>
      <path d="M4.5 19.5h15M7 16v-4M11 16V8M15 16v-6M19 16V5" />
    </Glyph>
  ),
} satisfies Record<string, ReactNode>;

export type EmptyIcon = keyof typeof emptyIcons;

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /** A keyboard shortcut shown beside the label. */
  shortcut?: string;
}

/**
 * Linear-style empty state: a small stacked-card illustration, a title, one line on what goes
 * here and the action that fills it. `compact` fits inside a panel or a section of a page.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondary,
  compact,
  fill = true,
  className = "",
}: {
  icon: EmptyIcon;
  title: string;
  description?: ReactNode;
  action?: EmptyAction;
  secondary?: EmptyAction;
  compact?: boolean;
  /** Centre in the full height of the scroll area; off where other content shares it. */
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "px-4 py-8" : `flex-1 px-6 py-16 ${fill ? "min-h-full" : ""}`
      } ${className}`}
    >
      {compact ? (
        <span className="empty-card mb-3 flex size-10 animate-pop-in items-center justify-center text-muted">
          {emptyIcons[icon]}
        </span>
      ) : (
        <div aria-hidden className="group/art relative mb-6 h-[104px] w-[184px]">
          <span className="empty-glow absolute -inset-x-6 -top-4 -bottom-6" />
          {/* A ghost of the list that will fill this space. */}
          <span className="empty-card empty-ghost absolute inset-x-4 top-0 flex h-[76px] animate-rise-in flex-col gap-2.5 px-3.5 pt-3.5">
            {["w-3/4", "w-1/2", "w-2/3"].map((width, i) => (
              <span
                key={width}
                className="flex items-center gap-2 transition-transform duration-300 ease-snappy group-hover/art:translate-x-1"
                style={{ transitionDelay: `${i * 30}ms` }}
              >
                <span className="size-2 shrink-0 rounded-full bg-line" />
                <span className={`h-1.5 rounded-full bg-line ${width}`} />
              </span>
            ))}
          </span>
          <span className="empty-card empty-tile absolute bottom-0 left-1/2 flex size-12 -translate-x-1/2 animate-tile-in items-center justify-center text-ink/80">
            {emptyIcons[icon]}
          </span>
        </div>
      )}
      <h2
        className={`animate-rise-in font-medium text-ink [animation-delay:40ms] ${compact ? "text-[13px]" : "text-[15px]"}`}
      >
        {title}
      </h2>
      {description && (
        <p
          className={`mt-1.5 max-w-sm animate-rise-in leading-relaxed text-muted [animation-delay:80ms] ${compact ? "text-[12px]" : ""}`}
        >
          {description}
        </p>
      )}
      {(action || secondary) && (
        <div className="mt-5 flex animate-rise-in flex-wrap items-center justify-center gap-2 [animation-delay:120ms]">
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent shadow-sm hover:bg-accent-hover"
            >
              {action.label}
              {action.shortcut && (
                <kbd className="rounded border border-on-accent/25 bg-on-accent/15 px-1 font-sans text-[11px] text-on-accent/85">
                  {action.shortcut}
                </kbd>
              )}
            </button>
          )}
          {secondary && (
            <button
              type="button"
              onClick={secondary.onClick}
              className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-muted hover:bg-raised hover:text-ink"
            >
              {secondary.label}
              {secondary.shortcut && (
                <kbd className="rounded border border-line bg-raised px-1 font-sans text-[11px] text-muted">
                  {secondary.shortcut}
                </kbd>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
