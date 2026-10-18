import type { ReactNode } from "react";
import { type Team, teamAncestors } from "./data.js";
import { navigate, paths } from "./router.js";
import { SelectedPill } from "./states.js";

// The pieces every page is built from, so pages line up and read the same way: one header bar,
// one breadcrumb, one set of tabs, one content width per kind of page, one section heading and
// one set of buttons and fields.

// Buttons and fields ----------------------------------------------------------

type ButtonVariant = "primary" | "destructive" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent font-medium text-on-accent hover:bg-accent-hover",
  destructive: "border-transparent bg-critical/15 font-medium text-critical hover:bg-critical/25",
  secondary: "border-line text-ink hover:bg-raised",
  ghost: "border-transparent text-muted hover:bg-raised hover:text-ink",
  danger: "border-line text-critical hover:bg-raised",
};

/**
 * A button's classes. Every variant has a border, transparent or not, so they're all the same
 * height; `sm` fits the page header and section headings, `md` sits beside a field.
 */
export function button(variant: ButtonVariant = "secondary", size: "sm" | "md" = "md") {
  return `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border whitespace-nowrap disabled:pointer-events-none disabled:opacity-40 ${
    size === "sm" ? "px-2 py-0.5" : "px-3 py-1.5"
  } ${VARIANTS[variant]}`;
}

const fieldBase =
  "min-w-0 rounded-md border border-line bg-panel outline-none placeholder:text-faint focus:border-faint";

/** A text field's classes, the same height as a `md` button beside it. */
export const field = `${fieldBase} px-3 py-1.5`;

/** A field in a dialog, set into the panel so it stands out from it. */
export const dialogField =
  "w-full rounded-md border border-line bg-canvas px-3 py-2 outline-none placeholder:text-faint focus:border-accent";

/** A small field that fits the page header, the height of a `sm` button. */
export const smallField = `${fieldBase} px-2 py-0.5`;

// Page header -----------------------------------------------------------------

/**
 * The bar across the top of every page: where you are on the left (a title or breadcrumbs), the
 * page's tabs, and its actions on the right. One row from sm up; on a phone the title, tabs and
 * actions don't fit one row and tabs got cut off mid-word, so the tabs take a row of their own
 * under the title and actions.
 */
export function PageHeader({
  children,
  tabs,
  actions,
}: {
  children: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="isolate flex shrink-0 flex-wrap items-center gap-x-3 border-b border-line px-4 sm:h-11 sm:flex-nowrap md:px-6">
      <div className="flex h-11 min-w-0 items-center gap-3">{children}</div>
      {tabs && (
        <div className="order-last flex min-w-0 items-center gap-1 max-sm:-mx-4 max-sm:basis-[calc(100%+2rem)] max-sm:px-4 max-sm:pb-2 sm:order-none sm:shrink-0">
          {tabs}
        </div>
      )}
      {actions && <div className="ml-auto flex h-11 shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

/** The current page's name in the header. */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-2 font-medium whitespace-nowrap">
      {children}
    </span>
  );
}

export interface Crumb {
  label: ReactNode;
  to: string;
  /** Leave it out on a phone, where the header is narrow. */
  wide?: boolean;
}

/** Crumbs up through the teams above a sub-team: "Studio › Design". */
export function teamTrail(teams: Team[], team: Team): Crumb[] {
  return teamAncestors(teams, team).map((t) => ({
    label: t.name,
    to: paths.team(t.key),
    wide: true,
  }));
}

/** The way back up, then where you are: "Projects › Pay off the car". */
export function Breadcrumbs({ trail, children }: { trail: Crumb[]; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      {trail.map((crumb) => (
        <span
          key={crumb.to}
          className={`flex shrink-0 items-center gap-1.5 ${crumb.wide ? "max-sm:hidden" : ""}`}
        >
          <button
            type="button"
            onClick={() => navigate(crumb.to)}
            className="flex items-center gap-1.5 text-muted hover:text-ink"
          >
            {crumb.label}
          </button>
          <span aria-hidden className="text-faint">
            ›
          </span>
        </span>
      ))}
      <span className="flex min-w-0 items-center gap-2 font-medium">{children}</span>
    </span>
  );
}

/** A small tag beside the title, like "Archived". */
export function TitleTag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-raised px-1.5 text-[12px] font-normal text-muted">
      {children}
    </span>
  );
}

