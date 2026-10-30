import { type FormEvent, useState } from "react";
import { workspaceStore } from "../actions.js";
import { mutate, useQuery } from "../data.js";
import { button, field } from "../layout.js";
import { timeAgo, useStore } from "../ui.js";

/** The resource the runner asks with for a tool that only reads. */
export const READ_ONLY = "readOnly";

interface Grant {
  id: string;
  action: string;
  resource: string | null;
  scope: "user" | "team" | "everyone";
  note: string | null;
  useCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  user: { name: string } | null;
  team: { name: string } | null;
}

const GRANTS = `query($filter: GrantFilter, $revoked: Boolean) {
  grants(first: 200, filter: $filter, includeRevoked: $revoked) { nodes {
    id action resource scope note useCount lastUsedAt revokedAt user { name } team { name }
  } }
}`;

/** `tool:slack__slack_read_channel` is Slack's `read_channel`; null for other actions. */
export function mcpTool(action: string) {
  const [, server = "", tool = ""] = /^tool:(.+?)__(.+)$/.exec(action) ?? [];
  if (!server) return null;
  return {
    /** The action covering every tool of the server. */
    all: `tool:${server}__*`,
    server: `${server[0]?.toUpperCase()}${server.slice(1)}`,
    tool: tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool,
  };
}

/** A grant reads as a line under its server, or under its action for anything else. */
function describe(g: Grant): { group: string; label: string } {
  const mcp = mcpTool(g.action);
  const readOnly = g.resource === READ_ONLY;
  if (!mcp) return { group: g.action.replace(/^tool:/, ""), label: g.resource ?? "Anything" };
  if (mcp.tool === "*")
    return { group: mcp.server, label: readOnly ? "Read-only tools" : "All tools" };
  return { group: mcp.server, label: readOnly ? `${mcp.tool} (read-only)` : mcp.tool };
}

/**
 * What an agent or a team may do without asking: grants grouped by server or action, with how
 * they're used. The owner adds, edits and revokes them here.
 */
export function AccessPanel(subject: { userId: string } | { teamId: string }) {
  const workspace = useStore(workspaceStore);
  const [revoked, setRevoked] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { data, error } = useQuery<{ grants: { nodes: Grant[] } }>(GRANTS, {
    filter: subject,
    revoked,
  });
  const isOwner = workspace?.viewer.kind === "owner";
  if (error) return <p className="text-critical">{error}</p>;
  const groups = new Map<string, Grant[]>();
  for (const g of data?.grants.nodes ?? []) {
    const { group } = describe(g);
    groups.set(group, [...(groups.get(group) ?? []), g]);
  }
  const done = () => setEditing(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-muted">
          <input type="checkbox" checked={revoked} onChange={(e) => setRevoked(e.target.checked)} />
          Show revoked
        </label>
        {isOwner && editing !== "new" && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className={`ml-auto ${button("ghost", "sm")}`}
          >
            + Add access
          </button>
        )}
      </div>
      {editing === "new" && <GrantForm subject={subject} onDone={done} />}
      {data && groups.size === 0 && (
        <p className="text-faint">Nothing allowed yet. Agents ask when they need something.</p>
      )}
      {[...groups].map(([group, rows]) => (
        <div key={group} className="overflow-hidden rounded-lg border border-line">
          <h3 className="border-b border-line bg-raised px-4 py-1.5 text-[12px] font-medium text-muted">
            {group}
          </h3>
          <ul className="divide-y divide-line">
            {rows.map((g) =>
              editing === g.id ? (
                <li key={g.id} className="p-3">
                  <GrantForm subject={subject} grant={g} onDone={done} />
                </li>
              ) : (
                <li key={g.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className={`min-w-0 flex-1 ${g.revokedAt ? "opacity-60" : ""}`}>
                    <p className="truncate">{describe(g).label}</p>
                    <p className="truncate text-[12px] text-faint">
                      {g.scope === "everyone" ? "Every agent" : (g.user?.name ?? g.team?.name)} ·{" "}
                      {g.revokedAt
                        ? `Revoked ${timeAgo(g.revokedAt)}`
                        : `Used ${g.useCount === 1 ? "once" : `${g.useCount} times`}${g.lastUsedAt ? `, last ${timeAgo(g.lastUsedAt)}` : ""}`}
                      {g.note && <span className="text-muted"> · {g.note}</span>}
                    </p>
                  </div>
                  {isOwner && !g.revokedAt && (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditing(g.id)}
                        className="text-faint hover:text-ink"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void mutate(
                            "mutation($id: String!) { grantRevoke(id: $id) { success } }",
                            { id: g.id },
                          )
                        }
                        className="text-faint hover:text-critical"
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Adds a grant for the subject, or edits one. */
function GrantForm({
  subject,
  grant,
  onDone,
}: {
  subject: { userId: string } | { teamId: string };
  grant?: Grant;
  onDone: () => void;
}) {
  const [action, setAction] = useState(grant?.action ?? "");
  const [readOnly, setReadOnly] = useState(grant?.resource === READ_ONLY);
  const [resource, setResource] = useState(
    grant?.resource === READ_ONLY ? "" : (grant?.resource ?? ""),
  );
  const [note, setNote] = useState(grant?.note ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const input = {
      action: action.trim(),
      resource: readOnly ? READ_ONLY : resource.trim() || null,
      note: note.trim() || null,
    };
    const ok = grant
      ? await mutate(
          "mutation($id: String!, $input: GrantUpdateInput!) { grantUpdate(id: $id, input: $input) { success } }",
          { id: grant.id, input },
        )
      : await mutate(
          "mutation($input: GrantCreateInput!) { grantCreate(input: $input) { success } }",
          {
            input: {
              ...input,
              ...("userId" in subject
                ? { scope: "user", subjectId: subject.userId }
                : { scope: "team", subjectId: subject.teamId }),
            },
          },
        );
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-line p-3">
      <input
        aria-label="Action"
        value={action}
        placeholder="tool:slack__* for every Slack tool, or team.create"
        onChange={(e) => setAction(e.target.value)}
        className={`w-full ${field}`}
      />
      {action.startsWith("tool:") && (
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Only tools that just read
        </label>
      )}
      {!readOnly && (
        <input
          aria-label="On"
          value={resource}
          placeholder="On: a command, file or id (optional, else anything)"
          onChange={(e) => setResource(e.target.value)}
          className={`w-full ${field}`}
        />
      )}
      <input
        aria-label="Note"
        value={note}
        placeholder="Note (optional)"
        onChange={(e) => setNote(e.target.value)}
        className={`w-full ${field}`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={button("ghost", "sm")}>
          Cancel
        </button>
        <button type="submit" disabled={!action.trim()} className={button("primary", "sm")}>
          {grant ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}
