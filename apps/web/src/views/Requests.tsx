import { type ReactNode, useState } from "react";
import { workspaceStore } from "../actions.js";
import { graphql } from "../api.js";
import { invalidate, mutate, toast, useQuery } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import {
  Breadcrumbs,
  button,
  dialogField,
  listRow,
  PageHeader,
  PageTitle,
  pageHeading,
  TabLink,
  TabRow,
} from "../layout.js";
import { navigate, paths, type RequestsTab } from "../router.js";
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
import { mcpTool, READ_ONLY } from "./Access.js";

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
  mcpServer: {
    id: string;
    name: string;
    auth: "none" | "oauth" | "token";
    status: "pending" | "ready";
    pastesCallback: boolean;
  } | null;
  requester: Person & { title: string | null; teams: { nodes: { id: string; name: string }[] } };
}

const PENDING_COUNT = "{ requests(filter: { status: [pending] }) { nodes { id } } }";
const SUMMARY =
  "id title action status createdAt answeredAt requester { id name kind } grant { id }";

/** How many requests wait for the owner, for the sidebar badge. */
export function usePendingCount(): number {
  const { data } = useQuery<{ requests: { nodes: { id: string }[] } }>(PENDING_COUNT);
  return data?.requests.nodes.length ?? 0;
}

const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  canceled: "Canceled",
};

const STATUS_STYLE: Record<Status, string> = {
  pending: "text-warning",
  approved: "text-success",
  rejected: "text-critical",
  canceled: "text-faint",
};

export function RequestsView({ tab }: { tab: RequestsTab }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        tabs={
          <TabRow>
            <TabLink
              group="requests-tabs"
              active={tab === "pending"}
              to={paths.requests("pending")}
            >
              Pending
            </TabLink>
            <TabLink
              group="requests-tabs"
              active={tab === "answered"}
              to={paths.requests("answered")}
            >
              Answered
            </TabLink>
          </TabRow>
        }
      >
        <PageTitle>Approvals</PageTitle>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RequestList answered={tab === "answered"} />
      </div>
    </div>
  );
}

