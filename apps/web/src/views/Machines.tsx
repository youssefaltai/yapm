import { useEffect, useState } from "react";
import { copyText, workspaceStore } from "../actions.js";
import { confirmDialog } from "../controls.js";
import { mutate, toast, useQuery } from "../data.js";
import {
  Breadcrumbs,
  button,
  field,
  GroupHeader,
  listItem,
  listRow,
  Page,
  PageHeader,
  PageTitle,
  pageHeading,
  Section,
} from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState, ListSkeleton, PageSkeleton } from "../states.js";
import { DetailLayout, Property, PropertyList, propertyButton, timeAgo, useStore } from "../ui.js";
import { RUN_SUMMARY, RunRows, type RunSummary, RunsTabs } from "./Runs.js";
import { type MachinePlan, Meter, type PlanLimit, PROVIDERS, planName } from "./Usage.js";

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
  planUsage: { available: boolean; limits: PlanLimit[] } | null;
  plans: {
    provider: MachinePlan["provider"];
    name: string | null;
    usage: { available: boolean; limits: PlanLimit[] } | null;
  }[];
}

const MACHINES = `{ machines {
  id name originalName status tags capacity version online lastSeenAt createdAt runningCount
  claudeAccount { email subscriptionType }
  planUsage { available limits { kind label utilization resetsAt status } }
  plans { provider name usage { available limits { kind label utilization resetsAt status } } }
} }`;

export interface SetupCommand {
  command: string;
  expiresAt: string;
  /** Machines that were already here, so the new one can be spotted when it connects. */
  known: Set<string>;
}

const update = (id: string, input: { name?: string; tags?: string[] }) =>
  mutate(
    "mutation($id: String!, $input: MachineUpdateInput!) { machineUpdate(id: $id, input: $input) { success } }",
    { id, input },
  );

/** "Online · 1/2 running", "Offline · seen 3h ago" or "Waiting for approval". */
function statusText(m: Machine) {
  if (m.status === "pending") return "Waiting for approval";
  if (m.online) return `Online · ${m.runningCount}/${m.capacity} running`;
  return `Offline${m.lastSeenAt ? ` · seen ${timeAgo(m.lastSeenAt)}` : ""}`;
}

function StatusDot({ machine: m, size = "size-2" }: { machine: Machine; size?: string }) {
  return (
    <span
      aria-hidden
      className={`${size} shrink-0 rounded-full ${
        m.status === "pending" ? "bg-warning" : m.online ? "bg-success" : "bg-faint"
      }`}
    />
  );
}

function TagChips({ tags }: { tags: string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {tags.map((t) => (
        <span
          key={t}
          className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted"
        >
          {t}
        </span>
      ))}
    </span>
  );
}

/** The plan window that's live and fullest, so a row can show how much room is left. */
function busiestLimit(m: Machine) {
  return m.plans
    .flatMap((p) =>
      p.usage?.available
        ? p.usage.limits.map((l) => ({ ...l, label: `${PROVIDERS[p.provider]}, ${l.label}` }))
        : [],
    )
    .filter(
      (l) => l.utilization !== null && (!l.resetsAt || new Date(l.resetsAt).getTime() > Date.now()),
    )
    .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
}

/** The computers agents run on, one row each; a row opens the machine. */
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
  const pending = machines.filter((m) => m.status === "pending");
  const active = machines.filter((m) => m.status === "active");
  const added = setup ? machines.find((m) => !setup.known.has(m.id)) : undefined;

  async function addMachine() {
    setSetup(await machineSetup(data?.machines ?? []));
  }

  return (
    <Page>
      <PageHeader
        actions={
          isOwner &&
          !setup && (
            <button type="button" onClick={addMachine} className={button("primary", "sm")}>
              Add machine
            </button>
          )
        }
        tabs={<RunsTabs active="machines" />}
      >
        <PageTitle>Runs</PageTitle>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <p className="p-6 text-critical">{error}</p>}
        {setup && (
          <div className="border-b border-line px-4 py-4 md:px-6">
            <SetupPanel setup={setup} added={added} onDone={() => setSetup(null)} />
          </div>
        )}
        {!data && !error && <ListSkeleton rows={3} />}
        {data && machines.length === 0 && !setup && (
          <EmptyState
            icon="machine"
            title="No machines yet"
            description={
              isOwner
                ? "Agents work on your own Mac or Linux computers, on your own Claude, ChatGPT or Copilot plan, or an API key. Add one with a single command."
                : "Agents work on the owner's own computers. Once the owner adds one, agents can run on it."
            }
            action={isOwner ? { label: "Add machine", onClick: addMachine } : undefined}
          />
        )}
        {pending.length > 0 && (
          <>
            <GroupHeader label="Waiting for approval" count={pending.length} />
            {pending.map((m) => (
              <PendingRow key={m.id} machine={m} canApprove={isOwner} />
            ))}
            {active.length > 0 && <GroupHeader label="Machines" count={active.length} />}
          </>
        )}
        {active.map((m) => (
          <MachineRow key={m.id} machine={m} />
        ))}
      </div>
    </Page>
  );
}

