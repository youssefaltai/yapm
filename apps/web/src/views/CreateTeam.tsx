import { type FormEvent, useCallback, useState } from "react";
import { createTeamStore } from "../actions.js";
import { mutate } from "../data.js";
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

export function CreateTeamHost() {
  const open = useStore(createTeamStore);
  const close = useCallback(() => createTeamStore.set(false), []);
  return open ? <CreateTeam onClose={close} /> : null;
}

function CreateTeam({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const shownKey = key ?? suggestKey(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await mutate<{ teamCreate: { team: { key: string } } }>(
      "mutation($input: TeamCreateInput!) { teamCreate(input: $input) { team { key } } }",
      { input: { name, key: shownKey || null, description: description || null } },
    );
    setBusy(false);
    if (result) {
      onClose();
      navigate(paths.team(result.teamCreate.team.key));
    }
  }

  const input =
    "w-full rounded-md border border-line bg-canvas px-3 py-2 outline-none placeholder:text-faint focus:border-accent";
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
        <label className="mb-4 block">
          <span className="mb-1.5 block text-muted">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className={input}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            Create team
          </button>
        </div>
      </form>
    </Modal>
  );
}
