import { useEffect, useState } from "react";
import { copyText, workspaceStore } from "../actions.js";
import { confirmDialog } from "../controls.js";
import { mutate, toast, useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { EmptyState } from "../states.js";
import { Crumb, openMenu, timeAgo, useStore } from "../ui.js";

interface Machine {
  id: string;
  /** The owner's name for it, or else its original name. */
  name: string;
  /** What the machine called itself when it enrolled. */
  originalName: string;
  status: "pending" | "active" | "revoked";
  tags: string[];
  mcps: string[];
  capacity: number;
  version: string | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  runningCount: number;
  mcpServers: McpServer[];
  claudeAccount: { email: string | null; subscriptionType: string | null } | null;
  planUsage: {
    available: boolean;
    limits: { kind: string; utilization: number | null; resetsAt: string | null }[];
  } | null;
}

interface McpServer {
  id: string;
  name: string;
  url: string | null;
  command: string | null;
  args: string[];
  status: "installing" | "needs_auth" | "ready" | "failed";
  statusDetail: string | null;
  authUrl: string | null;
  allAgents: boolean;
  agents: { id: string; name: string }[];
}

const MACHINES = `{ machines {
  id name originalName status tags mcps capacity version online lastSeenAt createdAt runningCount
  claudeAccount { email subscriptionType }
  planUsage { available limits { kind utilization resetsAt } }
  mcpServers { id name url command args status statusDetail authUrl allAgents agents { id name } }
} }`;

interface SetupCommand {
  command: string;
  expiresAt: string;
  /** Machines that were already here, so the new one can be spotted when it connects. */
  known: Set<string>;
}

/** The computers agents run on: add them with one command, tag them, remove them. */
export function MachinesView() {
  const [setup, setSetup] = useState<SetupCommand | null>(null);
  // Poll quickly while a setup command is out, so the new machine shows up as it connects.
  const { data, error } = useQuery<{ machines: Machine[] }>(
    MACHINES,
    undefined,
    setup ? 3_000 : 15_000,
  );
  const workspace = useStore(workspaceStore);
  const isOwner = workspace?.viewer.kind === "owner";
  const machines = (data?.machines ?? []).filter((m) => m.status !== "revoked");
  const added = setup ? machines.find((m) => !setup.known.has(m.id)) : undefined;
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <Crumb onClick={() => navigate(paths.runs())}>Runs</Crumb>
        <span className="font-medium">Machines</span>
        {isOwner && !setup && (
          <button
            type="button"
            onClick={async () => {
              const result = await mutate<{
                machineSetupTokenCreate: { token: string; expiresAt: string };
              }>("mutation { machineSetupTokenCreate { token expiresAt } }");
              if (!result) return;
              const { token, expiresAt } = result.machineSetupTokenCreate;
              setSetup({
                command: `curl -fsSL ${location.origin}/install.sh | sh -s -- --token ${token}`,
                expiresAt,
                known: new Set((data?.machines ?? []).map((m) => m.id)),
              });
            }}
            className="ml-auto rounded-md bg-accent px-3 py-1 font-medium text-white"
          >
            Add machine
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
          {error && <p className="text-red-400">{error}</p>}
          {setup ? (
            <SetupPanel setup={setup} added={added} onDone={() => setSetup(null)} />
          ) : (
            <p className="text-muted">
              Agents think and work on your own Mac or Linux computers, signed in with your Claude
              subscription.{" "}
              {isOwner
                ? "Add machine gives you one command to paste on the computer; it sets everything up."
                : "The owner adds them."}
            </p>
          )}
          <div className="mt-6 space-y-3">
            {data && machines.length === 0 && (
              <EmptyState
                compact
                icon="machine"
                title="No machines yet"
                description={
                  isOwner
                    ? "Add machine gives you one command to paste on a Mac or Linux computer."
                    : "Once the owner adds a computer, agents can run on it."
                }
                className="rounded-xl border border-dashed border-line"
              />
            )}
            {machines.map((m) => (
              <MachineCard key={m.id} machine={m} canEdit={isOwner} />
            ))}
          </div>
          {machines.length > 0 && <UpdateCommand />}
        </div>
      </div>
    </div>
  );
}

/** The one command that installs, connects and starts the runner on a new machine. */
function SetupPanel({
  setup,
  added,
  onDone,
}: {
  setup: SetupCommand;
  added: Machine | undefined;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (added)
    return (
      <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/5 p-4">
        <p className="font-medium">{added.name} is connected.</p>
        <p className="mt-1 text-muted">
          It runs in the background and starts again when the computer does. Give it tags below to
          choose which agents work there.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 rounded-md bg-accent px-3 py-1 font-medium text-white"
        >
          Done
        </button>
      </div>
    );
  return (
    <div className="rounded-lg border border-accent/50 bg-accent/5 p-4">
      <p className="font-medium">Paste this into Terminal on the computer you're adding</p>
      <code className="mt-2 block rounded bg-canvas px-3 py-2 text-[12px] [overflow-wrap:anywhere]">
        {setup.command}
      </code>
      <p className="mt-2 text-muted">
        It installs the runner, asks you to sign in to Claude if the computer isn't already, and
        keeps it running in the background. Works on macOS and Linux, once, until{" "}
        {new Date(setup.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(setup.command);
            setCopied(true);
          }}
          className="rounded-md bg-accent px-3 py-1 font-medium text-white"
        >
          {copied ? "Copied" : "Copy command"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md px-3 py-1 text-muted hover:text-ink"
        >
          Cancel
        </button>
        <span className="ml-auto text-[12px] text-faint">Waiting for the machine…</span>
      </div>
    </div>
  );
}

function MachineCard({ machine: m, canEdit }: { machine: Machine; canEdit: boolean }) {
  const [code, setCode] = useState("");
  // Empty while it goes by its original name, which shows as the placeholder to fall back to.
  const ownName = m.name === m.originalName ? "" : m.name;
  const [name, setName] = useState(ownName);
  useEffect(() => setName(ownName), [ownName]);
  const [tags, setTags] = useState(m.tags.join(", "));
  useEffect(() => setTags(m.tags.join(", ")), [m.tags]);
  const update = (input: { name?: string; tags?: string[] }) =>
    mutate(
      "mutation($id: String!, $input: MachineUpdateInput!) { machineUpdate(id: $id, input: $input) { success } }",
      { id: m.id, input },
    );
  const saveName = async () => {
    if (name.trim() === ownName) return;
    if (!(await update({ name: name.trim() }))) setName(ownName);
  };
  const saveTags = () => {
    const next = tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (next.join(",") === m.tags.join(",")) return;
    void update({ tags: next });
  };
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`size-2 rounded-full ${m.status === "pending" ? "bg-amber-400" : m.online ? "bg-emerald-400" : "bg-faint"}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{m.name}</span>
          {ownName && <span className="ml-2 text-[12px] text-faint">{m.originalName}</span>}
        </span>
        <span className="text-[12px] text-faint">
          {m.status === "pending"
            ? "Waiting for approval"
            : m.online
              ? `Online · ${m.runningCount}/${m.capacity} running`
              : `Offline${m.lastSeenAt ? ` · seen ${timeAgo(m.lastSeenAt)}` : ""}`}
        </span>
      </div>
      {m.status === "pending" && canEdit && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate(
              "mutation($id: String!, $code: String!) { machineApprove(id: $id, pairingCode: $code) { success } }",
              { id: m.id, code },
            );
            if (result) toast(`${m.name} approved`);
          }}
        >
          <input
            aria-label="Pairing code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-32 rounded-md border border-line bg-panel px-3 py-1.5 tracking-widest outline-none focus:border-faint"
          />
          <button
            type="submit"
            disabled={code.length !== 6}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            Approve
          </button>
        </form>
      )}
      <dl className="mt-3 grid grid-cols-[6rem_1fr] items-center gap-y-1.5 text-[13px]">
        <dt className="text-faint">Name</dt>
        <dd>
          <input
            aria-label={`Name for ${m.originalName}`}
            value={name}
            disabled={!canEdit}
            maxLength={60}
            placeholder={m.originalName}
            title={ownName ? `Clear it to go back to ${m.originalName}` : undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="w-full bg-transparent outline-none placeholder:text-faint"
          />
        </dd>
        <dt className="text-faint">Tags</dt>
        <dd>
          <input
            aria-label={`Tags for ${m.name}`}
            value={tags}
            disabled={!canEdit}
            placeholder="none, e.g. personal, employer-a"
            onChange={(e) => setTags(e.target.value)}
            onBlur={saveTags}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="w-full bg-transparent outline-none placeholder:text-faint"
          />
        </dd>
        {m.mcps.length > 0 && (
          <>
            <dt className="text-faint">Own servers</dt>
            <dd className="text-muted">{m.mcps.join(", ")}</dd>
          </>
        )}
        {m.claudeAccount && (
          <>
            <dt className="text-faint">Claude</dt>
            <dd>
              <button
                type="button"
                onClick={() => navigate(paths.usage())}
                className="text-left text-muted hover:text-ink"
              >
                {planSummary(m)}
              </button>
            </dd>
          </>
        )}
        {m.version && (
          <>
            <dt className="text-faint">Runner</dt>
            <dd className="text-muted">v{m.version}</dd>
          </>
        )}
      </dl>
      {m.status === "active" && <McpServers machine={m} canEdit={canEdit} />}
      {canEdit && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: `Remove ${m.name}?`,
                  body: "Its secret stops working and it can't run agents any more.",
                  confirmLabel: "Remove",
                  destructive: true,
                })
              )
                void mutate("mutation($id: String!) { machineRevoke(id: $id) { success } }", {
                  id: m.id,
                });
            }}
            className="text-[12px] text-faint hover:text-red-400"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<McpServer["status"], string> = {
  installing: "Setting up",
  needs_auth: "Needs sign-in",
  ready: "Ready",
  failed: "Failed",
};

/** Servers the hub runs on this machine: sign in, choose who gets them, add and remove. */
function McpServers({ machine, canEdit }: { machine: Machine; canEdit: boolean }) {
  const workspace = useStore(workspaceStore);
  const [adding, setAdding] = useState(false);
  const agents = (workspace?.users.nodes ?? []).filter((u) => u.kind === "agent");
  const setAgents = (server: McpServer, agentIds: string[] | null) =>
    void mutate(
      "mutation($id: String!, $input: McpServerUpdateInput!) { mcpServerUpdate(id: $id, input: $input) { success } }",
      { id: server.id, input: { agentIds } },
    );
  return (
    <section
      className="mt-3 border-t border-line pt-3"
      aria-label={`MCP servers on ${machine.name}`}
    >
      <div className="flex items-center">
        <h3 className="text-[12px] font-medium text-faint uppercase">MCP servers</h3>
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto rounded-md px-2 py-0.5 text-[12px] text-muted hover:bg-raised hover:text-ink"
          >
            + Add server
          </button>
        )}
      </div>
      {machine.mcpServers.length === 0 && !adding && (
        <p className="mt-1 text-[13px] text-faint">
          None yet. Agents ask for the ones they need; you approve them.
        </p>
      )}
      <div className="mt-1 divide-y divide-line">
        {machine.mcpServers.map((server) => (
          <div
            key={server.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]"
          >
            <span className="font-medium">{server.name}</span>
            <span className="min-w-0 flex-1 truncate text-faint">
              {server.url ?? [server.command, ...server.args].join(" ")}
            </span>
            <span
              className={
                server.status === "ready"
                  ? "text-emerald-400"
                  : server.status === "failed"
                    ? "text-red-400"
                    : "text-amber-400"
              }
              title={server.statusDetail ?? undefined}
            >
              {STATUS_TEXT[server.status]}
            </span>
            {server.status === "needs_auth" && server.authUrl && canEdit && (
              <a
                href={server.authUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-accent px-2 py-0.5 font-medium text-white"
              >
                Connect
              </a>
            )}
            <button
              type="button"
              disabled={!canEdit}
              onClick={() =>
                openMenu({
                  placeholder: `Who gets ${server.name}?`,
                  items: [
                    {
                      id: "all",
                      label: "Every agent",
                      checked: server.allAgents,
                      onSelect: () => setAgents(server, null),
                    },
                    ...agents.map((a) => {
                      const has = !server.allAgents && server.agents.some((x) => x.id === a.id);
                      const current = server.allAgents ? [] : server.agents.map((x) => x.id);
                      return {
                        id: a.id,
                        label: a.name,
                        checked: has,
                        onSelect: () =>
                          setAgents(
                            server,
                            has ? current.filter((id) => id !== a.id) : [...current, a.id],
                          ),
                      };
                    }),
                  ],
                })
              }
              className="rounded-md px-1 text-muted hover:bg-raised hover:text-ink"
            >
              {server.allAgents
                ? "Every agent"
                : server.agents.map((a) => a.name).join(", ") || "No agents"}
            </button>
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove ${server.name}`}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Remove ${server.name}?`,
                      body: `It's removed from ${machine.name}.`,
                      confirmLabel: "Remove",
                      destructive: true,
                    })
                  )
                    void mutate("mutation($id: String!) { mcpServerDelete(id: $id) { success } }", {
                      id: server.id,
                    });
                }}
                className="text-faint hover:text-red-400"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {adding && <AddServer machine={machine} onDone={() => setAdding(false)} />}
    </section>
  );
}

