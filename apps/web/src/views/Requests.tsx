import { type ReactNode, useState } from "react";
import { workspaceStore } from "../actions.js";
import { mutate, toast, useQuery } from "../data.js";
import { navigate, paths, type RequestsTab } from "../router.js";
import { Avatar, timeAgo, useStore } from "../ui.js";

type Status = "pending" | "approved" | "rejected" | "canceled";
type Person = { id: string; name: string; kind: "owner" | "agent" };

interface RequestSummary {
  id: string;
  title: string;
  action: string;
  status: Status;
  createdAt: string;
  answeredAt: string | null;
  requester: Person;
  grant: { id: string } | null;
}

interface RequestDetail extends RequestSummary {
  resource: string | null;
  reason: string;
  details: string | null;
  answer: string | null;
  used: boolean;
  answeredBy: Person | null;
  issue: { identifier: string; title: string } | null;
  requester: Person & { title: string | null; teams: { nodes: { id: string; name: string }[] } };
}

interface Grant {
  id: string;
  action: string;
  resource: string | null;
  scope: "user" | "team" | "everyone";
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  user: Person | null;
  team: { id: string; name: string } | null;
}

const PENDING_COUNT = "{ requests(filter: { status: [pending] }) { nodes { id } } }";
const SUMMARY =
  "id title action status createdAt answeredAt requester { id name kind } grant { id }";

/** How many requests wait for the owner, for the sidebar badge. */
export function usePendingCount(): number {
  const { data } = useQuery<{ requests: { nodes: { id: string }[] } }>(PENDING_COUNT);
  return data?.requests.nodes.length ?? 0;
}

const STATUS_STYLE: Record<Status, string> = {
  pending: "text-amber-400",
  approved: "text-emerald-400",
  rejected: "text-red-400",
  canceled: "text-faint",
};

export function RequestsView({ tab }: { tab: RequestsTab }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <span className="mr-2 font-medium">Approvals</span>
        <TabLink active={tab === "pending"} to={paths.requests("pending")}>
          Pending
        </TabLink>
        <TabLink active={tab === "answered"} to={paths.requests("answered")}>
          Answered
        </TabLink>
        <TabLink active={tab === "grants"} to={paths.requests("grants")}>
          Always allowed
        </TabLink>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "grants" ? <GrantList /> : <RequestList answered={tab === "answered"} />}
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

