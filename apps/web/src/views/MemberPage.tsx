import { useEffect, useState } from "react";
import { workspaceStore } from "../actions.js";
import { mutate, useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { Avatar, openMenu, timeAgo, useStore } from "../ui.js";
import { FeedbackSection, Prose, RevisionList } from "./Learning.js";
import { RunsSection } from "./Runs.js";

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface MemberDetail {
  id: string;
  name: string;
  kind: "owner" | "agent";
  title: string | null;
  charter: string | null;
  lessons: string | null;
  active: boolean;
  isMe: boolean;
  createdAt: string;
  manager: { id: string; name: string } | null;
  directReports: {
    nodes: { id: string; name: string; kind: "owner" | "agent"; title: string | null }[];
  };
  apiTokens: Token[];
  runnerTags: string[];
  assignedIssues: { nodes: { id: string }[] };
}

const MEMBER_QUERY = `query($id: String!) { user(id: $id) {
  id name kind title charter lessons active isMe createdAt runnerTags
  manager { id name }
  directReports { nodes { id name kind title } }
  apiTokens { id name prefix createdAt lastUsedAt revokedAt }
  assignedIssues(first: 250, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id } }
} }`;

export function MemberPage({ id }: { id: string }) {
  const { data, error } = useQuery<{ user: MemberDetail }>(MEMBER_QUERY, { id });
  const workspace = useStore(workspaceStore);
  const member = data?.user;
  const [newToken, setNewToken] = useState<string | null>(null);

  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!member || !workspace) return null;
  const canEdit = workspace.viewer.kind === "owner";
  const update = (input: Record<string, unknown>) =>
    mutate(
      "mutation($id: String!, $input: UserUpdateInput!) { userUpdate(id: $id, input: $input) { success } }",
      {
        id: member.id,
        input,
      },
    );

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
        <span className="font-medium">{member.name}</span>
        {!member.active && (
          <span className="rounded bg-raised px-1.5 text-[12px] text-muted">Retired</span>
        )}
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <div className="flex items-center gap-3">
          <Avatar name={member.name} kind={member.kind} size={40} />
          <div className="min-w-0 flex-1">
            <EditableLine
              label="Name"
              value={member.name}
              disabled={!canEdit || !member.active}
              onSave={(name) => update({ name })}
              className="text-lg font-medium"
            />
            <EditableLine
              label="Title"
              value={member.title ?? ""}
              placeholder="Add a title"
              disabled={!canEdit || !member.active}
              onSave={(title) => update({ title })}
              className="text-muted"
            />
          </div>
          {canEdit && member.kind === "agent" && member.active && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Retire ${member.name}? Its tokens stop working and its reports move to its manager.`,
                  )
                ) {
                  void mutate("mutation($id: String!) { agentRetire(id: $id) { success } }", {
                    id: member.id,
                  });
                }
              }}
              className="rounded-md border border-line px-3 py-1.5 text-muted hover:text-red-400"
            >
              Retire
            </button>
          )}
        </div>

        <dl className="mt-6 grid grid-cols-[8rem_1fr] gap-y-2">
          <dt className="text-faint">Reports to</dt>
          <dd>
            {member.kind === "owner" ? (
              <span className="text-muted">No one</span>
            ) : (
              <button
                type="button"
                disabled={!canEdit || !member.active}
                onClick={() =>
                  openMenu({
                    placeholder: `Who does ${member.name} report to?`,
                    items: workspace.users.nodes
                      .filter((u) => u.id !== member.id)
                      .map((u) => ({
                        id: u.id,
                        label: u.name,
                        hint: u.title ?? undefined,
                        icon: <Avatar name={u.name} kind={u.kind} size={16} />,
                        checked: u.id === member.manager?.id,
                        onSelect: () => void update({ managerId: u.id }),
                      })),
                  })
                }
                className="rounded-md px-1 hover:bg-raised"
              >
                {member.manager?.name ?? "No one"}
              </button>
            )}
          </dd>
          <dt className="text-faint">Direct reports</dt>
          <dd className="flex flex-wrap gap-2">
            {member.directReports.nodes.length === 0 && <span className="text-muted">None</span>}
            {member.directReports.nodes.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => navigate(paths.member(r.id))}
                className="hover:underline"
              >
                {r.name}
              </button>
            ))}
          </dd>
          <dt className="text-faint">Open issues</dt>
          <dd className="text-muted">{member.assignedIssues.nodes.length}</dd>
          <dt className="text-faint">Joined</dt>
          <dd className="text-muted">{timeAgo(member.createdAt)}</dd>
          {member.kind === "agent" && (
            <>
              <dt className="text-faint">Runs on</dt>
              <dd>
                <EditableLine
                  label="Runner tags"
                  value={member.runnerTags.join(", ")}
                  placeholder="Any machine"
                  disabled={!canEdit || !member.active}
                  allowEmpty
                  onSave={(value) =>
                    update({
                      runnerTags: value
                        .split(",")
                        .map((t) => t.trim().toLowerCase())
                        .filter(Boolean),
                    })
                  }
                  className="text-muted"
                />
              </dd>
            </>
          )}
        </dl>

        {member.kind === "agent" && canEdit && member.active && <GiveWork agent={member} />}

        {member.kind === "agent" && (
          <section className="mt-8">
            <h2 className="mb-2 font-medium">Charter</h2>
            <p className="mb-2 text-faint">
              The agent's job: what it owns, how it works, and when it escalates to you.
            </p>
            <Prose
              label="Charter"
              value={member.charter ?? ""}
              placeholder="Responsibilities, ownership, and when to escalate…"
              disabled={!canEdit || !member.active}
              onSave={(charter) => update({ charter })}
            />
            <RevisionList subject="charter" entityId={member.id} />
          </section>
        )}

        {member.kind === "agent" && (
          <section className="mt-8">
            <h2 className="mb-2 font-medium">Lessons</h2>
            <p className="mb-2 text-faint">
              What {member.name} has learned, in its own words. It reads them on every run and
              rewrites them as it learns.
            </p>
            <Prose
              label="Lessons"
              value={member.lessons ?? ""}
              placeholder="Nothing learned yet."
              disabled={!canEdit || !member.active}
              onSave={(lessons) => update({ lessons })}
            />
            <RevisionList subject="lessons" entityId={member.id} />
          </section>
        )}

        {member.kind === "agent" && (
          <FeedbackSection agent={member} canGive={canEdit && member.active} />
        )}

        {member.kind === "agent" && <RunsSection agentId={member.id} />}

        {(canEdit || member.isMe) && (
          <section className="mt-8">
            <div className="mb-2 flex items-center">
              <h2 className="font-medium">API tokens</h2>
              {canEdit && member.active && (
                <button
                  type="button"
                  onClick={async () => {
                    const name = window.prompt(
                      "Name this token, e.g. the machine it runs on:",
                      "Claude Code",
                    );
                    if (!name) return;
                    const result = await mutate<{ apiTokenCreate: { token: string } }>(
                      "mutation($name: String!, $userId: String) { apiTokenCreate(name: $name, userId: $userId) { token } }",
                      { name, userId: member.id },
                    );
                    if (result) setNewToken(result.apiTokenCreate.token);
                  }}
                  className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-raised hover:text-ink"
                >
                  + New token
                </button>
              )}
            </div>
            {newToken && (
              <NewToken token={newToken} name={member.name} onDone={() => setNewToken(null)} />
            )}
            <div className="divide-y divide-line rounded-lg border border-line empty:hidden">
              {member.apiTokens.map((token) => (
                <div key={token.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate">{token.name}</span>
                  <code className="text-[12px] text-faint">{token.prefix}…</code>
                  <span className="text-[12px] text-faint max-sm:hidden">
                    {token.revokedAt
                      ? "Revoked"
                      : token.lastUsedAt
                        ? `Used ${timeAgo(token.lastUsedAt)}`
                        : "Never used"}
                  </span>
                  {canEdit && !token.revokedAt && (
                    <button
                      type="button"
                      onClick={() =>
                        void mutate(
                          "mutation($id: String!) { apiTokenRevoke(id: $id) { success } }",
                          { id: token.id },
                        )
                      }
                      className="text-faint hover:text-red-400"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function EditableLine(props: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  allowEmpty?: boolean;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  const changed = value.trim() !== props.value && (props.allowEmpty || value.trim());
  return (
    <input
      aria-label={props.label}
      value={value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => changed && props.onSave(value.trim())}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={`block w-full bg-transparent outline-none placeholder:text-faint ${props.className ?? ""}`}
    />
  );
}

/** The owner hands an agent a goal directly, optionally on an issue. */
function GiveWork({ agent }: { agent: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [issue, setIssue] = useState("");
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-md border border-line px-3 py-1.5 text-muted hover:bg-raised hover:text-ink"
      >
        Give {agent.name} work
      </button>
    );
  return (
    <form
      className="mt-4 rounded-lg border border-line p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await mutate<{ runCreate: { run: { id: string } } }>(
          "mutation($input: RunCreateInput!) { runCreate(input: $input) { run { id } } }",
          { input: { agentId: agent.id, goal, issueId: issue.trim() || null } },
        );
        if (result) navigate(paths.run(result.runCreate.run.id));
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-muted">What should {agent.name} get done?</span>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the goal is the first thing to type
          autoFocus
          aria-label="Goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 outline-none focus:border-faint"
        />
      </label>
      <label className="mt-3 flex items-center gap-2">
        <span className="text-muted">On issue</span>
        <input
          aria-label="On issue"
          value={issue}
          placeholder="Optional, e.g. FIT-3"
          onChange={(e) => setIssue(e.target.value)}
          className="w-40 rounded-md border border-line bg-panel px-2 py-1 outline-none placeholder:text-faint focus:border-faint"
        />
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-muted hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!goal.trim()}
          className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
        >
          Start
        </button>
      </div>
    </form>
  );
}

function NewToken({ token, name, onDone }: { token: string; name: string; onDone: () => void }) {
  const command = `claude mcp add --transport http life-os ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;
  return (
    <div className="mb-3 rounded-lg border border-accent/50 bg-accent/5 p-4">
      <p className="font-medium">Copy this token now. It won't be shown again.</p>
      <code className="mt-2 block break-all rounded bg-canvas px-3 py-2 text-[12px]">{token}</code>
      <p className="mt-3 text-muted">
        To work as {name} from Claude Code, add the company's MCP server:
      </p>
      <code className="mt-2 block break-all rounded bg-canvas px-3 py-2 text-[12px]">
        {command}
      </code>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(command)}
          className="rounded-md bg-accent px-3 py-1 text-white"
        >
          Copy command
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md px-3 py-1 text-muted hover:text-ink"
        >
          Done
        </button>
      </div>
    </div>
  );
}
