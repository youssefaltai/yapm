import { workspaceStore } from "../actions.js";
import { mutate, useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { useStore } from "../ui.js";
import { Prose, RevisionList } from "./Learning.js";

/** How the company works, in its own words. Every agent reads it on every run. */
export function Handbook() {
  const workspace = useStore(workspaceStore);
  const { data } = useQuery<{ organization: { handbook: string | null } }>(
    "{ organization { handbook } }",
  );
  if (!data || !workspace) return null;
  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-11 items-center gap-2 border-b border-line px-4 md:px-6">
        <button
          type="button"
          onClick={() => navigate(paths.company())}
          className="text-muted hover:text-ink"
        >
          Company
        </button>
        <span className="text-faint">›</span>
        <span className="font-medium">Handbook</span>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <p className="mb-3 text-faint">
          How {workspace.organization.name} works: conventions, preferences and rules every agent
          follows. It starts empty; you and your agents write it as you learn what works.
        </p>
        <Prose
          label="Handbook"
          value={data.organization.handbook ?? ""}
          placeholder="e.g. Never pay a bill without a receipt attached to the issue."
          disabled={workspace.viewer.kind !== "owner"}
          onSave={(handbook) =>
            void mutate(
              "mutation($input: OrganizationUpdateInput!) { organizationUpdate(input: $input) { success } }",
              { input: { handbook } },
            )
          }
        />
        <RevisionList subject="handbook" />
      </div>
    </div>
  );
}
