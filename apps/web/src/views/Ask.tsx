import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createTeamStore } from "../actions.js";
import { graphql } from "../api.js";
import { invalidate, type Member, useQuery, type Workspace } from "../data.js";
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

/** Opens the new issue, cross-fading into it where the browser can and motion is welcome. */
function goTo(path: string) {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !calm)
    document.startViewTransition(() => flushSync(() => navigate(path)));
  else navigate(path);
}

/**
 * The owner asks the CEO for something. It becomes an issue assigned to the CEO, which starts
 * the work; results, questions and replies all land on the issue, and its followers hear.
 */
export function AskView({ workspace }: { workspace: Workspace }) {
  const ceo = ceoOf(workspace);
  const name = ceo?.name ?? "CEO";
  const team = workspace.teams.nodes[0];
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
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // The box grows with the text, up to its max height, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures again as the text changes
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [body]);

  function edit(text: string) {
    setBody(text);
    setError(null);
  }

  async function ask() {
    const message = body.trim();
    if (!ceo || !team || !message || busy) return;
    setBusy(true);
    setError(null);
    const title = titleOf(message);
    try {
      const { issueCreate } = await graphql<{ issueCreate: { issue: { identifier: string } } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier } } }",
        {
          input: {
            teamId: team.id,
            title,
            // A one-liner is all title; a longer message keeps every word in the description.
            description: message === title ? null : message,
            assigneeId: ceo.id,
          },
        },
      );
      void invalidate();
      goTo(paths.issue(issueCreate.issue.identifier));
    } catch (failure) {
      // The message stays, ready to send again.
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
      input.current?.focus();
    }
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

  // Companies start with a team; if every one has gone, there's nowhere to file the ask.
  if (!team)
    return (
      <Page>
        <PageHeader>
          <PageTitle>Ask {name}</PageTitle>
        </PageHeader>
        <EmptyState
          icon="team"
          title="Add a team first"
          description={`Every ask becomes an issue, and issues live in teams. Create one and ${name} can take it from there.`}
          action={{ label: "Create team", onClick: () => createTeamStore.set(true) }}
        />
      </Page>
    );

  return (
    <Page>
      <PageHeader>
        <PageTitle>Ask {name}</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] md:px-6">
          {/* On send, the composer steps back and the CEO's logo, the one focal point, gets to work. */}
          <div className="flex animate-rise-in flex-col items-center text-center">
            <span
              role="status"
              aria-label={busy ? `${name} is taking it on` : undefined}
              className="rounded-full p-4 md:p-5"
              style={{
                background:
                  "radial-gradient(closest-side, color-mix(in srgb, var(--color-ink) 12%, transparent), transparent)",
              }}
            >
              <img
                src="/icon.svg"
                alt=""
                className={`size-12 md:size-14 ${busy ? "animate-think" : ""}`}
              />
            </span>
            <p className="mt-3 text-muted">
              Hi {workspace.viewer.name.split(" ")[0]},{" "}
              {name === "CEO" ? "I'm your CEO." : `I'm ${name}, your CEO.`}
            </p>
            <h2 className="mt-1 grid text-xl font-medium text-balance">
              {/* Both lines share one cell, so the swap cross-fades in place. */}
              <span
                aria-hidden={busy}
                className={`[grid-area:1/1] transition-opacity duration-300 ${busy ? "opacity-0" : ""}`}
              >
                What can I take off your plate?
              </span>
              <span
                aria-hidden={!busy}
                className={`[grid-area:1/1] transition-opacity duration-300 ${busy ? "" : "opacity-0"}`}
              >
                On it…
              </span>
            </h2>
          </div>
          <div
            className={`mt-6 transition-[opacity,transform] duration-300 ease-snappy ${busy ? "pointer-events-none translate-y-1 opacity-0" : ""}`}
          >
            <div
              className={`flex items-end gap-2 rounded-2xl border bg-panel py-2 pr-2 pl-4 shadow-xs ${error ? "border-critical" : "border-line focus-within:border-faint"}`}
            >
              <textarea
                ref={input}
                rows={1}
                // biome-ignore lint/a11y/noAutofocus: asking is the one thing this page is for
                autoFocus
                aria-label={`Ask ${name}`}
                aria-invalid={!!error}
                readOnly={busy}
                enterKeyHint="send"
                value={body}
                placeholder="Tell me what you need…"
                onChange={(e) => edit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  void ask();
                }}
                className="block max-h-60 min-w-0 flex-1 resize-none bg-transparent py-1 text-base leading-6 outline-none placeholder:text-faint md:text-[15px]"
              />
              <button
                type="button"
                aria-label="Ask"
                disabled={!body.trim() || busy}
                onClick={() => void ask()}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-30"
              >
                {icon("send")}
              </button>
            </div>
          </div>
          <div
            aria-hidden={busy}
            className={`transition-opacity duration-200 ${busy ? "pointer-events-none opacity-0" : ""}`}
          >
            {error ? (
              <p role="alert" className="mt-2 text-center text-[12px] text-critical">
                {error}. Your message is still here; press Enter to try again.
              </p>
            ) : (
              <p className="mt-2 text-center text-[12px] text-faint">
                I'll make it an issue and get to work. Follow along and reply there.
              </p>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {suggestions(atHand.data).map((text, i) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => {
                    flushSync(() => edit(text));
                    input.current?.focus();
                    input.current?.setSelectionRange(text.length, text.length);
                  }}
                  style={{ animationDelay: `${120 + i * 50}ms` }}
                  className="max-w-full animate-fade-in truncate rounded-full border border-line bg-panel px-3 py-1.5 text-[13px] text-muted shadow-xs hover:border-faint hover:bg-raised hover:text-ink"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