function MachineRow({ machine: m }: { machine: Machine }) {
  const limit = busiestLimit(m);
  return (
    <button type="button" onClick={() => navigate(paths.machine(m.id))} className={listRow}>
      <StatusDot machine={m} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{m.name}</span>
        {m.name !== m.originalName && (
          <span className="ml-2 text-[12px] text-faint max-sm:hidden">{m.originalName}</span>
        )}
      </span>
      <span className="max-w-56 max-md:hidden">
        <TagChips tags={m.tags} />
      </span>
      <span
        className="flex w-24 shrink-0 items-center gap-2 max-sm:hidden"
        title={limit ? `${limit.label}: ${Math.round(limit.utilization ?? 0)}% used` : undefined}
      >
        {limit && (
          <>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-raised">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.min(Math.max(limit.utilization ?? 0, 2), 100)}%`,
                  background:
                    (limit.utilization ?? 0) >= 100
                      ? "var(--color-critical)"
                      : (limit.utilization ?? 0) >= 80
                        ? "var(--color-warning)"
                        : "var(--color-accent)",
                }}
              />
            </span>
            <span className="w-8 text-right text-[12px] text-faint tabular-nums">
              {Math.round(limit.utilization ?? 0)}%
            </span>
          </>
        )}
      </span>
      <span className="shrink-0 text-right text-[12px] text-faint sm:w-40">{statusText(m)}</span>
    </button>
  );
}

/** A machine that enrolled and shows a code, in the list with a field to approve it. */
function PendingRow({ machine: m, canApprove }: { machine: Machine; canApprove: boolean }) {
  return (
    <div className={`${listItem} flex-wrap`}>
      <StatusDot machine={m} />
      <span className="min-w-0 flex-1 basis-48">
        <button
          type="button"
          onClick={() => navigate(paths.machine(m.id))}
          className="block max-w-full truncate font-medium hover:underline"
        >
          {m.name}
        </button>
        <span className="block text-[12px] text-faint">
          {canApprove
            ? "Type the 6-digit code it shows to let it run agents."
            : "Waiting for the owner to approve it."}
        </span>
      </span>
      {canApprove && <ApproveForm machine={m} />}
    </div>
  );
}

/** Typing in the code the machine shows lets it run agents. */
function ApproveForm({ machine: m }: { machine: Machine }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex gap-2"
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
  );
}

/** The one command that installs, connects and starts the runner on a new machine. */
/** A one-time command that adds a machine, remembering which were here so the new one stands out. */
export async function machineSetup(known: { id: string }[]): Promise<SetupCommand | null> {
  const result = await mutate<{
    machineSetupTokenCreate: { token: string; expiresAt: string };
  }>("mutation { machineSetupTokenCreate { token expiresAt } }");
  if (!result) return null;
  const { token, expiresAt } = result.machineSetupTokenCreate;
  return {
    command: `curl -fsSL ${location.origin}/install.sh | sh -s -- --token ${token}`,
    expiresAt,
    known: new Set(known.map((m) => m.id)),
  };
}

