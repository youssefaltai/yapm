import { type FormEvent, useCallback, useState } from "react";
import { createTeamStore, workspaceStore } from "../actions.js";
import { Select } from "../controls.js";
import { mutate, type Team, teamTree } from "../data.js";
import { button, dialogField } from "../layout.js";
import { navigate, paths } from "../router.js";
import { Modal, useStore } from "../ui.js";

/** Mirrors the hub's key suggestion: initials, or the first letters of a single word. */
function suggestKey(name: string) {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const key = initials.length >= 2 ? initials : (words[0] ?? "").slice(0, 3);
  return (/^[A-Z]/.test(key) || !key ? key : `T${key}`).slice(0, 7);
}

/** Teams to nest under, sub-teams after their parent; `except` leaves out a team and its sub-teams. */
export function parentOptions(teams: Team[], except?: string) {
  const tree = teamTree(teams);
  const skip = new Set<string>();
  for (const { team } of tree)
    if (team.id === except || (team.parent && skip.has(team.parent.id))) skip.add(team.id);
  return [
    { value: "", label: "No parent team" },
    ...tree
      .filter(({ team }) => !skip.has(team.id))
      .map(({ team }) => ({ value: team.id, label: team.name })),
  ];
}

export function CreateTeamHost() {
  const open = useStore(createTeamStore);
  const close = useCallback(() => createTeamStore.set(false), []);
  return open ? <CreateTeam onClose={close} /> : null;
}

function CreateTeam({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const teams = useStore(workspaceStore)?.teams.nodes ?? [];
  const [busy, setBusy] = useState(false);
  const shownKey = key ?? suggestKey(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await mutate<{ teamCreate: { team: { key: string } } }>(
      "mutation($input: TeamCreateInput!) { teamCreate(input: $input) { team { key } } }",
      {
        input: {
          name,
          key: shownKey || null,
          description: description || null,
          parentId: parentId || null,
        },
      },
    );
    setBusy(false);
    if (result) {
      onClose();
      navigate(paths.team(result.teamCreate.team.key));
    }
  }

  const input = dialogField;
  return (
    <Modal onClose={onClose} label="Create team">
      <form onSubmit={submit} className="p-5">
        <h2 className="text-[15px] font-medium">Create a team</h2>
        <p className="mt-1 mb-4 text-muted">
          A team holds one area of your life's work, with its own issues and workflow.
        </p>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Name</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to type a name
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Personal Finance"
            className={input}
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Identifier</span>
          <input
            value={shownKey}
            onChange={(e) =>
              setKey(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, 7),
              )
            }
            placeholder="PF"
            className={`${input} uppercase`}
          />
          <span className="mt-1 block text-[12px] text-faint">
            Issues are numbered with it, like {shownKey || "PF"}-1.
          </span>
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className={input}
          />
        </label>
        <label htmlFor="team-parent" className="mb-4 block">
          <span className="mb-1.5 block text-muted">Parent team</span>
          <Select
            id="team-parent"
            value={parentId}
            options={parentOptions(teams)}
            onChange={setParentId}
            className={`${input} text-left`}
          />
          <span className="mt-1 block text-[12px] text-faint">
            A sub-team's members are members of its parent too.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={button("ghost")}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={button("primary")}>
            Create team
          </button>
        </div>
      </form>
    </Modal>
  );
}
