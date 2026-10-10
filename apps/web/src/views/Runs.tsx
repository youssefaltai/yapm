import { useEffect, useRef, useState } from "react";
import { workspaceStore } from "../actions.js";
import { graphql } from "../api.js";
import { mutate, onInvalidate, toast, useQuery } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { Emoji } from "../emoji/Emoji.js";
import {
  Breadcrumbs,
  button,
  listRow,
  PageHeader,
  PageTitle,
  pageHeading,
  Section,
  TabLink,
  TabRow,
} from "../layout.js";
import { navigate, paths, type RunsTab } from "../router.js";
import { EmptyState, ListSkeleton, PageSkeleton } from "../states.js";
import {
  Avatar,
  DetailLayout,
  Property,
  PropertyList,
  propertyButton,
  timeAgo,
  useStore,
} from "../ui.js";
import { Transcript, type TranscriptEvent } from "./Transcript.js";

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
  needs_input: { label: "Needs input", className: "text-warning" },
  completed: { label: "Done", className: "text-success" },
  failed: { label: "Failed", className: "text-critical" },
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
  embedded = false,
}: {
  runs: RunSummary[];
  showAgent?: boolean;
  showIssue?: boolean;
  /** Inside a bordered box on another page, rather than filling the runs page. */
  embedded?: boolean;
}) {
  return (
    <ul className={embedded ? "divide-y divide-line" : ""}>
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => navigate(paths.run(run.id))}
            className={
              embedded
                ? "flex w-full animate-fade-in items-center gap-3 px-4 py-2.5 text-left hover:bg-raised"
                : listRow
            }
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
                    <span className="text-warning">
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

/** The runs for an agent's page, with the page's own query, so the page renders once with them. */
export const AGENT_RUNS = `query($filter: RunFilter) { runs(first: 20, filter: $filter) { nodes { ${RUN_SUMMARY} } } }`;

/** Runs on an issue or by an agent, as a section of that page. Hidden when there are none. */
export function RunsSection({
  runs,
  showAgent = true,
  showIssue = true,
}: {
  runs: RunSummary[];
  showAgent?: boolean;
  showIssue?: boolean;
}) {
  if (runs.length === 0) return null;
  return (
    <Section title="Runs">
      <div className="overflow-hidden rounded-lg border border-line">
        <RunRows runs={runs} showAgent={showAgent} showIssue={showIssue} embedded />
      </div>
    </Section>
  );
}

/** The runs page's tabs; Machines is one of them, so the header holds still between them. */
export function RunsTabs({ active }: { active: RunsTab | "machines" }) {
  return (
    <TabRow>
      <TabLink group="runs-tabs" active={active === "active"} to={paths.runs("active")}>
        Active
      </TabLink>
      <TabLink group="runs-tabs" active={active === "all"} to={paths.runs("all")}>
        All
      </TabLink>
      <TabLink group="runs-tabs" active={active === "machines"} to={paths.machines()}>
        Machines
      </TabLink>
    </TabRow>
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
      <PageHeader tabs={<RunsTabs active={tab} />}>
        <PageTitle>Runs</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-critical">{error}</p>}
        {!data && !error && <ListSkeleton rows={6} />}
        {data &&
          data.runs.nodes.length === 0 &&
          (tab === "active" ? (
            <EmptyState
              icon="run"
              title="No agent is working right now"
              description="Assign an issue to an agent, or mention one in a comment, to wake it."
              secondary={{ label: "See all runs", onClick: () => navigate(paths.runs("all")) }}
            />
          ) : (
            <EmptyState
              icon="run"
              title="No runs yet"
              description="Agents run on your own machines. Add one, and runs show up here as agents work."
              action={{ label: "Set up a machine", onClick: () => navigate(paths.machines()) }}
            />
          ))}
        {data && <RunRows runs={data.runs.nodes} />}
      </div>
    </div>
  );
}

interface RunDetail extends RunSummary {
  trigger: { notes?: { type: string }[] } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  stopReason: string | null;
  numTurns: number;
  model: string | null;
  effort: string | null;
  routeRule: string | null;
  costUsd: number;
  machine: { id: string; name: string } | null;
  stoppedBy: { name: string } | null;
}

const RUN_DETAIL = `query($id: String!) { run(id: $id) {
  ${RUN_SUMMARY} trigger result error stopReason numTurns model effort routeRule costUsd
  machine { id name } stoppedBy { name }
} }`;

type LogBatch = { seq: number; events: TranscriptEvent[] };

const RUN_LOGS = `query($id: String!, $afterSeq: Int) { run(id: $id) { logs(afterSeq: $afterSeq) { seq events } } }`;

/**
 * A run's transcript, fetching only the batches after the last one here: while live, whenever
 * views refresh, and once more when it ends. The hub sends at most 200 at a time.
 */
function useRunLogs(id: string, live: boolean) {
  const [logs, setLogs] = useState<LogBatch[]>([]);
  const last = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        let page: LogBatch[];
        do {
          const variables = { id, afterSeq: last.current };
          const data = await graphql<{ run: { logs: LogBatch[] } }>(RUN_LOGS, variables, {
            quiet: true,
          });
          page = data.run.logs;
          const newest = page.at(-1);
          if (!alive || !newest) return;
          const from = last.current ?? -1;
          last.current = newest.seq;
          setLogs((logs) => [...logs, ...page.filter((batch) => batch.seq > from)]);
        } while (page.length === 200);
      } catch {
        // The next poll or refresh tries again.
      } finally {
        busy = false;
      }
    };
    load();
    const timer = live ? setInterval(load, 2000) : undefined;
    const off = onInvalidate(load);
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [id, live]);
  return logs;
}

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
  const logs = useRunLogs(id, live);
  const workspace = useStore(workspaceStore);
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("");
  const run = data?.run;
  if (run && live && !isActive(run.status)) setLive(false);
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!run || !workspace) return <PageSkeleton />;
  const canStop = workspace.viewer.kind === "owner" && isActive(run.status);
  const events = logs.flatMap((batch) => batch.events);
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
    <div className="flex h-full min-h-0 animate-fade-in flex-col">
      <PageHeader
        actions={
          canStop &&
          !stopping && (
            <button
              type="button"
              onClick={() => setStopping(true)}
              className={button("danger", "sm")}
            >
              Stop
            </button>
          )
        }
      >
        <Breadcrumbs trail={[{ label: "Runs", to: paths.runs() }]}>
          <span className="truncate">
            {run.agent.name} · {run.kind === "decision" ? "Decision" : "Work"}
          </span>
        </Breadcrumbs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailLayout
          head={
            <>
              <div className="flex items-center gap-3">
                <Avatar name={run.agent.name} kind={run.agent.kind} size={32} />
                <h1 className={`min-w-0 flex-1 ${pageHeading}`}>{describeRun(run)}</h1>
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
                      className={button("ghost")}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={!reason.trim()}
                      onClick={stop}
                      className={button("destructive")}
                    >
                      Stop run
                    </button>
                  </div>
                </div>
              )}

              {run.waitingOnRequest?.status === "pending" && (
                <button
                  type="button"
                  onClick={() =>
                    run.waitingOnRequest && navigate(paths.request(run.waitingOnRequest.id))
                  }
                  className="mt-4 block w-full rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-left"
                >
                  <span className="text-warning">Waiting for your approval:</span>{" "}
                  {run.waitingOnRequest.title}
                </button>
              )}

              <Outcome run={run} />
            </>
          }
          side={
            <>
              <PropertyList>
                <Property label="Status">
                  <RunStatusBadge status={run.status} />
                </Property>
                <Property label="Agent" control>
                  <button
                    type="button"
                    onClick={() => navigate(paths.member(run.agent.id))}
                    className={propertyButton}
                  >
                    <Avatar name={run.agent.name} kind={run.agent.kind} size={16} />
                    {run.agent.name}
                  </button>
                </Property>
                {run.issue && (
                  <Property label="Issue" control>
                    <button
                      type="button"
                      onClick={() => run.issue && navigate(paths.issue(run.issue.identifier))}
                      className={propertyButton}
                    >
                      <span className="truncate">
                        <span className="text-faint">{run.issue.identifier}</span> {run.issue.title}
                      </span>
                    </button>
                  </Property>
                )}
                {triggers.length > 0 && <Property label="Woken by">{triggers.join(", ")}</Property>}
                <Property label="Machine" control={!!run.machine}>
                  {run.machine ? (
                    <button
                      type="button"
                      onClick={() => run.machine && navigate(paths.machine(run.machine.id))}
                      className={propertyButton}
                    >
                      <span className="truncate">{run.machine.name}</span>
                    </button>
                  ) : (
                    <span className="text-faint">Not picked up yet</span>
                  )}
                </Property>
                <Property label="Started">
                  {run.startedAt ? (
                    timeAgo(run.startedAt)
                  ) : (
                    <span className="text-faint">Not yet, queued {timeAgo(run.createdAt)}</span>
                  )}
                </Property>
              </PropertyList>
              <PropertyList title="Model and usage">
                <Property label="Model">
                  <span className="truncate">{run.model ?? run.modelTier}</span>
                </Property>
                <Property label="Effort">{run.effort ?? "Default"}</Property>
                {run.routeRule && <Property label="Route">{run.routeRule}</Property>}
                <Property label="Tokens">
                  {tokens(run.inputTokens)} in · {tokens(run.outputTokens)} out
                </Property>
                {run.numTurns ? <Property label="Turns">{run.numTurns}</Property> : null}
                {run.costUsd ? (
                  <Property label="Cost">
                    ${run.costUsd.toFixed(3)}
                    <span className="text-faint">at API prices</span>
                  </Property>
                ) : null}
              </PropertyList>
            </>
          }
        >
          <Section title="Transcript">
            {events.length === 0 ? (
              <p className="text-muted">
                {isActive(run.status)
                  ? "Nothing yet. It appears here as the agent works."
                  : "Empty."}
              </p>
            ) : (
              <Transcript events={events} active={isActive(run.status)} />
            )}
          </Section>
        </DetailLayout>
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
      <p className="mt-4 rounded-lg border border-critical/40 px-4 py-3 text-critical">
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
            {text("emoji") && (
              <>
                {" "}
                <Emoji value={text("emoji")} />
              </>
            )}
          </p>
          {text("reason") && <p className="mt-1 text-muted">{text("reason")}</p>}
          {text("body") && <RichText source={text("body")} className="mt-2" />}
        </>
      ) : (
        <>
          <RichText source={text("summary")} />
          {text("question") && <p className="mt-2 text-warning">Asked: {text("question")}</p>}
        </>
      )}
    </div>
  );
}
