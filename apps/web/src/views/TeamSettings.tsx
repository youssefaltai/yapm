import { createIssueStore } from "../actions.js";
import { confirmDialog, Select as Dropdown, promptDialog } from "../controls.js";
import { mutate, type StateType, type Team, toast, type WorkflowState } from "../data.js";
import { Breadcrumbs, button, PageHeader } from "../layout.js";
import { paths } from "../router.js";
import { StatusIcon } from "../ui.js";
import { SettingsLayout, SettingsPanel, SettingsRow } from "./SettingsLayout.js";

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
        className={`absolute top-0.5 size-4 rounded-full transition-all ${checked ? "left-4.5 bg-on-accent" : "left-0.5 bg-muted"}`}
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
      <PageHeader>
        <Breadcrumbs trail={[{ label: team.name, to: paths.team(team.key) }]}>Settings</Breadcrumbs>
      </PageHeader>
      <SettingsLayout
        sections={[
          {
            id: "statuses",
            title: "Statuses",
            description: "The steps an issue moves through. Agents can change them too.",
            children: <Statuses team={team} />,
          },
          {
            id: "triage",
            title: "Triage",
            description: "Review what agents file before it reaches the backlog.",
            children: (
              <SettingsPanel>
                <SettingsRow
                  label="Triage new issues from agents"
                  hint="Issues agents create wait in Triage until you accept or decline them."
                >
                  <Toggle
                    label="Triage"
                    checked={team.triageEnabled}
                    onChange={(v) => void save(team, { triageEnabled: v })}
                  />
                </SettingsRow>
              </SettingsPanel>
            ),
          },
          {
            id: "templates",
            title: "Templates",
            description:
              "Starting points for new issues. A recurring issue is a template on a schedule.",
            actions: <TemplateActions team={team} />,
            children: <Templates team={team} />,
          },
          {
            id: "slas",
            title: "SLAs",
            description:
              "How long an issue of each priority may stay open. When one runs over, its assignee is woken and you're notified.",
            children: (
              <SettingsPanel>
                {PRIORITY_SLAS.map((p) => (
                  <SettingsRow key={p.value} label={p.label} hint={p.hint}>
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
                  </SettingsRow>
                ))}
              </SettingsPanel>
            ),
          },
          {
            id: "archive",
            title: "Archive",
            children: (
              <SettingsPanel>
                <SettingsRow
                  label="Auto-archive"
                  hint="Done and canceled issues leave the lists after a while."
                >
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
                </SettingsRow>
              </SettingsPanel>
            ),
          },
          {
            id: "cycles",
            title: "Cycles",
            description:
              "Time-boxed stretches of work. Unfinished issues roll into the next cycle.",
            children: (
              <SettingsPanel>
                <SettingsRow label="Use cycles" hint="Plan the team's work in cycles.">
                  <Toggle
                    label="Cycles"
                    checked={team.cyclesEnabled}
                    onChange={(v) => void save(team, { cyclesEnabled: v })}
                  />
                </SettingsRow>
                {team.cyclesEnabled && (
                  <>
                    <SettingsRow label="Length" hint="How long each cycle runs.">
                      <Select
                        label="Cycle length"
                        value={team.cycleDuration}
                        options={range(1, 8, (n) => (n === 1 ? "1 week" : `${n} weeks`))}
                        onChange={(v) => void save(team, { cycleDuration: v })}
                      />
                    </SettingsRow>
                    <SettingsRow
                      label="Starts on"
                      hint="Cycles begin at midnight in the company's time zone."
                    >
                      <Select
                        label="Start day"
                        value={team.cycleStartDay}
                        options={DAYS.map((d, i) => ({ value: i, label: d }))}
                        onChange={(v) => void save(team, { cycleStartDay: v })}
                      />
                    </SettingsRow>
                    <SettingsRow label="Cooldown" hint="Rest between cycles.">
                      <Select
                        label="Cooldown"
                        value={team.cycleCooldownTime}
                        options={range(0, 4, (n) =>
                          n === 0 ? "None" : n === 1 ? "1 week" : `${n} weeks`,
                        )}
                        onChange={(v) => void save(team, { cycleCooldown: v })}
                      />
                    </SettingsRow>
                    <SettingsRow
                      label="Upcoming cycles"
                      hint="How many future cycles to keep ready."
                    >
                      <Select
                        label="Upcoming cycles"
                        value={team.upcomingCycleCount}
                        options={range(1, 10, String)}
                        onChange={(v) => void save(team, { upcomingCycleCount: v })}
                      />
                    </SettingsRow>
                  </>
                )}
              </SettingsPanel>
            ),
          },
        ]}
      />
    </div>
  );
}

