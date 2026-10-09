import { type FormEvent, useCallback, useState } from "react";
import { hireAgentStore, workspaceStore } from "../actions.js";
import { Select } from "../controls.js";
import { mutate } from "../data.js";
import { RichEditor } from "../editor/index.js";
import { button, dialogField } from "../layout.js";
import { navigate, paths } from "../router.js";
import { Modal, useStore } from "../ui.js";

export function HireAgentHost() {
  const open = useStore(hireAgentStore);
  const close = useCallback(() => hireAgentStore.set(false), []);
  return open ? <HireAgent onClose={close} /> : null;
}

function HireAgent({ onClose }: { onClose: () => void }) {
  const workspace = useStore(workspaceStore);
  const members = workspace?.users.nodes ?? [];
  const ceo = members.find((m) => m.kind === "agent" && !m.manager?.id) ?? members[0];
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [charter, setCharter] = useState("");
  const [managerId, setManagerId] = useState(ceo?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await mutate<{ agentHire: { user: { id: string } } }>(
      "mutation($input: AgentHireInput!) { agentHire(input: $input) { user { id } } }",
      {
        input: {
          name,
          title: title || null,
          charter: charter || null,
          managerId: managerId || null,
        },
      },
    );
    setBusy(false);
    if (result) {
      onClose();
      navigate(paths.member(result.agentHire.user.id));
    }
  }

  const input = dialogField;
  return (
    <Modal onClose={onClose} label="Hire agent">
      <form onSubmit={submit} className="p-5">
        <h2 className="text-[15px] font-medium">Hire an agent</h2>
        <p className="mt-1 mb-4 text-muted">
          An AI employee with a name, a role and a charter that says what it owns.
        </p>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Name</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to type a name
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada"
            className={input}
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-muted">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Head of Finance"
            className={input}
          />
        </label>
        <div className="mb-3 block">
          <span className="mb-1.5 block text-muted">Reports to</span>
          <Select
            aria-label="Reports to"
            value={managerId}
            onChange={setManagerId}
            options={members.map((m) => ({
              value: m.id,
              label: m.title && m.title !== m.name ? `${m.name}, ${m.title}` : m.name,
            }))}
            className={input}
          />
        </div>
        <div className="mb-4 block">
          <span className="mb-1.5 block text-muted">Charter</span>
          <div className="rounded-md border border-line bg-panel px-2.5 py-1.5 focus-within:border-faint">
            <RichEditor
              label="Charter"
              value=""
              onChange={setCharter}
              placeholder="What this agent is responsible for, and how it should work."
              className="min-h-20"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={button("ghost")}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={button("primary")}>
            Hire
          </button>
        </div>
      </form>
    </Modal>
  );
}
