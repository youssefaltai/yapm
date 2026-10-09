import { useEffect, useState } from "react";
import { copyText, workspaceStore } from "../actions.js";
import { confirmDialog } from "../controls.js";
import { mutate, toast, useQuery } from "../data.js";
import { button, field, Page, PageBody, PageHeader, PageTitle } from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState } from "../states.js";
import { timeAgo, useStore } from "../ui.js";
import { RunsTabs } from "./Runs.js";

interface Machine {
  id: string;
  /** The owner's name for it, or else its original name. */
  name: string;
  /** What the machine called itself when it enrolled. */
  originalName: string;
  status: "pending" | "active" | "revoked";
  tags: string[];
  capacity: number;
  version: string | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  runningCount: number;
  claudeAccount: { email: string | null; subscriptionType: string | null } | null;
  planUsage: {
    available: boolean;
    limits: { kind: string; utilization: number | null; resetsAt: string | null }[];
  } | null;
}

const MACHINES = `{ machines {
  id name originalName status tags capacity version online lastSeenAt createdAt runningCount
  claudeAccount { email subscriptionType }
  planUsage { available limits { kind utilization resetsAt } }
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
    <Page>
      <PageHeader
        actions={
          isOwner &&
          !setup && (
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
              className={button("primary", "sm")}
            >
              Add machine
            </button>
          )
        }
        tabs={<RunsTabs active="machines" />}
      >
        <PageTitle>Runs</PageTitle>
      </PageHeader>
      <PageBody>
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
              className="rounded-lg border border-dashed border-line"
            />
          )}
          {machines.map((m) => (
            <MachineCard key={m.id} machine={m} canEdit={isOwner} />
          ))}
        </div>
        {machines.length > 0 && <UpdateCommand />}
      </PageBody>
    </Page>
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
        <button type="button" onClick={onDone} className={`mt-3 ${button("primary")}`}>
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
          className={button("primary")}
        >
          {copied ? "Copied" : "Copy command"}
        </button>
        <button type="button" onClick={onDone} className={button("ghost")}>
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
            className={`w-32 tracking-widest ${field}`}
          />
          <button type="submit" disabled={code.length !== 6} className={button("primary")}>
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
