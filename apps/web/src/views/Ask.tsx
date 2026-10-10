import { useState } from "react";
import { type Member, mutate, useQuery, type Workspace } from "../data.js";
import { RichEditor } from "../editor/index.js";
import { icon } from "../icons.js";
import { Page, PageHeader, PageTitle } from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState } from "../states.js";
import { machineSetup, type SetupCommand, SetupPanel } from "./Machines.js";

/** The CEO: the first agent reporting to the owner, created with the company. */
function ceoOf(workspace: Workspace | null): Member | undefined {
  const owner = workspace?.users.nodes.find((u) => u.kind === "owner");
  return workspace?.users.nodes.find((u) => u.kind === "agent" && u.manager?.id === owner?.id);
}

// What to ask the CEO comes from the work at hand, with one cheap query and no model: requests
// waiting on the owner, then open issues, overdue and urgent first. A new company gets starters.
const STARTERS = ["Plan my week", "What needs my attention?", "Set up a team for my bills"];

const AT_HAND = `{
  requests(first: 1, filter: { status: [pending] }) { nodes { title } }
  issues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { title priority dueDate state { type } }
  }
}`;

interface AtHand {
  requests: { nodes: { title: string }[] };
  issues: {
    nodes: { title: string; priority: number; dueDate: string | null; state: { type: string } }[];
  };
}

function suggestions(data: AtHand | null | undefined) {
  if (!data) return [];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = (i: AtHand["issues"]["nodes"][number]) => !!i.dueDate && i.dueDate < today;
  const issues = [...data.issues.nodes]
    .sort(
      (a, b) =>
        +overdue(b) - +overdue(a) ||
        (a.priority || 5) - (b.priority || 5) ||
        +(b.state.type === "started") - +(a.state.type === "started"),
    )
    .map((i) =>
      overdue(i)
        ? `"${i.title}" is overdue. What now?`
        : i.state.type === "started"
          ? `What's left on "${i.title}"?`
          : `Make a plan for "${i.title}"`,
    );
  const requests = data.requests.nodes.map((r) => `Help me decide on "${r.title}"`);
  return [...requests, ...issues, ...STARTERS].slice(0, 3);
}

/** The issue's title: the message's first line, without Markdown's leading marks, kept short. */
function titleOf(message: string) {
  const line =
    message
      .trim()
      .split("\n")[0]
      ?.replace(/^[#>*\-\s]+/, "")
      .trim() || message.trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** Issues live in teams; a new company gets its first one, named after it, as in Linear. */
async function teamFor(workspace: Workspace) {
  const team = workspace.teams.nodes[0];
  if (team) return team.id;
  const created = await mutate<{ teamCreate: { team: { id: string } } }>(
    "mutation($input: TeamCreateInput!) { teamCreate(input: $input) { team { id } } }",
    { input: { name: workspace.organization.name } },
  );
  return created?.teamCreate.team.id;
}

/**
 * The owner asks the CEO for something. It becomes an issue assigned to the CEO, which starts
 * the work; results, questions and replies all land on the issue, and its followers hear.
 */
export function AskView({ workspace }: { workspace: Workspace }) {
  const ceo = ceoOf(workspace);
  const name = ceo?.name ?? "CEO";
  // The CEO runs on the owner's machines; until there's one, the page offers to add it.
  const [setup, setSetup] = useState<SetupCommand | null>(null);
  const machines = useQuery<{ machines: { id: string; status: string }[] }>(
    "{ machines { id status } }",
    undefined,
    setup ? 3_000 : 15_000,
  );
  const atHand = useQuery<AtHand>(AT_HAND);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // A suggestion starts a fresh editor holding it.
  const [draft, setDraft] = useState(0);

  async function ask() {
    if (!ceo || !body.trim() || busy) return;
    setBusy(true);
    const teamId = await teamFor(workspace);
    const title = titleOf(body);
    // A one-liner is all title; a longer message keeps every word in the description.
    const description = body.trim() === title ? null : body.trim();
    const result =
      teamId &&
      (await mutate<{ issueCreate: { issue: { identifier: string } } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier } } }",
        { input: { teamId, title, description, assigneeId: ceo.id } },
      ));
    setBusy(false);
    if (result) navigate(paths.issue(result.issueCreate.issue.identifier));
  }

  if (machines.data && !machines.data.machines.some((m) => m.status === "active"))
    return (
      <Page>
        <PageHeader>
          <PageTitle>Ask {name}</PageTitle>
        </PageHeader>
        {setup ? (
          <div className="m-auto w-full max-w-xl animate-rise-in px-4">
            <SetupPanel setup={setup} added={undefined} onDone={() => setSetup(null)} />
          </div>
        ) : (
          <EmptyState
            icon="machine"
            title="Add your first machine"
            description={`${name} works on your own Mac or Linux computer, signed in with your Claude account. One command sets it up.`}
            action={{
              label: "Add machine",
              onClick: async () => setSetup(await machineSetup(machines.data?.machines ?? [])),
            }}
          />
        )}
      </Page>
    );

  return (
    <Page>
      <PageHeader>
        <PageTitle>Ask {name}</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8 md:px-6">
          <div className="flex animate-rise-in flex-col items-center text-center">
            <span
              className="rounded-full p-5"
              style={{
                background:
                  "radial-gradient(closest-side, color-mix(in srgb, var(--color-ink) 12%, transparent), transparent)",
              }}
            >
              <img src="/icon.svg" alt="" className="size-14" />
            </span>
            <p className="mt-3 text-muted">
              Hi {workspace.viewer.name.split(" ")[0]}, I'm {name}.
            </p>
            <h2 className="mt-1 text-xl font-medium text-balance">
              What can I take off your plate?
            </h2>
          </div>
          <div className="mt-6 flex items-end gap-2 rounded-2xl border border-line bg-panel py-2 pr-2 pl-4 transition-colors focus-within:border-faint">
            <div className="max-h-60 min-w-0 flex-1 overflow-y-auto py-1">
              <RichEditor
                key={draft}
                label={`Ask ${name}`}
                autoFocus
                value={body}
                placeholder="Tell me what you need…"
                onChange={setBody}
                onSubmit={() => void ask()}
                className="min-h-6"
              />
            </div>
            <button
              type="button"
              aria-label="Ask"
              disabled={!body.trim() || busy}
              onClick={() => void ask()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity hover:bg-accent-hover disabled:opacity-30"
            >
              {icon("send")}
            </button>
          </div>
          {busy ? (
            <div
              role="status"
              className="mt-3 flex animate-fade-in items-center justify-center gap-2 text-muted"
            >
              <img src="/icon.svg" alt="" className="size-5" />
              {name} is on it
              <span className="flex gap-1" aria-hidden="true">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-typing rounded-full bg-muted"
                    style={{ animationDelay: `${dot * 150}ms` }}
                  />
                ))}
              </span>
            </div>
          ) : (
            <>
              <p className="mt-2 text-center text-[12px] text-faint">
                I'll make it an issue and get to work. Follow along and reply there.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {suggestions(atHand.data).map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => {
                      setBody(text);
                      setDraft((n) => n + 1);
                    }}
                    className="max-w-full truncate rounded-full border border-line px-3 py-1.5 text-muted hover:border-faint hover:text-ink"
                  >
                    {text}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