export function SetupPanel({
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
      <div className="rounded-lg border border-success/40 bg-success/5 p-4">
        <p className="font-medium">{added.name} is connected.</p>
        <p className="mt-1 text-muted">
          It runs in the background and starts again when the computer does. Open it to give it
          tags, which choose the agents that work there.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => navigate(paths.machine(added.id))}
            className={button("primary")}
          >
            Open {added.name}
          </button>
          <button type="button" onClick={onDone} className={button("ghost")}>
            Done
          </button>
        </div>
      </div>
    );
  return (
    <div className="rounded-lg border border-accent/50 bg-accent/5 p-4">
      <p className="font-medium">Paste this into Terminal on the computer you're adding</p>
      <code className="mt-2 block rounded bg-canvas px-3 py-2 text-[12px] [overflow-wrap:anywhere]">
        {setup.command}
      </code>
      <p className="mt-2 text-muted">
        It installs the runner, asks how agents should run if the computer isn't set up yet, and
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

/** One machine: its name and tags, the MCP servers the hub runs there, its Claude plan and runs. */
export function MachinePage({ id }: { id: string }) {
  const { data, error } = useQuery<{ machines: Machine[] }>(MACHINES, undefined, 15_000);
  const runs = useQuery<{ runs: { nodes: RunSummary[] } }>(
    `query($filter: RunFilter) { runs(first: 20, filter: $filter) { nodes { ${RUN_SUMMARY} } } }`,
    { filter: { machineId: id } },
    10_000,
  );
  const workspace = useStore(workspaceStore);
  const m = data?.machines.find((x) => x.id === id);
  // A removed machine keeps its page, read-only, so runs and usage can still link to it.
  const canEdit = workspace?.viewer.kind === "owner" && m?.status !== "revoked";
  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!data || !workspace) return <PageSkeleton />;
  if (!m)
    return (
      <Page>
        <PageHeader>
          <Breadcrumbs
            trail={[
              { label: "Runs", to: paths.runs(), wide: true },
              { label: "Machines", to: paths.machines() },
            ]}
          >
            Not found
          </Breadcrumbs>
        </PageHeader>
        <EmptyState
          icon="machine"
          title="This machine isn't here"
          description="The link may be wrong."
          action={{ label: "See all machines", onClick: () => navigate(paths.machines()) }}
        />
      </Page>
    );

  async function remove() {
    if (
      !m ||
      !(await confirmDialog({
        title: `Remove ${m.name}?`,
        body: "Its secret stops working and it can't run agents any more.",
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    const result = await mutate("mutation($id: String!) { machineRevoke(id: $id) { success } }", {
      id: m.id,
    });
    if (result) navigate(paths.machines());
  }

  async function upgrade() {
    if (!m) return;
    const result = await mutate("mutation($id: String!) { machineUpgrade(id: $id) { success } }", {
      id: m.id,
    });
    if (result) toast(`${m.name} updates once its runs finish`);
  }

  return (
    <div className="flex h-full min-h-0 animate-fade-in flex-col">
      <PageHeader
        actions={
          canEdit && (
            <>
              {m.status === "active" && (
                <button type="button" onClick={upgrade} className={button("ghost", "sm")}>
                  Update runner
                </button>
              )}
              <button type="button" onClick={remove} className={button("danger", "sm")}>
                Remove
              </button>
            </>
          )
        }
      >
        <Breadcrumbs
          trail={[
            { label: "Runs", to: paths.runs(), wide: true },
            { label: "Machines", to: paths.machines() },
          ]}
        >
          <span className="truncate">{m.name}</span>
        </Breadcrumbs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailLayout
          head={
            <>
              <div className="flex items-center gap-3">
                <StatusDot machine={m} size="size-2.5" />
                <NameField machine={m} canEdit={canEdit} />
              </div>
              {m.name !== m.originalName && (
                <p className="mt-1 text-faint">Enrolled as {m.originalName}</p>
              )}
              {m.status === "pending" && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
                  <p className="min-w-0 flex-1 basis-56">
                    <span className="text-warning">Waiting for approval.</span>{" "}
                    {canEdit
                      ? "Type the 6-digit code it shows to let it run agents."
                      : "The owner approves it."}
                  </p>
                  {canEdit && <ApproveForm machine={m} />}
                </div>
              )}
            </>
          }
          side={
            <>
              <PropertyList>
                <Property label="Status">
                  <StatusDot machine={m} />
                  {m.status === "revoked"
                    ? "Removed"
                    : m.status === "pending"
                      ? "Pending"
                      : m.online
                        ? "Online"
                        : "Offline"}
                </Property>
                {m.status === "active" && (
                  <Property label="Running">
                    {m.runningCount} of {m.capacity}
                  </Property>
                )}
                <Property label="Last seen">
                  {m.lastSeenAt ? timeAgo(m.lastSeenAt) : <span className="text-faint">Never</span>}
                </Property>
                <Property label="Tags" control>
                  <TagsField machine={m} canEdit={canEdit} />
                </Property>
                <Property label="Runner">
                  {m.version ? `v${m.version}` : <span className="text-faint">Unknown</span>}
                </Property>
                <Property label="Added">{timeAgo(m.createdAt)}</Property>
              </PropertyList>
              <ClaudePlan machine={m} />
              <OpencodePlans machine={m} />
            </>
          }
        >
          <Section title="Recent runs">
            {runs.data && runs.data.runs.nodes.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-line">
                <RunRows runs={runs.data.runs.nodes} embedded />
              </div>
            ) : (
              <p className="text-faint">{runs.data ? "No runs here yet." : "Loading…"}</p>
            )}
          </Section>
          {m.status === "active" && <UpdateCommand />}
        </DetailLayout>
      </div>
    </div>
  );
}

/** The machine's name as the page's title, renamed in place; cleared, it goes back to its own. */
function NameField({ machine: m, canEdit }: { machine: Machine; canEdit: boolean }) {
  // Empty while it goes by its original name, which shows as the placeholder to fall back to.
  const ownName = m.name === m.originalName ? "" : m.name;
  const [name, setName] = useState(ownName);
  useEffect(() => setName(ownName), [ownName]);
  const save = async () => {
    if (name.trim() === ownName) return;
    if (!(await update(m.id, { name: name.trim() }))) setName(ownName);
  };
  return (
    <input
      aria-label={`Name for ${m.originalName}`}
      value={name}
      disabled={!canEdit}
      maxLength={60}
      placeholder={m.originalName}
      title={ownName ? `Clear it to go back to ${m.originalName}` : undefined}
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink disabled:opacity-100 ${pageHeading}`}
    />
  );
}

/** Tags pick which agents may work here; typed as a comma-separated list. */
function TagsField({ machine: m, canEdit }: { machine: Machine; canEdit: boolean }) {
  // Keyed on the text, not the array: every refetch brings a new array, which would wipe typing.
  const saved = m.tags.join(", ");
  const [tags, setTags] = useState(saved);
  useEffect(() => setTags(saved), [saved]);
  const save = () => {
    const next = tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (next.join(",") === m.tags.join(",")) return;
    void update(m.id, { tags: next });
  };
  return (
    <input
      aria-label={`Tags for ${m.name}`}
      value={tags}
      disabled={!canEdit}
      placeholder={canEdit ? "Add tags" : "None"}
      onChange={(e) => setTags(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={`${propertyButton} w-full bg-transparent outline-none placeholder:text-faint focus:bg-raised`}
    />
  );
}

/** Who the machine is signed in to Claude as, and how full that plan's windows are. */
function ClaudePlan({ machine: m }: { machine: Machine }) {
  if (!m.claudeAccount) return null;
  const plan = planName(m.claudeAccount.subscriptionType);
  const limits = m.planUsage?.available ? m.planUsage.limits : [];
  return (
    <section aria-label="Claude" className="mt-4 border-t border-line pt-4">
      <PropertyList title="Claude">
        <Property label="Account">
          <span className="truncate">{m.claudeAccount.email ?? "Signed in"}</span>
        </Property>
        {plan && <Property label="Plan">{plan}</Property>}
      </PropertyList>
      {m.planUsage && !m.planUsage.available && (
        <p className="mt-2 px-2 text-[12px] text-faint">
          An API key or cloud login, so no plan limits.
        </p>
      )}
      {limits.length > 0 && (
        <ul className="mt-3 space-y-3 px-2">
          {limits.map((l) => (
            <Meter key={l.kind} limit={l} />
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => navigate(paths.usage())}
        className="mt-3 px-2 text-[12px] text-muted hover:text-ink"
      >
        See usage →
      </button>
    </section>
  );
}

/** The ChatGPT or Copilot plans OpenCode runs on here, as its last runs read them. */
function OpencodePlans({ machine: m }: { machine: Machine }) {
  return m.plans
    .filter((p) => p.provider !== "claude")
    .map((p) => (
      <section
        key={p.provider}
        aria-label={PROVIDERS[p.provider]}
        className="mt-4 border-t border-line pt-4"
      >
        <PropertyList title={PROVIDERS[p.provider]}>
          <Property label="Plan">{planName(p.name) ?? "Signed in"}</Property>
        </PropertyList>
        {p.usage?.limits.length ? (
          <ul className="mt-3 space-y-3 px-2">
            {p.usage.limits.map((l) => (
              <Meter key={l.kind} limit={l} />
            ))}
          </ul>
        ) : null}
      </section>
    ));
}

/**
 * How to update a machine's runner, as a command to copy. Inline in a sentence it broke mid-word
 * ("loca|lhost") on a phone, and there was no way to copy it short of selecting it by hand.
 */
function UpdateCommand() {
  const command = `curl -fsSL ${location.origin}/install.sh | sh`;
  return (
    <Section title="Update the runner" description="Run this on the machine to update its runner.">
      <div className="flex items-center gap-3 rounded-md border border-line bg-raised px-3 py-1.5">
        <code className="min-w-0 flex-1 text-[12px] [overflow-wrap:anywhere]">{command}</code>
        <button
          type="button"
          onClick={() => copyText(command, "the update command")}
          className="shrink-0 text-[12px] text-muted hover:text-ink"
        >
          Copy
        </button>
      </div>
    </Section>
  );
}
