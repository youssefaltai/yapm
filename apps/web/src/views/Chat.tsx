import { useEffect, useRef, useState } from "react";
import { type Member, mutate, useQuery, type Workspace } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { icon } from "../icons.js";
import { Page, PageHeader, PageTitle } from "../layout.js";
import { EmptyState } from "../states.js";
import { createStore, timeAgo, useStore } from "../ui.js";
import { machineSetup, type SetupCommand, SetupPanel } from "./Machines.js";
import type { RunStatus } from "./Runs.js";

/** The CEO: the first agent reporting to the owner, created with the company. */
function ceoOf(workspace: Workspace | null): Member | undefined {
  const owner = workspace?.users.nodes.find((u) => u.kind === "owner");
  return workspace?.users.nodes.find((u) => u.kind === "agent" && u.manager?.id === owner?.id);
}

interface Said {
  from: "owner" | "ceo";
  body: string;
  at: string;
  failed?: boolean;
}

// The chat isn't saved: it lives here until a reload. Each message is a run for the CEO, and
// `runId` is the last one that answered, which the next message continues.
const chatStore = createStore<{ said: Said[]; runId?: string; waiting?: string }>({ said: [] });

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

const RUN = "query($id: String!) { run(id: $id) { status result error } }";

interface ChatRun {
  status: RunStatus;
  result: { summary?: string; outcome?: string; question?: string } | null;
  error: string | null;
}

/** The owner asks the CEO for things directly, outside any issue or team. */
export function ChatView({ workspace }: { workspace: Workspace }) {
  const ceo = ceoOf(workspace);
  const name = ceo?.name ?? "CEO";
  const chat = useStore(chatStore);
  const { data, stale } = useQuery<{ run: ChatRun }>(
    chat.waiting ? RUN : null,
    { id: chat.waiting },
    2000,
  );
  const run = stale ? undefined : data?.run;
  // The CEO runs on the owner's machines; until there's one, the chat offers to add it.
  const [setup, setSetup] = useState<SetupCommand | null>(null);
  const machines = useQuery<{ machines: { id: string; status: string }[] }>(
    "{ machines { id status } }",
    undefined,
    setup ? 3_000 : 15_000,
  );
  const atHand = useQuery<AtHand>(chat.said.length ? null : AT_HAND);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Each sent message starts a fresh editor.
  const [sent, setSent] = useState(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const current = chatStore.get();
    if (!run || !current.waiting || run.status === "queued" || run.status === "running") return;
    const answered = run.status === "completed" || run.status === "needs_input";
    const { summary, outcome, question } = run.result ?? {};
    const reply = answered
      ? [summary, outcome === "needs_input" && question].filter(Boolean).join("\n\n") || "Done."
      : (run.error ?? `The run was ${run.status}.`);
    chatStore.set({
      said: [
        ...current.said,
        { from: "ceo", body: reply, at: new Date().toISOString(), failed: !answered },
      ],
      runId: answered ? current.waiting : current.runId,
    });
  }, [run]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the thread grows
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [chat.said.length, chat.waiting]);

  async function send() {
    if (!ceo || !body.trim() || busy || chat.waiting) return;
    setBusy(true);
    const result = await mutate<{ runCreate: { run: { id: string } } }>(
      "mutation($input: RunCreateInput!) { runCreate(input: $input) { run { id } } }",
      { input: { agentId: ceo.id, goal: body, chat: true, resumeRunId: chat.runId } },
    );
    setBusy(false);
    if (!result) return;
    const current = chatStore.get();
    chatStore.set({
      ...current,
      said: [...current.said, { from: "owner", body, at: new Date().toISOString() }],
      waiting: result.runCreate.run.id,
    });
    setBody("");
    setSent((n) => n + 1);
  }

  if (machines.data && !machines.data.machines.some((m) => m.status === "active"))
    return (
      <Page>
        <PageHeader>
          <PageTitle>Chat</PageTitle>
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
        <PageTitle>Chat</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end px-4 pt-6 md:px-6">
          {chat.said.length === 0 && (
            <div className="m-auto flex animate-rise-in flex-col items-center py-8 text-center">
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
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {suggestions(atHand.data).map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => {
                      setBody(text);
                      setSent((n) => n + 1);
                    }}
                    className="max-w-full truncate rounded-full border border-line px-3 py-1.5 text-muted hover:border-faint hover:text-ink"
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          <ol aria-label={`Chat with ${name}`} className="space-y-5">
            {chat.said.map((said, i) =>
              said.from === "owner" ? (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: the thread only grows
                  key={i}
                  className="ml-auto w-fit max-w-[85%] animate-rise-in rounded-2xl rounded-br-md bg-raised px-4 py-2.5"
                >
                  <RichText source={said.body} />
                </li>
              ) : (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: the thread only grows
                  key={i}
                  className="flex animate-fade-in gap-3"
                >
                  <img src="/icon.svg" alt="" className="size-6 shrink-0" />
                  <div className="min-w-0 flex-1 pt-0.5">
                    {said.failed ? (
                      <p className="text-critical">Couldn't reply: {said.body}</p>
                    ) : (
                      <RichText source={said.body} />
                    )}
                    <span className="mt-1 block text-[12px] text-faint">{timeAgo(said.at)}</span>
                  </div>
                </li>
              ),
            )}
          </ol>
          {chat.waiting && (
            <div className="mt-5 flex animate-fade-in items-center gap-3">
              <img src="/icon.svg" alt="" className="size-6 shrink-0" />
              <span role="status" aria-label={`${name} is thinking`} className="flex gap-1">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-typing rounded-full bg-muted"
                    style={{ animationDelay: `${dot * 150}ms` }}
                  />
                ))}
              </span>
            </div>
          )}
          <div ref={end} className="sticky bottom-0 bg-canvas pt-4 pb-3">
            <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel py-2 pr-2 pl-4 transition-colors focus-within:border-faint">
              <div className="max-h-60 min-w-0 flex-1 overflow-y-auto py-1">
                <RichEditor
                  key={sent}
                  label={`Message ${name}`}
                  autoFocus
                  value={body}
                  placeholder={`Message ${name}…`}
                  onChange={setBody}
                  onSubmit={() => void send()}
                  className="min-h-6"
                />
              </div>
              <button
                type="button"
                aria-label="Send"
                disabled={!body.trim() || busy || !!chat.waiting}
                onClick={() => void send()}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity hover:bg-accent-hover disabled:opacity-30"
              >
                {icon("send")}
              </button>
            </div>
            <p className="mt-2 text-center text-[12px] text-faint">
              Not saved. What matters lands in issues and docs.
            </p>
          </div>
        </div>
      </div>
    </Page>
  );
}
