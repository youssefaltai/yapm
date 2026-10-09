import { useCallback } from "react";
import { shortcutsStore } from "../actions.js";
import { eyebrow } from "../layout.js";
import { Kbd, Modal, useStore } from "../ui.js";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "General",
    keys: [
      ["⌘ K", "Search and commands"],
      ["C", "Create issue"],
      ["?", "Keyboard shortcuts"],
    ],
  },
  {
    title: "Lists",
    keys: [
      ["J / K", "Move down / up"],
      ["X", "Select"],
      ["⌘ A", "Select all"],
      ["O or Enter", "Open issue"],
    ],
  },
  {
    title: "Issues",
    keys: [
      ["S", "Change status"],
      ["P", "Change priority"],
      ["A", "Assign"],
      ["L", "Labels"],
      ["E", "Estimate"],
      ["⇧ P", "Move to project"],
      ["⇧ C", "Move to cycle"],
    ],
  },
];

export function ShortcutsHost() {
  const open = useStore(shortcutsStore);
  const close = useCallback(() => shortcutsStore.set(false), []);
  if (!open) return null;
  return (
    <Modal label="Keyboard shortcuts" onClose={close}>
      <div className="flex items-center border-b border-line px-4 py-3">
        <h2 className="font-medium">Keyboard shortcuts</h2>
        <button type="button" onClick={close} className="ml-auto text-muted hover:text-ink">
          Close
        </button>
      </div>
      <div className="grid gap-5 px-4 py-4 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className={`mb-2 ${eyebrow}`}>{group.title}</h3>
            <dl className="space-y-1.5">
              {group.keys.map(([keys, what]) => (
                <div key={what} className="flex items-center justify-between gap-3">
                  <dt className="text-muted">{what}</dt>
                  <dd>
                    <Kbd>{keys}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
