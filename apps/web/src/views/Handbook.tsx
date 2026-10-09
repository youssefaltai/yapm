import { workspaceStore } from "../actions.js";
import { mutate, useQuery } from "../data.js";
import { Breadcrumbs, Page, PageBody, PageHeader } from "../layout.js";
import { paths } from "../router.js";
import { PageSkeleton } from "../states.js";
import { useStore } from "../ui.js";
import { Prose, RevisionList, useRevisions } from "./Learning.js";

/** How the company works, in its own words. Every agent reads it on every run. */
export function Handbook() {
  const workspace = useStore(workspaceStore);
  const { data } = useQuery<{ organization: { handbook: string | null } }>(
    "{ organization { handbook } }",
  );
  const history = useRevisions("handbook");
  if (!data || !workspace || !history) return <PageSkeleton />;
  return (
    <Page>
      <PageHeader>
        <Breadcrumbs trail={[{ label: "Company", to: paths.company() }]}>Handbook</Breadcrumbs>
      </PageHeader>
      <PageBody>
        <p className="mb-3 text-muted">
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
        <RevisionList rows={history} />
      </PageBody>
    </Page>
  );
}