const templateButton = button("ghost", "sm");

function TemplateActions({ team }: { team: Team }) {
  return (
    <>
      <button
        type="button"
        onClick={() => createIssueStore.set({ teamId: team.id, template: { recurring: false } })}
        className={templateButton}
      >
        New template
      </button>
      <button
        type="button"
        onClick={() => createIssueStore.set({ teamId: team.id, template: { recurring: true } })}
        className={templateButton}
      >
        New recurring issue
      </button>
    </>
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
  if (team.templates.length === 0)
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-3 text-muted">
        None yet. Try a daily brief, a weekly review, or rent on the 1st. Agents set them up too.
      </p>
    );
  return (
    <SettingsPanel>
      {team.templates.map((t) => (
        <div key={t.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
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
          <button
            type="button"
            onClick={() => void remove(t.id, t.name)}
            className={templateButton}
          >
            Delete
          </button>
        </div>
      ))}
    </SettingsPanel>
  );
}

const STATE_TYPES: { type: StateType; label: string }[] = [
  { type: "triage", label: "Triage" },
  { type: "backlog", label: "Backlog" },
  { type: "unstarted", label: "Unstarted" },
  { type: "started", label: "Started" },
  { type: "completed", label: "Completed" },
  { type: "canceled", label: "Canceled" },
];

function Statuses({ team }: { team: Team }) {
  const add = async (type: StateType, label: string) => {
    const name = await promptDialog({
      title: `New ${label.toLowerCase()} status`,
      label: "Status name",
      confirmLabel: "Add",
    });
    if (!name) return;
    await mutate(
      "mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }",
      { input: { teamId: team.id, name, type } },
    );
  };
  const rename = async (state: WorkflowState) => {
    const name = await promptDialog({
      title: `Rename ${state.name}`,
      label: "Status name",
      initial: state.name,
    });
    if (!name || name === state.name) return;
    await mutate(
      "mutation($id: String!, $input: WorkflowStateUpdateInput!) { workflowStateUpdate(id: $id, input: $input) { success } }",
      { id: state.id, input: { name } },
    );
  };
  const remove = async (state: WorkflowState) => {
    if (
      !(await confirmDialog({
        title: `Remove the status “${state.name}”?`,
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    await mutate("mutation($id: String!) { workflowStateArchive(id: $id) { success } }", {
      id: state.id,
    });
  };
  return (
    <SettingsPanel>
      {STATE_TYPES.map(({ type, label }) => (
        <div key={type}>
          <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[12px] text-faint">
            {label}
            <button
              type="button"
              aria-label={`Add ${type} status`}
              onClick={() => void add(type, label)}
              className={templateButton}
            >
              Add
            </button>
          </div>
          {team.states.nodes
            .filter((s) => s.type === type)
            .map((state) => (
              <div key={state.id} className="flex min-h-11 items-center gap-3 px-4 py-1.5">
                <StatusIcon type={state.type} color={state.color} />
                <span className="min-w-0 flex-1 truncate">{state.name}</span>
                <button
                  type="button"
                  aria-label={`Rename ${state.name}`}
                  onClick={() => void rename(state)}
                  className={templateButton}
                >
                  Rename
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${state.name}`}
                  onClick={() => void remove(state)}
                  className={templateButton}
                >
                  Remove
                </button>
              </div>
            ))}
        </div>
      ))}
    </SettingsPanel>
  );
}