function AddServer({ machine, onDone }: { machine: Machine; onDone: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const remote = /^https?:\/\//.test(address.trim());
  return (
    <form
      className="mt-2 flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const [command = "", ...args] = address.trim().split(/\s+/);
        const result = await mutate(
          "mutation($input: McpServerCreateInput!) { mcpServerCreate(input: $input) { success } }",
          {
            input: {
              machineId: machine.id,
              name,
              ...(remote ? { url: address.trim() } : { command, args }),
            },
          },
        );
        if (result) onDone();
      }}
    >
      <input
        aria-label="Server name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name, e.g. slack-acme"
        className="w-40 rounded-md border border-line bg-panel px-2 py-1 outline-none placeholder:text-faint focus:border-faint"
      />
      <input
        aria-label="Server address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="https://… or a command, e.g. npx some-mcp"
        className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 outline-none placeholder:text-faint focus:border-faint"
      />
      <button
        type="submit"
        disabled={!name.trim() || !address.trim()}
        className="rounded-md bg-accent px-3 py-1 font-medium text-white disabled:opacity-40"
      >
        Add
      </button>
      <button type="button" onClick={onDone} className="px-2 text-muted hover:text-ink">
        Cancel
      </button>
    </form>
  );
}

/** The login and how full its main windows are, e.g. "you@example.com · max · session 42%". */
function planSummary(m: Machine) {
  const parts = [m.claudeAccount?.email, m.claudeAccount?.subscriptionType].filter(Boolean);
  const live = (kind: string) =>
    m.planUsage?.limits.find(
      (l) =>
        l.kind === kind &&
        l.utilization !== null &&
        (!l.resetsAt || new Date(l.resetsAt).getTime() > Date.now()),
    );
  const session = live("five_hour");
  const week = live("seven_day");
  if (session) parts.push(`session ${Math.round(session.utilization ?? 0)}%`);
  if (week) parts.push(`week ${Math.round(week.utilization ?? 0)}%`);
  if (m.planUsage && !m.planUsage.available) parts.push("no plan limits");
  return parts.join(" · ") || "Signed in";
}

/**
 * How to update a machine's runner, as a command to copy. Inline in a sentence it broke mid-word
 * ("loca|lhost") on a phone, and there was no way to copy it short of selecting it by hand.
 */
function UpdateCommand() {
  const command = `curl -fsSL ${location.origin}/install.sh | sh`;
  return (
    <section className="mt-6">
      <p className="text-[12px] text-faint">To update a machine's runner, run this on it:</p>
      <div className="mt-1.5 flex items-center gap-3 rounded-md border border-line bg-raised px-3 py-1.5">
        <code className="min-w-0 flex-1 text-[12px] [overflow-wrap:anywhere]">{command}</code>
        <button
          type="button"
          onClick={() => copyText(command, "the update command")}
          className="shrink-0 text-[12px] text-muted hover:text-ink"
        >
          Copy
        </button>
      </div>
    </section>
  );
}
