import { workspaceStore } from "../actions.js";
import { confirmDialog, promptDialog } from "../controls.js";
import { mutate, toast } from "../data.js";
import { navigate, paths } from "../router.js";
import { EmptyState } from "../states.js";
import { useStore } from "../ui.js";
import { IssuesView } from "./IssuesView.js";

/** A saved filter from the sidebar's Views section. */
export function ViewPage({ id }: { id: string }) {
  const workspace = useStore(workspaceStore);
  const view = workspace?.customViews.nodes.find((v) => v.id === id);
  if (!workspace) return null;
  if (!view)
    return (
      <EmptyState
        icon="compass"
        title="View not found"
        description="It may have been deleted. Saved views live under Views in the sidebar."
        action={{ label: "Go to My issues", onClick: () => navigate(paths.myIssues()) }}
      />
    );

  const rename = async () => {
    const name = await promptDialog({
      title: "Rename view",
      label: "View name",
      initial: view.name,
      confirmLabel: "Rename",
    });
    if (name && name !== view.name)
      await mutate(
        "mutation($id: String!, $name: String!) { customViewUpdate(id: $id, input: { name: $name }) { success } }",
        { id, name },
      );
  };
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: `Delete the view “${view.name}”?`,
        body: "Its issues stay as they are.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
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
