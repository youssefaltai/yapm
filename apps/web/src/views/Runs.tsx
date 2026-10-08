import { type ReactNode, useState } from "react";
import { workspaceStore } from "../actions.js";
import { mutate, toast, useQuery } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { navigate, paths, type RunsTab } from "../router.js";
import { Avatar, timeAgo, useStore } from "../ui.js";

export type RunStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "stopped"
  | "canceled";

export interface RunSummary {
  id: string;
  kind: "decision" | "work";
  status: RunStatus;
  goal: string | null;
  modelTier: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  agent: { id: string; name: string; kind: "owner" | "agent" };
  issue: { identifier: string; title: string } | null;
  waitingOnRequest: { id: string; title: string; status: string } | null;
}

export const RUN_SUMMARY = `id kind status goal modelTier createdAt startedAt endedAt inputTokens outputTokens
  agent { id name kind } issue { identifier title } waitingOnRequest { id title status }`;

const ACTIVE: RunStatus[] = ["queued", "running", "needs_input"];
export const isActive = (status: RunStatus) => ACTIVE.includes(status);

const STATUS: Record<RunStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "text-muted" },
  running: { label: "Running", className: "text-accent" },
  needs_input: { label: "Needs input", className: "text-amber-400" },
  completed: { label: "Done", className: "text-emerald-400" },
  failed: { label: "Failed", className: "text-red-400" },
  stopped: { label: "Stopped", className: "text-faint" },
  canceled: { label: "Canceled", className: "text-faint" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${s.className}`}>
      {status === "running" && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      )}
      {s.label}
    </span>
  );
}

/** How many runs are underway, for the sidebar. */
export function useRunningCount(): number {
  const { data } = useQuery<{ runs: { nodes: { id: string }[] } }>(
    "{ runs(first: 100, filter: { status: [running] }) { nodes { id } } }",
    undefined,
    30_000,
  );
  return data?.runs.nodes.length ?? 0;
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

function describeRun(run: RunSummary) {
  if (run.kind === "decision") return "Deciding how to respond";
  return run.goal ?? "Working";
}

/** A compact list of runs, for the runs page, an issue or an agent. */
export function RunRows({
  runs,
  showAgent = true,
  showIssue = true,
}: {
  runs: RunSummary[];
  showAgent?: boolean;
  showIssue?: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => navigate(paths.run(run.id))}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-raised md:px-6"
          >
            {showAgent && <Avatar name={run.agent.name} kind={run.agent.kind} size={20} />}
            <div className="min-w-0 flex-1">
              <p className="truncate">
                {showAgent && <span className="font-medium">{run.agent.name} </span>}
                <span className={showAgent ? "text-muted" : ""}>{describeRun(run)}</span>
              </p>
              {(showIssue && run.issue) || run.waitingOnRequest ? (
                <p className="truncate text-[12px] text-faint">
                  {showIssue && run.issue && (
                    <>
                      {run.issue.identifier} {run.issue.title}
                    </>
                  )}
                  {run.waitingOnRequest?.status === "pending" && (
                    <span className="text-amber-400">
                      {showIssue && run.issue ? " · " : ""}Waiting for your approval
                    </span>
                  )}
                </p>
              ) : null}
            </div>
            <RunStatusBadge status={run.status} />
            <span className="w-14 shrink-0 text-right text-[12px] text-faint">
              {timeAgo(run.endedAt ?? run.startedAt ?? run.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Runs on an issue or by an agent, as a section of that page. Hidden when there are none. */
export function RunsSection({ issueId, agentId }: { issueId?: string; agentId?: string }) {
  const { data } = useQuery<{ runs: { nodes: RunSummary[] } }>(
    `query($filter: RunFilter) { runs(first: 20, filter: $filter) { nodes { ${RUN_SUMMARY} } } }`,
    { filter: issueId ? { issueId } : { agentId } },
  );
  const runs = data?.runs.nodes ?? [];
  if (runs.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 font-medium">Runs</h2>
      <div className="overflow-hidden rounded-lg border border-line [&_button]:md:px-4">
        <RunRows runs={runs} showAgent={!agentId} showIssue={!issueId} />
      </div>
    </section>
  );
}

export function RunsView({ tab }: { tab: RunsTab }) {
  const filter = tab === "active" ? { status: ACTIVE } : {};
  const { data, error } = useQuery<{ runs: { nodes: RunSummary[] } }>(
    `query($filter: RunFilter) { runs(first: 100, filter: $filter) { nodes { ${RUN_SUMMARY} } } }`,
    { filter },
    10_000,
  );
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <span className="mr-2 font-medium">Runs</span>
        <TabLink active={tab === "active"} to={paths.runs("active")}>
          Active
        </TabLink>
        <TabLink active={tab === "all"} to={paths.runs("all")}>
          All
        </TabLink>
        <a
          href={paths.machines()}
          onClick={(e) => {
            e.preventDefault();
            navigate(paths.machines());
          }}
          className="ml-auto text-muted hover:text-ink"
        >
          Machines
        </a>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-red-400">{error}</p>}
        {data && data.runs.nodes.length === 0 && (
          <p className="px-6 py-16 text-center text-muted">
            {tab === "active"
              ? "No agent is working right now. Assign an issue to an agent or mention one to wake it."
              : "No runs yet. Agents run on your machines; add one under Machines."}
          </p>
        )}
        {data && <RunRows runs={data.runs.nodes} />}
      </div>
    </div>
  );
}

function TabLink({ active, to, children }: { active: boolean; to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      className={`shrink-0 rounded-md border px-2 py-0.5 ${
        active ? "border-line bg-raised text-ink" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </a>
  );
}

