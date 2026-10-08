import { useCallback, useState } from "react";
import {
  type CreateIssueDefaults,
  createIssueStore,
  createTeamStore,
  workspaceStore,
} from "../actions.js";
import { type IssueTemplate, mutate, PRIORITIES, type Schedule, toast } from "../data.js";
import { RichEditor } from "../editor/index.js";
import { navigate, paths } from "../router.js";
import {
  Avatar,
  Kbd,
  LabelChip,
  type MenuItem,
  Modal,
  openMenu,
  PriorityIcon,
  StatusIcon,
  UnassignedIcon,
  useStore,
} from "../ui.js";

let lastTeamId: string | undefined;

export function CreateIssueHost() {
  const defaults = useStore(createIssueStore);
  const close = useCallback(() => createIssueStore.set(null), []);
  if (!defaults) return null;
  return <CreateIssue defaults={defaults} onClose={close} />;
}

function CreateIssue({
  defaults,
  onClose,
}: {
  defaults: CreateIssueDefaults;
  onClose: () => void;
}) {
  const workspace = useStore(workspaceStore);
  const teams = workspace?.teams.nodes ?? [];
  const [teamId, setTeamId] = useState(
    () => defaults.teamId ?? teams.find((t) => t.id === lastTeamId)?.id ?? teams[0]?.id ?? "",
  );
  const team = teams.find((t) => t.id === teamId);
  // Editing a template uses the same form; a schedule makes it a recurring issue.
  const editing = defaults.template && "id" in defaults.template ? defaults.template : null;
  const templateMode = !!defaults.template;
  const data = editing?.templateData ?? {};
  const [name, setName] = useState(editing?.name ?? "");
  const [schedule, setSchedule] = useState<Schedule | null>(
    editing
      ? editing.schedule
      : defaults.template && "recurring" in defaults.template && defaults.template.recurring
        ? { frequency: "weekdays", time: "09:00", weekday: 1, monthDay: 1 }
        : null,
  );
  const [title, setTitle] = useState(data.title ?? "");
  const [description, setDescription] = useState(data.description ?? "");
  const [stateId, setStateId] = useState<string | undefined>(data.stateId ?? defaults.stateId);
  const [priority, setPriority] = useState(data.priority ?? 0);
  const [assigneeId, setAssigneeId] = useState<string | null>(
    data.assigneeId ?? defaults.assigneeId ?? null,
  );
  const [labelIds, setLabelIds] = useState<string[]>(data.labelIds ?? []);
  const [busy, setBusy] = useState(false);

  const applyTemplate = (t: IssueTemplate) => {
    setTitle(
      t.templateData.title?.replaceAll("{date}", new Date().toISOString().slice(0, 10)) ?? "",
    );
    setDescription(t.templateData.description ?? "");
    setPriority(t.templateData.priority ?? 0);
    setAssigneeId(t.templateData.assigneeId ?? null);
    setLabelIds(t.templateData.labelIds ?? []);
    if (t.templateData.stateId) setStateId(t.templateData.stateId);
  };

  if (!team) {
    return (
      <Modal onClose={onClose} label="New issue">
        <div className="p-6 text-center">
          <p className="text-muted">Issues live in teams, and there are none yet.</p>
          <button
            type="button"
            onClick={() => {
              onClose();
              createTeamStore.set(true);
            }}
            className="mt-4 rounded-md bg-accent px-3 py-1.5 text-white"
          >
            Create a team
          </button>
        </div>
      </Modal>
    );
  }

  const states = team.states.nodes;
  const state =
    states.find((s) => s.id === stateId) ??
    states.find((s) => s.type === "backlog") ??
    states.find((s) => s.type === "unstarted") ??
    states[0];
  const assignee = workspace?.users.nodes.find((u) => u.id === assigneeId);
  const labels = team.labels.nodes.filter((l) => labelIds.includes(l.id));

  async function saveTemplate() {
    if (!title.trim() || busy || !team) return;
    setBusy(true);
    const templateData = {
      title,
      description: description || null,
      priority,
      assigneeId,
      labelIds,
      ...(stateId ? { stateId } : {}),
    };
    const scheduleInput = schedule && {
      frequency: schedule.frequency,
      time: schedule.time,
      ...(schedule.frequency === "weekly" ? { weekday: schedule.weekday ?? 1 } : {}),
      ...(schedule.frequency === "monthly" ? { monthDay: schedule.monthDay ?? 1 } : {}),
    };
    const result = editing
      ? await mutate(
          "mutation($id: String!, $input: TemplateUpdateInput!) { templateUpdate(id: $id, input: $input) { success } }",
          {
            id: editing.id,
            input: { name: name || title, templateData, schedule: scheduleInput },
          },
        )
      : await mutate(
          "mutation($input: TemplateCreateInput!) { templateCreate(input: $input) { success } }",
          {
            input: {
              teamId: team.id,
              name: name || title,
              templateData,
              ...(scheduleInput ? { schedule: scheduleInput } : {}),
            },
          },
        );
    setBusy(false);
    if (result) {
      toast(schedule ? "Recurring issue saved" : "Template saved");
      onClose();
    }
  }

  async function submit() {
    if (templateMode) return saveTemplate();
    if (!title.trim() || busy || !team) return;
    setBusy(true);
    const result = await mutate<{ issueCreate: { issue: { identifier: string } } }>(
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier } } }",
      {
        input: {
          teamId: team.id,
          title,
          description: description || null,
          stateId: state?.id,
          priority,
          assigneeId,
          labelIds,
          parentId: defaults.parentId ?? null,
          projectId: defaults.projectId ?? null,
          // A cycle belongs to one team; drop it if the team was changed in the form.
          cycleId: team.id === defaults.teamId ? (defaults.cycleId ?? null) : null,
        },
      },
    );
    setBusy(false);
    if (result) {
      lastTeamId = team.id;
      const identifier = result.issueCreate.issue.identifier;
      toast(`Created ${identifier}`, {
        label: "View",
        run: () => navigate(paths.issue(identifier)),
      });
      onClose();
    }
  }

  const pick = (placeholder: string, items: MenuItem[]) => () => openMenu({ placeholder, items });

  return (
    <Modal
      onClose={onClose}
      label={templateMode ? (schedule ? "Recurring issue" : "Template") : "New issue"}
      wide
    >
      <div className="flex items-center gap-2 px-4 pt-3 text-muted">
        <button
          type="button"
          onClick={pick(
            "Move to team…",
            teams.map((t) => ({
              id: t.id,
              label: t.name,
              hint: t.key,
              checked: t.id === team.id,
              onSelect: () => {
                setTeamId(t.id);
                setStateId(undefined);
                setLabelIds([]);
              },
            })),
          )}
          className="rounded-md border border-line px-2 py-0.5 text-[12px] hover:bg-raised"
        >
          {team.key}
        </button>
        <span className="text-faint">›</span>
        <span>
          {templateMode
            ? schedule
              ? "Recurring issue"
              : "Template"
            : defaults.parentId
              ? "New sub-issue"
              : "New issue"}
        </span>
        {!templateMode && team.templates.length > 0 && (
          <button
            type="button"
            onClick={pick(
              "Use a template…",
              team.templates.map((t) => ({
                id: t.id,
                label: t.name,
                onSelect: () => applyTemplate(t),
              })),
            )}
            className="ml-auto rounded-md px-2 py-0.5 text-[12px] hover:bg-raised"
          >
            Use template
          </button>
        )}
      </div>
      {templateMode && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <input
            aria-label="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name (defaults to the title)"
            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 outline-none focus:border-accent"
          />
          <ScheduleFields schedule={schedule} onChange={setSchedule} />
        </div>
      )}
      <div className="px-4 pt-3">
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to type a title
          autoFocus
          aria-label="Issue title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={templateMode ? "Issue title (use {date} for the day)" : "Issue title"}
          className="w-full bg-transparent text-lg font-medium outline-none placeholder:text-faint"
        />
        <div className="mt-2 max-h-[50vh] min-h-20 overflow-y-auto">
          <RichEditor
            label="Issue description"
            value={description}
            onChange={setDescription}
            onSubmit={() => void submit()}
            placeholder="Add description…"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
        <Chip
          onClick={pick(
            "Change status…",
            states.map((s) => ({
              id: s.id,
              label: s.name,
              icon: <StatusIcon type={s.type} color={s.color} />,
              checked: s.id === state?.id,
              onSelect: () => setStateId(s.id),
            })),
          )}
        >
          {state && <StatusIcon type={state.type} color={state.color} />}
          {state?.name}
        </Chip>
        <Chip
          onClick={pick(
            "Set priority…",
            PRIORITIES.map((p) => ({
              id: String(p.value),
              label: p.label,
              icon: <PriorityIcon priority={p.value} />,
              checked: p.value === priority,
              onSelect: () => setPriority(p.value),
            })),
          )}
        >
          <PriorityIcon priority={priority} />
          {PRIORITIES.find((p) => p.value === priority)?.label}
        </Chip>
        <Chip
          onClick={pick("Assign to…", [
            {
              id: "none",
              label: "No assignee",
              icon: <UnassignedIcon size={16} />,
              onSelect: () => setAssigneeId(null),
            },
            ...(workspace?.users.nodes ?? []).map((m) => ({
              id: m.id,
              label: m.name,
              hint: m.title ?? undefined,
              icon: <Avatar name={m.name} kind={m.kind} size={16} />,
              checked: m.id === assigneeId,
              onSelect: () => setAssigneeId(m.id),
            })),
          ])}
        >
          {assignee ? (
            <Avatar name={assignee.name} kind={assignee.kind} size={16} />
          ) : (
            <UnassignedIcon size={16} />
          )}
          {assignee?.name ?? "Assignee"}
        </Chip>
        {team.labels.nodes.length > 0 && (
          <Chip
            onClick={() => {
              const chosen = new Set(labelIds);
              const build = (): MenuItem[] =>
                team.labels.nodes.map((l) => ({
                  id: l.id,
                  label: l.name,
                  icon: <span className="size-2.5 rounded-full" style={{ background: l.color }} />,
                  checked: chosen.has(l.id),
                  onSelect: () => {
                    if (chosen.has(l.id)) chosen.delete(l.id);
                    else chosen.add(l.id);
                    setLabelIds([...chosen]);
                  },
                }));
              openMenu({ placeholder: "Add labels…", items: build(), multi: true, refresh: build });
            }}
          >
            {labels.length ? labels.map((l) => <LabelChip key={l.id} label={l} />) : "Labels"}
          </Chip>
        )}
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
        <span className="text-[12px] text-faint max-sm:hidden">
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to create
        </span>
        <button
          type="button"
          disabled={!title.trim() || busy}
          onClick={() => void submit()}
          className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          {templateMode ? "Save" : "Create issue"}
        </button>
      </div>
    </Modal>
  );
}

