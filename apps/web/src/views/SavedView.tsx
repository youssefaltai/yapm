import { workspaceStore } from "../actions.js";
import { mutate, toast } from "../data.js";
import { navigate, paths } from "../router.js";
import { useStore } from "../ui.js";
import { IssuesView } from "./IssuesView.js";

/** A saved filter from the sidebar's Views section. */
export function ViewPage({ id }: { id: string }) {
  const workspace = useStore(workspaceStore);
  const view = workspace?.customViews.nodes.find((v) => v.id === id);
  if (!workspace) return null;
  if (!view) return <p className="px-6 py-10 text-center text-muted">View not found.</p>;

  const rename = async () => {
    const name = window.prompt("Rename view", view.name)?.trim();
    if (name && name !== view.name)
      await mutate(
        "mutation($id: String!, $name: String!) { customViewUpdate(id: $id, input: { name: $name }) { success } }",
        { id, name },
      );
  };
  const remove = async () => {
    if (!window.confirm(`Delete the view “${view.name}”? Its issues stay as they are.`)) return;
    if (await mutate("mutation($id: String!) { customViewDelete(id: $id) { success } }", { id })) {
      toast(`Deleted “${view.name}”`);
      navigate(paths.inbox());
    }
  };
  return (
    <IssuesView
      source={{ kind: "view", view: { id, name: view.name, teamId: view.team?.id ?? null } }}
      title={view.name}
      tabs={
        <>
          {!view.shared && <span className="text-[12px] text-faint">Private</span>}
          <button
            type="button"
            onClick={() => void rename()}
            className="px-1 text-muted hover:text-ink"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            className="px-1 text-muted hover:text-ink"
          >
            Delete
          </button>
        </>
      }
    />
  );
}