interface RunDetail extends RunSummary {
  trigger: { notes?: { type: string }[] } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  stopReason: string | null;
  numTurns: number;
  machine: { id: string; name: string } | null;
  stoppedBy: { name: string } | null;
  logs: { seq: number; events: TranscriptEvent[] }[];
}

type TranscriptEvent = {
  type: string;
  at?: number;
  text?: string;
  name?: string;
  input?: string;
  error?: boolean;
  tool?: string;
  state?: string;
  requestId?: string;
  resource?: string | null;
  turns?: number;
};

const RUN_DETAIL = `query($id: String!) { run(id: $id) {
  ${RUN_SUMMARY} trigger result error stopReason numTurns
  machine { id name } stoppedBy { name }
  logs { seq events }
} }`;

const TRIGGERS: Record<string, string> = {
  issueAssignedToYou: "Assigned an issue",
  issueMention: "Mentioned in an issue",
  issueCommentMention: "Mentioned in a comment",
  issueNewComment: "A new comment",
  requestAnswered: "A request was answered",
  wake: "A scheduled check-in",
};

/** One run: what woke the agent, what it did step by step, and how it ended. Live while running. */
export function RunPage({ id }: { id: string }) {
  const [live, setLive] = useState(true);
  const { data, error } = useQuery<{ run: RunDetail }>(RUN_DETAIL, { id }, live ? 2000 : undefined);
  const workspace = useStore(workspaceStore);
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("");
  const run = data?.run;
  if (run && live && !isActive(run.status)) setLive(false);
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!run || !workspace) return null;
  const canStop = workspace.viewer.kind === "owner" && isActive(run.status);
  const events = run.logs.flatMap((batch) => batch.events);
  const triggers = (run.trigger?.notes ?? []).map((n) => TRIGGERS[n.type] ?? n.type);

  async function stop() {
    const result = await mutate(
      "mutation($id: String!, $reason: String!) { runStop(id: $id, reason: $reason) { success } }",
      { id, reason },
    );
    if (result) {
      toast(run?.status === "queued" ? "Run canceled" : "Stopping the run");
      setStopping(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-11 items-center gap-2 border-b border-line px-4 md:px-6">
        <button
          type="button"
          onClick={() => navigate(paths.runs())}
          className="text-muted hover:text-ink"
        >
          Runs
        </button>
        <span className="text-faint">›</span>
        <span className="truncate font-medium">
          {run.agent.name} · {run.kind === "decision" ? "Decision" : "Work"}
        </span>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <div className="flex items-start gap-3">
          <Avatar name={run.agent.name} kind={run.agent.kind} size={32} />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-medium">{describeRun(run)}</h1>
            <p className="mt-0.5 text-muted">
              <RunStatusBadge status={run.status} />
              {triggers.length > 0 && <span> · {triggers.join(", ")}</span>}
            </p>
          </div>
          {canStop && !stopping && (
            <button
              type="button"
              onClick={() => setStopping(true)}
              className="rounded-md border border-line px-3 py-1.5 text-red-400 hover:bg-raised"
            >
              Stop
            </button>
          )}
        </div>

        {stopping && (
          <div className="mt-4 rounded-lg border border-line p-4">
            <div className="block">
              <span className="mb-1.5 block text-muted">
                Why stop? {run.agent.name} reads this next time.
              </span>
              <div className="rounded-lg border border-line bg-panel px-3 py-2 focus-within:border-faint">
                <RichEditor
                  label="Reason"
                  autoFocus
                  value=""
                  onChange={setReason}
                  onSubmit={() => reason.trim() && void stop()}
                  onEscape={() => setStopping(false)}
                  className="min-h-10"
                />
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStopping(false)}
                className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
              >
                Back
              </button>
              <button
                type="button"
                disabled={!reason.trim()}
                onClick={stop}
                className="rounded-md bg-red-500 px-3 py-1.5 font-medium text-white disabled:opacity-40"
              >
                Stop run
              </button>
            </div>
          </div>
        )}

        <dl className="mt-5 grid grid-cols-[6rem_1fr] gap-y-2 rounded-lg border border-line bg-panel px-4 py-3">
          {run.issue && (
            <>
              <dt className="text-faint">Issue</dt>
              <dd>
                <button
                  type="button"
                  onClick={() => run.issue && navigate(paths.issue(run.issue.identifier))}
                  className="text-left hover:underline"
                >
                  <span className="text-faint">{run.issue.identifier}</span> {run.issue.title}
                </button>
              </dd>
            </>
          )}
          <dt className="text-faint">Machine</dt>
          <dd className="text-muted">{run.machine?.name ?? "Not picked up yet"}</dd>
          <dt className="text-faint">Model</dt>
          <dd className="text-muted">{run.modelTier}</dd>
          <dt className="text-faint">Usage</dt>
          <dd className="text-muted">
            {tokens(run.inputTokens)} in · {tokens(run.outputTokens)} out
            {run.numTurns ? ` · ${run.numTurns} turns` : ""}
          </dd>
          <dt className="text-faint">Started</dt>
          <dd className="text-muted">
            {run.startedAt ? timeAgo(run.startedAt) : `Queued ${timeAgo(run.createdAt)}`}
          </dd>
        </dl>

        {run.waitingOnRequest?.status === "pending" && (
          <button
            type="button"
            onClick={() => run.waitingOnRequest && navigate(paths.request(run.waitingOnRequest.id))}
            className="mt-4 block w-full rounded-lg border border-amber-400/40 bg-amber-400/5 px-4 py-3 text-left"
          >
            <span className="text-amber-400">Waiting for your approval:</span>{" "}
            {run.waitingOnRequest.title}
          </button>
        )}

        <Outcome run={run} />

        <section className="mt-8">
          <h2 className="mb-2 font-medium">Transcript</h2>
          {events.length === 0 ? (
            <p className="text-muted">
              {isActive(run.status) ? "Nothing yet. It appears here as the agent works." : "Empty."}
            </p>
          ) : (
            <ol className="space-y-2">
              {events.map((event, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the transcript only grows
                <TranscriptLine key={i} event={event} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function Outcome({ run }: { run: RunDetail }) {
  if (run.status === "stopped" || run.status === "canceled")
    return (
      <p className="mt-4 rounded-lg border border-line px-4 py-3 text-muted">
        {run.status === "stopped" ? "Stopped" : "Canceled"}
        {run.stoppedBy ? ` by ${run.stoppedBy.name}` : ""}
        {run.stopReason ? `: ${run.stopReason}` : ""}
      </p>
    );
  if (run.status === "failed")
    return (
      <p className="mt-4 rounded-lg border border-red-400/40 px-4 py-3 text-red-400">
        {run.error ?? "Failed"}
      </p>
    );
  const r = run.result;
  if (!r) return null;
  const text = (key: string) => (typeof r[key] === "string" ? (r[key] as string) : "");
  return (
    <div className="mt-4 rounded-lg border border-line px-4 py-3">
      {run.kind === "decision" ? (
        <>
          <p>
            Decided: <span className="font-medium">{text("action").replace("_", " ")}</span>
            {text("emoji") && ` ${text("emoji")}`}
          </p>
          {text("reason") && <p className="mt-1 text-muted">{text("reason")}</p>}
          {text("body") && <RichText source={text("body")} className="mt-2" />}
        </>
      ) : (
        <>
          <RichText source={text("summary")} />
          {text("question") && <p className="mt-2 text-amber-400">Asked: {text("question")}</p>}
        </>
      )}
    </div>
  );
}

function TranscriptLine({ event }: { event: TranscriptEvent }) {
  switch (event.type) {
    case "text":
      return (
        <li>
          <RichText source={event.text ?? ""} />
        </li>
      );
    case "tool":
      return (
        <li className="rounded-md bg-panel px-3 py-1.5 text-[13px]">
          <span className="font-medium">{(event.name ?? "").replace(/^mcp__life-os__/, "")}</span>{" "}
          <code className="break-all text-faint">{event.input}</code>
        </li>
      );
    case "tool_result":
      return (
        <li
          className={`max-h-32 overflow-hidden px-3 text-[12px] whitespace-pre-wrap ${event.error ? "text-red-400" : "text-faint"}`}
        >
          {event.text}
        </li>
      );
    case "permission":
      return (
        <li className="text-[13px] text-amber-400">
          {event.state === "waiting"
            ? `Asked for permission to use ${event.tool}`
            : `Permission for ${event.tool}: ${event.state}`}
        </li>
      );
    case "result":
      return (
        <li className="text-[12px] text-faint">
          Session ended after {event.turns ?? 0} {event.turns === 1 ? "turn" : "turns"}
        </li>
      );
    default:
      return <li className="text-[12px] text-faint">{event.type}</li>;
  }
}