function RequestList({ answered }: { answered: boolean }) {
  const status = answered ? "[approved, rejected, canceled]" : "[pending]";
  const { data, error } = useQuery<{ requests: { nodes: RequestSummary[] } }>(
    `{ requests(first: 100, filter: { status: ${status} }) { nodes { ${SUMMARY} } } }`,
  );
  if (error) return <p className="p-6 text-red-400">{error}</p>;
  if (!data) return null;
  const rows = data.requests.nodes;
  if (rows.length === 0)
    return (
      <p className="px-6 py-16 text-center text-muted">
        {answered
          ? "Nothing answered yet."
          : "Nothing waiting for you. Agents ask here when they need your approval."}
      </p>
    );
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => navigate(paths.request(r.id))}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised md:px-6"
          >
            <Avatar name={r.requester.name} kind={r.requester.kind} size={24} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{r.title}</p>
              <p className="truncate text-[12px] text-faint">
                {r.requester.name} · <code>{r.action}</code>
              </p>
            </div>
            {answered && (
              <span className={`text-[12px] ${STATUS_STYLE[r.status]}`}>
                {r.grant ? "always allowed" : r.status}
              </span>
            )}
            <span className="shrink-0 text-[12px] text-faint">
              {timeAgo(r.answeredAt ?? r.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function GrantList() {
  const workspace = useStore(workspaceStore);
  const { data, error } = useQuery<{ grants: { nodes: Grant[] } }>(
    "{ grants(first: 200) { nodes { id action resource scope useCount lastUsedAt createdAt user { id name kind } team { id name } } } }",
  );
  if (error) return <p className="p-6 text-red-400">{error}</p>;
  if (!data) return null;
  const isOwner = workspace?.viewer.kind === "owner";
  if (data.grants.nodes.length === 0)
    return (
      <p className="px-6 py-16 text-center text-muted">
        Nothing is always allowed yet. Choose "Always allow" on a request to let an agent do it
        without asking.
      </p>
    );
  return (
    <ul className="divide-y divide-line">
      {data.grants.nodes.map((g) => (
        <li key={g.id} className="flex items-center gap-3 px-4 py-3 md:px-6">
          <div className="min-w-0 flex-1">
            <p className="truncate">
              <span className="font-medium">
                {g.scope === "everyone" ? "Everyone" : (g.user?.name ?? g.team?.name ?? "?")}
              </span>{" "}
              <span className="text-muted">may</span> <code>{g.action}</code>
              {g.resource && (
                <>
                  {" "}
                  <span className="text-muted">on</span> <code>{g.resource}</code>
                </>
              )}
            </p>
            <p className="text-[12px] text-faint">
              Used {g.useCount === 1 ? "once" : `${g.useCount} times`}
              {g.lastUsedAt ? `, last ${timeAgo(g.lastUsedAt)}` : ""} · granted{" "}
              {timeAgo(g.createdAt)}
            </p>
          </div>
          {isOwner && (
            <button
              type="button"
              onClick={async () => {
                if (
                  await mutate("mutation($id: String!) { grantRevoke(id: $id) { success } }", {
                    id: g.id,
                  })
                )
                  toast("Grant revoked");
              }}
              className="rounded-md border border-line px-2.5 py-1 text-muted hover:text-red-400"
            >
              Revoke
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const DETAIL = `query($id: String!) { request(id: $id) {
  ${SUMMARY} resource reason details answer used
  answeredBy { id name kind }
  issue { identifier title }
  requester { id name kind title teams { nodes { id name } } }
} }`;

/** One request on one screen: where a push notification lands, so approving is two taps. */
export function RequestPage({ id }: { id: string }) {
  const { data, error } = useQuery<{ request: RequestDetail }>(DETAIL, { id });
  const workspace = useStore(workspaceStore);
  const [mode, setMode] = useState<"idle" | "always" | "reject">("idle");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<string>("user");
  const [anyResource, setAnyResource] = useState(false);

  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  const r = data?.request;
  if (!r || !workspace) return null;
  const canAnswer = workspace.viewer.kind === "owner" && r.status === "pending";

  async function answer(query: string, variables: Record<string, unknown>, done: string) {
    setBusy(true);
    const result = await mutate(query, { id, ...variables });
    setBusy(false);
    if (result) {
      toast(done);
      setMode("idle");
    }
  }
  const approveOnce = () =>
    answer("mutation($id: String!) { requestApprove(id: $id) { success } }", {}, "Approved once");
  const alwaysAllow = () =>
    answer(
      "mutation($id: String!, $always: AlwaysAllowInput!) { requestApprove(id: $id, alwaysAllow: $always) { success } }",
      {
        always: {
          scope: scope.startsWith("team:") ? "team" : scope,
          teamId: scope.startsWith("team:") ? scope.slice(5) : null,
          anyResource,
        },
      },
      "Always allowed",
    );
  const reject = () =>
    answer(
      "mutation($id: String!, $reason: String!) { requestReject(id: $id, reason: $reason) { success } }",
      { reason },
      "Rejected",
    );

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-11 items-center gap-2 border-b border-line px-4 md:px-6">
        <button
          type="button"
          onClick={() => navigate(paths.requests(r.status === "pending" ? "pending" : "answered"))}
          className="text-muted hover:text-ink"
        >
          Approvals
        </button>
        <span className="text-faint">›</span>
        <span className="truncate font-medium">{r.title}</span>
      </header>
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-6">
        <div className="flex items-center gap-2 text-muted">
          <Avatar name={r.requester.name} kind={r.requester.kind} size={20} />
          <span>
            <button
              type="button"
              onClick={() => navigate(paths.member(r.requester.id))}
              className="text-ink hover:underline"
            >
              {r.requester.name}
            </button>{" "}
            asks · {timeAgo(r.createdAt)}
          </span>
        </div>
        <h1 className="mt-3 text-xl font-medium">{r.title}</h1>
        <p className="mt-3 whitespace-pre-wrap leading-relaxed">{r.reason}</p>

        <dl className="mt-5 grid grid-cols-[6rem_1fr] gap-y-2 rounded-lg border border-line bg-panel px-4 py-3">
          <dt className="text-faint">Permission</dt>
          <dd>
            <code>{r.action}</code>
          </dd>
          {r.resource && (
            <>
              <dt className="text-faint">On</dt>
              <dd className="break-all">
                <code>{r.resource}</code>
              </dd>
            </>
          )}
          {r.issue && (
            <>
              <dt className="text-faint">Issue</dt>
              <dd>
                <button
                  type="button"
                  onClick={() => r.issue && navigate(paths.issue(r.issue.identifier))}
                  className="text-left hover:underline"
                >
                  <span className="text-faint">{r.issue.identifier}</span> {r.issue.title}
                </button>
              </dd>
            </>
          )}
        </dl>
        {r.details && (
          <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-canvas px-4 py-3 text-[13px] whitespace-pre-wrap">
            {r.details}
          </pre>
        )}

        {canAnswer && mode === "idle" && (
          <div className="sticky bottom-0 mt-6 grid grid-cols-3 gap-2 bg-canvas py-3">
            <button
              type="button"
              disabled={busy}
              onClick={approveOnce}
              className="rounded-lg bg-accent px-3 py-3 font-medium text-white disabled:opacity-40"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode("always")}
              className="rounded-lg border border-line px-3 py-3 font-medium hover:bg-raised"
            >
              Always allow
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode("reject")}
              className="rounded-lg border border-line px-3 py-3 font-medium text-red-400 hover:bg-raised"
            >
              Reject
            </button>
          </div>
        )}

        {canAnswer && mode === "always" && (
          <fieldset className="mt-6 rounded-lg border border-line p-4">
            <legend className="px-1 font-medium">Always allow {r.action} for</legend>
            <div className="space-y-2">
              <ScopeOption value="user" current={scope} onChange={setScope}>
                {r.requester.name} only
              </ScopeOption>
              {r.requester.teams.nodes.map((t) => (
                <ScopeOption key={t.id} value={`team:${t.id}`} current={scope} onChange={setScope}>
                  Everyone in {t.name}
                </ScopeOption>
              ))}
              <ScopeOption value="everyone" current={scope} onChange={setScope}>
                Every agent
              </ScopeOption>
            </div>
            {r.resource && (
              <label className="mt-3 flex items-center gap-2 text-muted">
                <input
                  type="checkbox"
                  checked={anyResource}
                  onChange={(e) => setAnyResource(e.target.checked)}
                />
                On anything, not only <code className="break-all">{r.resource}</code>
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMode("idle")}
                className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={alwaysAllow}
                className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
              >
                Always allow
              </button>
            </div>
          </fieldset>
        )}

        {canAnswer && mode === "reject" && (
          <div className="mt-6">
            <label className="block">
              <span className="mb-1.5 block text-muted">
                Why not? {r.requester.name} learns from this.
              </span>
              <textarea
                // biome-ignore lint/a11y/noAutofocus: the reason is the only thing to type
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-line bg-panel px-3 py-2 outline-none focus:border-faint"
              />
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMode("idle")}
                className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || !reason.trim()}
                onClick={reject}
                className="rounded-md bg-red-500 px-3 py-1.5 font-medium text-white disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          </div>
        )}

        {r.status !== "pending" && (
          <div className="mt-6 rounded-lg border border-line px-4 py-3">
            <p className={STATUS_STYLE[r.status]}>
              {r.status === "approved"
                ? r.grant
                  ? "Always allowed"
                  : r.used
                    ? "Approved once, and used"
                    : "Approved once"
                : r.status === "rejected"
                  ? "Rejected"
                  : "Canceled by the agent"}
              {r.answeredBy && r.answeredAt && (
                <span className="text-faint">
                  {" "}
                  by {r.answeredBy.name} {timeAgo(r.answeredAt)}
                </span>
              )}
            </p>
            {r.answer && <p className="mt-1 whitespace-pre-wrap text-muted">{r.answer}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function ScopeOption({
  value,
  current,
  onChange,
  children,
}: {
  value: string;
  current: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name="scope"
        checked={current === value}
        onChange={() => onChange(value)}
      />
      {children}
    </label>
  );
}