// Tabs ------------------------------------------------------------------------

/** The classes for a tab, whether it's a link or a button. */
export function tabClass(active: boolean) {
  return `relative shrink-0 rounded-md border border-transparent px-2 py-0.5 font-normal whitespace-nowrap ${
    active ? "text-ink" : "text-muted hover:text-ink"
  }`;
}

/** The highlight under the selected tab, gliding between the tabs in `group`. */
export function TabPill({ group }: { group: string }) {
  return <SelectedPill group={group} className="rounded-md border border-line bg-raised" />;
}

/** A row of tabs, in the header or over a section. */
export function TabRow({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="isolate flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {children}
    </nav>
  );
}

/** A tab that's a link, like Linear's view tabs; the selection glides between tabs in `group`. */
export function TabLink({
  active,
  to,
  group,
  children,
}: {
  active: boolean;
  to: string;
  group: string;
  children: ReactNode;
}) {
  return (
    <a
      href={to}
      aria-current={active ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      className={tabClass(active)}
    >
      {active && <TabPill group={group} />}
      {children}
    </a>
  );
}

/** Tabs that switch something on the page, like the period on Insights. */
export function Tabs<T extends string | number>({
  label,
  group,
  options,
  value,
  onChange,
}: {
  label: string;
  group: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="isolate flex shrink-0 items-center gap-0.5" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={tabClass(value === o.id)}
        >
          {value === o.id && <TabPill group={group} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Lists -----------------------------------------------------------------------

/** A row in a full-width list: projects, documents, runs, approvals, cycles. */
export const listItem =
  "flex w-full animate-fade-in items-center gap-3 border-b border-line px-4 py-2.5 text-left md:px-6";

/** A list row that opens something. */
export const listRow = `${listItem} hover:bg-raised`;

/** The heading over a group of rows, like "In Progress 3"; it sticks while its rows scroll. */
export function GroupHeader({
  icon,
  label,
  count,
  actions,
}: {
  icon?: ReactNode;
  label: ReactNode;
  count?: number;
  actions?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-line bg-raised/95 px-4 backdrop-blur md:px-6">
      {icon}
      <h2 className="font-medium">{label}</h2>
      {count != null && <span className="text-faint">{count}</span>}
      {actions && <div className="ml-auto flex items-center">{actions}</div>}
    </div>
  );
}

// Page body -------------------------------------------------------------------

const WIDTHS = {
  /** Reading and writing: the handbook, initiatives, machines. */
  narrow: "max-w-3xl",
  /** Dashboards and overviews: the company, insights, usage. */
  wide: "max-w-5xl",
};

/** A page's scrolling content, centred at the width that suits it. */
export function PageBody({
  width = "narrow",
  children,
}: {
  width?: keyof typeof WIDTHS;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto w-full ${WIDTHS[width]} px-4 pt-6 pb-16 md:px-6`}>{children}</div>
    </div>
  );
}

/** A full-height page: the header, then whatever scrolls under it. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}

// Sections --------------------------------------------------------------------

/**
 * A titled part of a page, like "Sub-issues" or "Agents": the heading with an optional count and
 * actions on its right, an optional line on what it's for, then its content. Sections space
 * themselves out from the one before.
 */
export function Section({
  title,
  count,
  description,
  actions,
  children,
  id,
  className = "",
}: {
  title: ReactNode;
  count?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`not-first:mt-8 ${className}`}>
      <div className="mb-2 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={id} className="font-medium">
          {title}
        </h2>
        {count != null && <span className="text-faint">{count}</span>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {description && <p className="-mt-1 mb-3 text-muted">{description}</p>}
      {children}
    </section>
  );
}

/** The big title at the top of a page's content: an issue, a project, a person. */
export const pageHeading = "text-2xl font-semibold";

/** A small label over a group, like "Teams" in the sidebar or "How it runs" in a properties list. */
export const eyebrow = "text-[11px] font-medium text-faint uppercase";