function RequestList({ answered }: { answered: boolean }) {
  const status = answered ? "[approved, rejected, canceled]" : "[pending]";
  const { data, error } = useQuery<{ requests: { nodes: RequestSummary[] } }>(
    `{ requests(first: 100, filter: { status: ${status} }) { nodes { ${SUMMARY} } } }`,
  );
  if (error) return <p className="p-6 text-critical">{error}</p>;
  if (!data) return <ListSkeleton rows={5} />;
  const rows = data.requests.nodes;
  if (rows.length === 0)
    return answered ? (
      <EmptyState
        icon="approval"
        title="Nothing answered yet"
        description="Requests you approve or reject are kept here, so you can see what agents were allowed to do."
      />
    ) : (
      <EmptyState
        icon="approval"
        title="Nothing waiting for you"
        description="Agents ask here before they spend money, send messages or do anything else that needs your yes."
      />
    );
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => navigate(paths.request(r.id))} className={listRow}>
            <Avatar name={r.requester.name} kind={r.requester.kind} size={20} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{r.title}</p>
              <p className="truncate text-[12px] text-faint">
                {r.requester.name} · <code>{r.action}</code>
              </p>
            </div>
            {answered && (
              <span className={`text-[12px] ${STATUS_STYLE[r.status]}`}>
                {r.grant ? "Always allowed" : STATUS_LABEL[r.status]}
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

/** Longer resources move from the sidebar into the body. */
const RESOURCE_SIDEBAR_MAX = 48;

const DETAIL = `query($id: String!) { request(id: $id) {
  ${SUMMARY} resource reason details answer used
  answeredBy { id name kind }
  issue { identifier title }
  mcpServer { id name auth status pastesCallback }
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
  const [what, setWhat] = useState<"tool" | "server" | "readOnly">("tool");
  const [token, setToken] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  const r = data?.request;
  if (!r || !workspace) return <PageSkeleton />;
  const canAnswer = workspace.viewer.kind === "owner" && r.status === "pending";
  const tool = mcpTool(r.action);
  // Only a server that isn't connected, or whose sign-in stopped working, needs signing in to.
  const server = r.mcpServer?.status === "pending" ? r.mcpServer : null;
  const connectError = failure ?? new URLSearchParams(window.location.search).get("error");

  /** Connects the server; answers where to sign in, if there is anywhere. */
  async function connect(variables: { token?: string; callbackUrl?: string }) {
    if (!server) return null;
    setBusy(true);
    setFailure(null);
    try {
      const result = await graphql<{ mcpServerConnect: { authorizationUrl: string | null } }>(
        "mutation($id: String!, $token: String, $callbackUrl: String) { mcpServerConnect(id: $id, token: $token, callbackUrl: $callbackUrl) { authorizationUrl } }",
        { id: server.id, ...variables },
      );
      invalidate();
      return result.mcpServerConnect.authorizationUrl;
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Signs in from a new tab, opened before awaiting so phones don't block it; this page stays. */
  async function signInElsewhere() {
    const tab = window.open("", "_blank");
    const url = await connect({});
    if (url) tab?.location.assign(url);
    else tab?.close();
  }

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
          ...(tool
            ? { action: what === "tool" ? r.action : tool.all, anyResource: what !== "readOnly" }
            : { anyResource }),
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

  // The resource is what an approval or grant covers, so it shows once: not at all when the
  // details already show it word for word (the runner's Bash and file requests), else in the
  // sidebar if it's short, or in the body if it's too long to read there, like a Bash command.
  const resourceInDetails = r.resource !== null && !!r.details?.includes(r.resource);
  const longResource =
    r.resource !== null && (r.resource.length > RESOURCE_SIDEBAR_MAX || r.resource.includes("\n"));
  const statusLabel =
    r.status === "approved"
      ? r.grant
        ? "Always allowed"
        : "Approved"
      : r.status === "pending"
        ? "Waiting for you"
        : r.status === "rejected"
          ? "Rejected"
          : "Canceled";
  return (
    <div className="flex h-full min-h-0 animate-fade-in flex-col">
      <PageHeader>
        <Breadcrumbs
          trail={[
            {
              label: "Approvals",
              to: paths.requests(r.status === "pending" ? "pending" : "answered"),
            },
          ]}
        >
          <span className="truncate">{r.title}</span>
        </Breadcrumbs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailLayout
          head={
            <>
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
              <h1 className={`mt-3 ${pageHeading} [overflow-wrap:anywhere]`}>{r.title}</h1>
              <RichText source={r.reason} className="mt-3" />
              {longResource && !resourceInDetails && (
                <section className="mt-5">
                  <h2 className="mb-1.5 text-[12px] font-medium text-faint">On</h2>
                  <pre className="overflow-x-auto rounded-lg border border-line bg-raised px-3 py-2 text-[12px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
                    {r.resource}
                  </pre>
                </section>
              )}
              {/*
               * With the reason, not below the properties: on a phone the properties stack between
               * head and body, which split what the agent asks from exactly what it will do.
               */}
              {r.details && <RichText source={r.details} className="mt-5" />}
            </>
          }
          side={
            <PropertyList>
              <Property label="Status">
                <span className={STATUS_STYLE[r.status]}>{statusLabel}</span>
              </Property>
              <Property label="Permission">
                <code className="break-all text-ink">{r.action}</code>
              </Property>
              {r.resource && !longResource && !resourceInDetails && (
                <Property label="On">
                  <code className="text-ink [overflow-wrap:anywhere]">{r.resource}</code>
                </Property>
              )}
              {r.issue && (
                <Property label="Issue" control>
                  <button
                    type="button"
                    onClick={() => r.issue && navigate(paths.issue(r.issue.identifier))}
                    className={propertyButton}
                  >
                    <span className="truncate">
                      <span className="text-faint">{r.issue.identifier}</span> {r.issue.title}
                    </span>
                  </button>
                </Property>
              )}
            </PropertyList>
          }
        >
          <div className="space-y-6">
            {canAnswer && server && (
              <section className="rounded-lg border border-line p-4">
                {connectError && <p className="mb-3 text-critical">{connectError}</p>}
                {server.pastesCallback ? (
                  <div className="space-y-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={signInElsewhere}
                      className={button("primary")}
                    >
                      Sign in to {server.name}
                    </button>
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        connect({ callbackUrl });
                      }}
                    >
                      <input
                        aria-label="Paste the address you land on"
                        placeholder="Paste the address you land on"
                        autoComplete="off"
                        value={callbackUrl}
                        onChange={(e) => setCallbackUrl(e.target.value)}
                        className={`${dialogField} flex-1`}
                      />
                      <button
                        type="submit"
                        disabled={busy || !callbackUrl}
                        className={button("primary")}
                      >
                        Connect
                      </button>
                    </form>
                  </div>
                ) : server.auth === "oauth" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const url = await connect({});
                      if (url) window.location.assign(url);
                    }}
                    className={button("primary")}
                  >
                    Sign in to {server.name}
                  </button>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      connect({ token });
                    }}
                  >
                    <div className="flex gap-2">
                      <input
                        type="password"
                        aria-label="Token"
                        autoComplete="off"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        className={`${dialogField} flex-1`}
                      />
                      <button type="submit" disabled={busy || !token} className={button("primary")}>
                        Connect
                      </button>
                    </div>
                  </form>
                )}
              </section>
            )}

            {canAnswer && mode === "idle" && (
              <div className="sticky bottom-0 grid grid-cols-3 gap-2 bg-canvas py-3">
                <button
                  type="button"
                  disabled={busy || !!server}
                  onClick={approveOnce}
                  className="rounded-lg bg-accent px-3 py-3 font-medium text-on-accent disabled:opacity-40"
                >
                  Approve once
                </button>
                <button
                  type="button"
                  disabled={busy || !!server}
                  onClick={() => setMode("always")}
                  className="rounded-lg border border-line px-3 py-3 font-medium hover:bg-raised"
                >
                  Always allow
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setMode("reject")}
                  className="rounded-lg border border-line px-3 py-3 font-medium text-critical hover:bg-raised"
                >
                  Reject
                </button>
              </div>
            )}

            {canAnswer && mode === "always" && (
              <fieldset className="rounded-lg border border-line p-4">
                <legend className="px-1 font-medium">
                  Always allow {tool ? "" : `${r.action} `}for
                </legend>
                {tool && (
                  <div className="mb-3 space-y-2 border-b border-line pb-3">
                    <ScopeOption name="what" value="tool" current={what} onChange={setWhat}>
                      This tool
                    </ScopeOption>
                    <ScopeOption name="what" value="server" current={what} onChange={setWhat}>
                      All {tool.server} tools
                    </ScopeOption>
                    {r.resource === READ_ONLY && (
                      <ScopeOption name="what" value="readOnly" current={what} onChange={setWhat}>
                        Read-only {tool.server} tools
                      </ScopeOption>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <ScopeOption value="user" current={scope} onChange={setScope}>
                    {r.requester.name} only
                  </ScopeOption>
                  {r.requester.teams.nodes.map((t) => (
                    <ScopeOption
                      key={t.id}
                      value={`team:${t.id}`}
                      current={scope}
                      onChange={setScope}
                    >
                      Everyone in {t.name}
                    </ScopeOption>
                  ))}
                  <ScopeOption value="everyone" current={scope} onChange={setScope}>
                    Every agent
                  </ScopeOption>
                </div>
                {r.resource && !tool && (
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
                  <button type="button" onClick={() => setMode("idle")} className={button("ghost")}>
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={alwaysAllow}
                    className={button("primary")}
                  >
                    Always allow
                  </button>
                </div>
              </fieldset>
            )}

            {canAnswer && mode === "reject" && (
              <div>
                <div className="block">
                  <span className="mb-1.5 block text-muted">
                    Why not? {r.requester.name} learns from this.
                  </span>
                  <div className="rounded-lg border border-line bg-panel px-3 py-2 focus-within:border-faint">
                    <RichEditor
                      label="Why not?"
                      autoFocus
                      value=""
                      onChange={setReason}
                      onEscape={() => setMode("idle")}
                      className="min-h-14"
                    />
                  </div>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" onClick={() => setMode("idle")} className={button("ghost")}>
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={busy || !reason.trim()}
                    onClick={reject}
                    className={button("destructive")}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}

            {r.status !== "pending" && (
              <div className="rounded-lg border border-line px-4 py-3">
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
                {r.answer && <RichText source={r.answer} className="mt-1 text-muted" />}
              </div>
            )}
          </div>
        </DetailLayout>
      </div>
    </div>
  );
}

function ScopeOption<T extends string>({
  name = "scope",
  value,
  current,
  onChange,
  children,
}: {
  name?: string;
  value: T;
  current: string;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name={name}
        checked={current === value}
        onChange={() => onChange(value)}
      />
      {children}
    </label>
  );
}
