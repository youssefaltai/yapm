import { useEffect, useState } from "react";
import { workspaceStore } from "../actions.js";
import { confirmDialog } from "../controls.js";
import { mutate, toast, useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { openMenu, timeAgo, useStore } from "../ui.js";

interface Machine {
  id: string;
  name: string;
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
  id name status tags mcps capacity version online lastSeenAt createdAt runningCount
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
        <button
          type="button"
          onClick={() => navigate(paths.runs())}
          className="text-muted hover:text-ink"
        >
          Runs
        </button>
        <span className="text-faint">›</span>
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
              <p className="py-8 text-center text-muted">No machines yet.</p>
            )}
            {machines.map((m) => (
              <MachineCard key={m.id} machine={m} canEdit={isOwner} />
            ))}
          </div>
          {machines.length > 0 && (
            <p className="mt-6 text-[12px] text-faint">
              To update a machine's runner, run{" "}
              <code className="break-all">curl -fsSL {location.origin}/install.sh | sh</code> on it.
            </p>
          )}
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
      <code className="mt-2 block rounded bg-canvas px-3 py-2 text-[12px] break-all">
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
  const [tags, setTags] = useState(m.tags.join(", "));
  useEffect(() => setTags(m.tags.join(", ")), [m.tags]);
  const saveTags = () => {
    const next = tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (next.join(",") === m.tags.join(",")) return;
    void mutate(
      "mutation($id: String!, $input: MachineUpdateInput!) { machineUpdate(id: $id, input: $input) { success } }",
      { id: m.id, input: { tags: next } },
    );
  };
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`size-2 rounded-full ${m.status === "pending" ? "bg-amber-400" : m.online ? "bg-emerald-400" : "bg-faint"}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
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
