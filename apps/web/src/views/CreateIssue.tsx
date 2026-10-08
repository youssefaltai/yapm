import { useCallback, useState } from "react";
import {
  type CreateIssueDefaults,
  createIssueStore,
  createTeamStore,
  workspaceStore,
} from "../actions.js";
import { mutate, PRIORITIES, toast } from "../data.js";
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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stateId, setStateId] = useState<string | undefined>(defaults.stateId);
  const [priority, setPriority] = useState(0);
  const [assigneeId, setAssigneeId] = useState<string | null>(defaults.assigneeId ?? null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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

  async function submit() {
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
    <Modal onClose={onClose} label="New issue" wide>
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
        <span>{defaults.parentId ? "New sub-issue" : "New issue"}</span>
      </div>
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
          placeholder="Issue title"
          className="w-full bg-transparent text-lg font-medium outline-none placeholder:text-faint"
        />
        <textarea
          aria-label="Issue description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Add description…"
          rows={4}
          className="mt-2 w-full resize-none bg-transparent outline-none placeholder:text-faint"
        />
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
          Create issue
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
