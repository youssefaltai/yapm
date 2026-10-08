import { useEffect, useState } from "react";
import { workspaceStore } from "../actions.js";
import { mutate, toast, useQuery } from "../data.js";
import { navigate, paths } from "../router.js";
import { timeAgo, useStore } from "../ui.js";

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
}

const MACHINES =
  "{ machines { id name status tags mcps capacity version online lastSeenAt createdAt runningCount } }";

/** The computers agents run on: approve new ones with their code, tag them, remove them. */
export function MachinesView() {
  const { data, error } = useQuery<{ machines: Machine[] }>(MACHINES, undefined, 15_000);
  const workspace = useStore(workspaceStore);
  const isOwner = workspace?.viewer.kind === "owner";
  const machines = (data?.machines ?? []).filter((m) => m.status !== "revoked");
  const enrol = `node apps/runner/dist/main.js enrol --hub ${location.origin} --name "My laptop"`;
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
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
          {error && <p className="text-red-400">{error}</p>}
          <p className="text-muted">
            Agents think and work on your own machines, signed in with your Claude subscription. To
            add one, open a checkout of Life OS there, run{" "}
            <code>pnpm install && pnpm --filter @life-os/runner build</code>, then:
          </p>
          <code className="mt-2 block rounded-lg border border-line bg-panel px-3 py-2 text-[12px] break-all">
            {enrol}
          </code>
          <p className="mt-2 text-faint">
            It shows a six-digit code. Type it below to approve the machine, then run{" "}
            <code>node apps/runner/dist/main.js start</code> there.
          </p>
          <div className="mt-6 space-y-3">
            {data && machines.length === 0 && (
              <p className="py-8 text-center text-muted">No machines yet.</p>
            )}
            {machines.map((m) => (
              <MachineCard key={m.id} machine={m} canEdit={isOwner} />
            ))}
          </div>
        </div>
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
            <dt className="text-faint">MCP servers</dt>
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
      {canEdit && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${m.name}? Its secret stops working and it can't run agents any more.`,
                )
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
