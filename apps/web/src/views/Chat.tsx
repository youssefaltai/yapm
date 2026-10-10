import { useEffect, useRef, useState } from "react";
import { type Member, mutate, useQuery, type Workspace } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { button, Page, PageHeader, PageTitle } from "../layout.js";
import { Avatar, createStore, Kbd, timeAgo, useStore } from "../ui.js";
import type { RunStatus } from "./Runs.js";

/** The CEO: the first agent reporting to the owner, created with the company. */
export function ceoOf(workspace: Workspace | null): Member | undefined {
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

  return (
    <Page>
      <PageHeader>
        <PageTitle>{name}</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end px-4 pt-6 md:px-6">
          {chat.said.length === 0 && (
            <p className="m-auto text-center text-muted">
              Tell {name} what you need. This chat isn't saved; what matters ends up in issues and
              docs.
            </p>
          )}
          <ol aria-label={`Chat with ${name}`} className="space-y-3">
            {chat.said.map((said, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the thread only grows
                key={i}
                className="animate-fade-in rounded-lg border border-line bg-panel px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <Avatar
                    name={said.from === "ceo" ? name : workspace.viewer.name}
                    kind={said.from === "ceo" ? "agent" : workspace.viewer.kind}
                  />
                  <span className="font-medium">
                    {said.from === "ceo" ? name : workspace.viewer.name}
                  </span>
                  <span className="text-faint">{timeAgo(said.at)}</span>
                </div>
                {said.failed ? (
                  <p className="mt-1.5 text-faint">Couldn't reply: {said.body}</p>
                ) : (
                  <RichText source={said.body} className="mt-1.5" />
                )}
              </li>
            ))}
          </ol>
          {chat.waiting && (
            <p className="mt-3 animate-fade-in px-1 text-faint">{name} is thinking…</p>
          )}
          <div ref={end} className="sticky bottom-0 bg-canvas pt-3 pb-4">
            <div className="rounded-lg border border-line bg-panel px-4 py-3 focus-within:border-faint">
              <RichEditor
                key={sent}
                label={`Message ${name}`}
                autoFocus
                value=""
                placeholder={`Message ${name}…`}
                onChange={setBody}
                onSubmit={() => void send()}
                className="min-h-6"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <span className="text-[12px] text-faint max-sm:hidden">
                  <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
                </span>
                <button
                  type="button"
                  disabled={!body.trim() || busy || !!chat.waiting}
                  onClick={() => void send()}
                  className={button("primary")}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