function Chip({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-muted hover:bg-raised hover:text-ink"
    >
      {children}
    </button>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FREQUENCIES: { value: Schedule["frequency"] | "none"; label: string }[] = [
  { value: "none", label: "Doesn't repeat" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const field =
  "rounded-md border border-line bg-panel px-2 py-1 outline-none focus:border-accent [color-scheme:dark]";

/** When a recurring issue repeats, in the company's time zone. */
function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: Schedule | null;
  onChange: (schedule: Schedule | null) => void;
}) {
  const set = (patch: Partial<Schedule>) => schedule && onChange({ ...schedule, ...patch });
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Repeats"
        value={schedule?.frequency ?? "none"}
        onChange={(e) => {
          const value = e.target.value as Schedule["frequency"] | "none";
          onChange(
            value === "none"
              ? null
              : {
                  frequency: value,
                  time: schedule?.time ?? "09:00",
                  weekday: schedule?.weekday ?? 1,
                  monthDay: schedule?.monthDay ?? 1,
                },
          );
        }}
        className={field}
      >
        {FREQUENCIES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      {schedule?.frequency === "weekly" && (
        <select
          aria-label="On day"
          value={schedule.weekday ?? 1}
          onChange={(e) => set({ weekday: Number(e.target.value) })}
          className={field}
        >
          {DAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
      )}
      {schedule?.frequency === "monthly" && (
        <input
          type="number"
          aria-label="Day of the month"
          min={1}
          max={31}
          value={schedule.monthDay ?? 1}
          onChange={(e) => set({ monthDay: Number(e.target.value) || 1 })}
          className={`${field} w-16`}
        />
      )}
      {schedule && (
        <input
          type="time"
          aria-label="Time of day"
          value={schedule.time}
          onChange={(e) => set({ time: e.target.value || "09:00" })}
          className={field}
        />
      )}
    </span>
  );
}
