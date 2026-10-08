import type { ReactNode } from "react";
import { createIssueStore } from "../actions.js";
import { confirmDialog, Select as Dropdown } from "../controls.js";
import { mutate, type Team, toast } from "../data.js";
import { navigate, paths } from "../router.js";

const PRIORITY_SLAS = [
  { value: 1, label: "Urgent", hint: "Priority 1" },
  { value: 2, label: "High", hint: "Priority 2" },
  { value: 3, label: "Medium", hint: "Priority 3" },
  { value: 4, label: "Low", hint: "Priority 4" },
];

const SLA_OPTIONS = [
  { value: 0, label: "No SLA" },
  { value: 4, label: "4 hours" },
  { value: 24, label: "1 day" },
  { value: 72, label: "3 days" },
  { value: 168, label: "1 week" },
  { value: 336, label: "2 weeks" },
  { value: 720, label: "30 days" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function save(team: Team, input: Record<string, unknown>) {
  const ok = await mutate(
    "mutation($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success } }",
    { id: team.id, input },
  );
  if (ok) toast("Team settings saved");
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line py-3">
      <div className="min-w-0 flex-1">
        <p>{label}</p>
        <p className="text-[12px] text-faint">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-line"}`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${checked ? "left-4.5" : "left-0.5"}`}
      />
    </button>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: { value: number; label: string }[];
  onChange: (value: number) => void;
}) {
  return (
    <Dropdown
      aria-label={label}
      value={value}
      options={options}
      onChange={onChange}
      className="min-w-32 rounded-md border border-line bg-panel px-2 py-1 outline-none hover:bg-raised focus-visible:border-accent"
    />
  );
}

const range = (from: number, to: number, label: (n: number) => string) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ value: from + i, label: label(from + i) }));

export function TeamSettings({ team }: { team: Team }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <button
          type="button"
          onClick={() => navigate(paths.team(team.key))}
          className="text-muted hover:text-ink"
        >
          {team.name} ›
        </button>
        <span className="font-medium">Settings</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto max-w-2xl py-6">
          <h2 className="mb-1 font-medium">Triage</h2>
          <Row
            label="Triage new issues from agents"
            hint="Issues agents create wait in Triage until you accept or decline them."
          >
            <Toggle
              label="Triage"
              checked={team.triageEnabled}
              onChange={(v) => void save(team, { triageEnabled: v })}
            />
          </Row>

          <Templates team={team} />

          <h2 className="mt-8 mb-1 font-medium">SLAs</h2>
          <p className="border-b border-line pb-3 text-[12px] text-faint">
            How long an issue of each priority may stay open. When one runs over, its assignee is
            woken and you're notified.
          </p>
          {PRIORITY_SLAS.map((p) => (
            <Row key={p.value} label={p.label} hint={p.hint}>
              <Select
                label={`${p.label} SLA`}
                value={team.slaHours?.[String(p.value)] ?? 0}
                options={SLA_OPTIONS}
                onChange={(hours) =>
                  void save(team, {
                    slaHours: { ...(team.slaHours ?? {}), [String(p.value)]: hours },
                  })
                }
              />
            </Row>
          ))}

          <h2 className="mt-8 mb-1 font-medium">Archive</h2>
          <Row label="Auto-archive" hint="Done and canceled issues leave the lists after a while.">
            <Select
              label="Auto-archive"
              value={team.autoArchivePeriod}
              options={[
                { value: 0, label: "Never" },
                ...[1, 3, 6, 9, 12].map((n) => ({
                  value: n,
                  label: n === 1 ? "After 1 month" : `After ${n} months`,
                })),
              ]}
              onChange={(v) => void save(team, { autoArchivePeriod: v })}
            />
          </Row>

          <h2 className="mt-8 mb-1 font-medium">Cycles</h2>
          <Row
            label="Use cycles"
            hint="Time-boxed stretches of work. Unfinished issues roll into the next cycle."
          >
            <Toggle
              label="Cycles"
              checked={team.cyclesEnabled}
              onChange={(v) => void save(team, { cyclesEnabled: v })}
            />
          </Row>
          {team.cyclesEnabled && (
            <>
              <Row label="Length" hint="How long each cycle runs.">
                <Select
                  label="Cycle length"
                  value={team.cycleDuration}
                  options={range(1, 8, (n) => (n === 1 ? "1 week" : `${n} weeks`))}
                  onChange={(v) => void save(team, { cycleDuration: v })}
                />
              </Row>
              <Row label="Starts on" hint="Cycles begin at midnight in the company's time zone.">
                <Select
                  label="Start day"
                  value={team.cycleStartDay}
                  options={DAYS.map((d, i) => ({ value: i, label: d }))}
                  onChange={(v) => void save(team, { cycleStartDay: v })}
                />
              </Row>
              <Row label="Cooldown" hint="Rest between cycles.">
                <Select
                  label="Cooldown"
                  value={team.cycleCooldownTime}
                  options={range(0, 4, (n) =>
                    n === 0 ? "None" : n === 1 ? "1 week" : `${n} weeks`,
                  )}
                  onChange={(v) => void save(team, { cycleCooldown: v })}
                />
              </Row>
              <Row label="Upcoming cycles" hint="How many future cycles to keep ready.">
                <Select
                  label="Upcoming cycles"
                  value={team.upcomingCycleCount}
                  options={range(1, 10, String)}
                  onChange={(v) => void save(team, { upcomingCycleCount: v })}
                />
              </Row>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Templates({ team }: { team: Team }) {
  const remove = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: `Delete the template “${name}”?`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    await mutate("mutation($id: String!) { templateDelete(id: $id) { success } }", { id });
  };
  const button = "rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink";
  return (
    <>
      <div className="mt-8 mb-1 flex items-center gap-2">
        <h2 className="font-medium">Templates and recurring issues</h2>
        <button
          type="button"
          onClick={() => createIssueStore.set({ teamId: team.id, template: { recurring: false } })}
          className={`ml-auto ${button}`}
        >
          New template
        </button>
        <button
          type="button"
          onClick={() => createIssueStore.set({ teamId: team.id, template: { recurring: true } })}
          className={button}
        >
          New recurring issue
        </button>
      </div>
      {team.templates.length === 0 && (
        <p className="border-b border-line py-3 text-[12px] text-faint">
          None yet. A recurring issue is a template on a schedule: a daily brief, a weekly review,
          rent on the 1st. Agents set them up too.
        </p>
      )}
      <ul>
        {team.templates.map((t) => (
          <li key={t.id} className="flex items-center gap-3 border-b border-line py-2.5">
            <button
              type="button"
              onClick={() => createIssueStore.set({ teamId: team.id, template: t })}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate">{t.name}</span>
              <span className="block text-[12px] text-faint">
                {t.schedule?.description ?? "Template"}
              </span>
            </button>
            <button type="button" onClick={() => void remove(t.id, t.name)} className={button}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
