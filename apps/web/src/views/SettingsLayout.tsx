import { type ReactNode, useEffect, useRef, useState } from "react";
import { Section, TabPill, tabClass } from "../layout.js";
import { SelectedPill } from "../states.js";

export interface SettingsSection {
  id: string;
  title: string;
  description?: ReactNode;
  /** Buttons on the right of the section's heading, like "New template". */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A settings page like Linear's: sections on the right, each a heading over a panel of rows, and a
 * nav of the sections on the left that follows the scroll. On a phone the nav becomes a row of
 * chips pinned under the header.
 */
export function SettingsLayout({ sections }: { sections: SettingsSection[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(sections[0]?.id);
  const ids = sections.map((s) => s.id).join(" ");

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const order = ids.split(" ");
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 96;
      let current = order[0];
      for (const id of order) {
        const el = document.getElementById(`settings-${id}`);
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      // At the bottom the last section is the one being read, however short it is.
      if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4)
        current = order.at(-1);
      setActive(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [ids]);

  const jump = (id: string) =>
    document
      .getElementById(`settings-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <nav
        aria-label="Sections"
        className="sticky top-0 z-10 isolate flex gap-0.5 overflow-x-auto border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur lg:hidden"
      >
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => jump(s.id)}
            className={tabClass(active === s.id)}
          >
            {active === s.id && <TabPill group="settings-chips" />}
            {s.title}
          </button>
        ))}
      </nav>
      <div className="mx-auto flex max-w-4xl gap-10 px-4 pt-6 pb-16 md:px-6">
        <nav
          aria-label="Sections"
          className="sticky top-6 isolate hidden h-max w-44 shrink-0 space-y-0.5 lg:block"
        >
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jump(s.id)}
              className={`relative block w-full rounded-md px-2 py-1 text-left ${
                active === s.id ? "text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
              }`}
            >
              {active === s.id && <SelectedPill group="settings-nav" />}
              {s.title}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-10">
          {sections.map((s) => (
            <div key={s.id} id={`settings-${s.id}`} className="scroll-mt-16 lg:scroll-mt-6">
              <Section
                id={`settings-${s.id}-title`}
                title={s.title}
                description={s.description}
                actions={s.actions}
              >
                {s.children}
              </Section>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The panel a section's rows sit in. */
export function SettingsPanel({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
      {children}
    </div>
  );
}

/** One setting: what it is and what it does on the left, its control on the right. */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p>{label}</p>
        {hint && <p className="text-[12px] text-faint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
