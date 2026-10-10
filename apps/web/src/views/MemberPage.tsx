import { useEffect, useRef, useState } from "react";
import { workspaceStore } from "../actions.js";
import { confirmDialog, promptDialog, Select } from "../controls.js";
import { mutate, useQuery } from "../data.js";
import { RichEditor } from "../editor/index.js";
import {
  Breadcrumbs,
  button,
  field,
  PageHeader,
  pageHeading,
  Section,
  TitleTag,
} from "../layout.js";
import { navigate, paths } from "../router.js";
import { PageSkeleton } from "../states.js";
import {
  Avatar,
  DetailLayout,
  openMenu,
  Property,
  PropertyList,
  propertyButton,
  timeAgo,
  useStore,
} from "../ui.js";
import {
  FeedbackSection,
  Prose,
  RevisionList,
  useAgentFeedback,
  useRevisions,
} from "./Learning.js";
import { AGENT_RUNS, type RunSummary, RunsSection } from "./Runs.js";

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type Tier = "small" | "standard" | "top";
const TIERS: { value: Tier; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "standard", label: "Standard" },
  { value: "top", label: "Top" },
];

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
  modelFloor: Tier;
  modelCeiling: Tier;
  topRunsPerWeek: number;
  assignedIssues: { nodes: { id: string }[] };
}

const MEMBER_QUERY = `query($id: String!) { user(id: $id) {
  id name kind title charter lessons active isMe createdAt runnerTags
  modelFloor modelCeiling topRunsPerWeek
  manager { id name }
  directReports { nodes { id name kind title } }
  apiTokens { id name prefix createdAt lastUsedAt revokedAt }
  assignedIssues(first: 250, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id } }
} }`;

export function MemberPage({ id }: { id: string }) {
  const { data, error } = useQuery<{ user: MemberDetail }>(MEMBER_QUERY, { id });
  // The agent parts of the page load alongside it, so it renders once, complete.
  const charterHistory = useRevisions("charter", id);
  const lessonsHistory = useRevisions("lessons", id);
  const feedback = useAgentFeedback(id);
  const runs = useQuery<{ runs: { nodes: RunSummary[] } }>(AGENT_RUNS, {
    filter: { agentId: id },
  });
  const runRows = runs.data?.runs.nodes ?? (runs.error ? [] : null);
  const workspace = useStore(workspaceStore);
  const member = data?.user;
  const [newToken, setNewToken] = useState<string | null>(null);

  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!member || !workspace || !charterHistory || !lessonsHistory || !feedback || !runRows)
    return <PageSkeleton />;
  const canEdit = workspace.viewer.kind === "owner";
  const update = (input: Record<string, unknown>) =>
    mutate(
      "mutation($id: String!, $input: UserUpdateInput!) { userUpdate(id: $id, input: $input) { success } }",
      {
        id: member.id,
        input,
      },
    );

  const editable = canEdit && member.active;
  const lineField =
    "rounded-md px-2 py-1 text-ink hover:bg-raised focus:bg-raised disabled:hover:bg-transparent";

  return (
    <div className="flex h-full min-h-0 animate-fade-in flex-col">
      <PageHeader
        actions={
          canEdit &&
          member.kind === "agent" &&
          member.active && (
            <button
              type="button"
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Retire ${member.name}?`,
                    body: "Its tokens stop working and its reports move to its manager.",
                    confirmLabel: "Retire",
                    destructive: true,
                  })
                ) {
                  void mutate("mutation($id: String!) { agentRetire(id: $id) { success } }", {
                    id: member.id,
                  });
                }
              }}
              className={button("ghost", "sm")}
            >
              Retire
            </button>
          )
        }
      >
        <Breadcrumbs trail={[{ label: "Company", to: paths.company() }]}>
          <span className="truncate">{member.name}</span>
          {!member.active && <TitleTag>Retired</TitleTag>}
        </Breadcrumbs>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailLayout
          head={
            <div className="flex items-center gap-3">
              <Avatar name={member.name} kind={member.kind} size={40} />
              <div className="min-w-0 flex-1">
                <EditableLine
                  label="Name"
                  value={member.name}
                  disabled={!editable}
                  onSave={(name) => update({ name })}
                  className={pageHeading}
                />
                <EditableLine
                  label="Title"
                  value={member.title ?? ""}
                  placeholder="Add a title"
                  disabled={!editable}
                  onSave={(title) => update({ title })}
                  className="text-muted"
                />
              </div>
            </div>
          }
          side={
            <>
              <PropertyList>
                <Property label="Reports to" control={member.kind !== "owner"}>
                  {member.kind === "owner" ? (
                    "No one"
                  ) : (
                    <button
                      type="button"
                      disabled={!editable}
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
                      className={propertyButton}
                    >
                      {member.manager ? (
                        <>
                          <Avatar name={member.manager.name} size={16} />
                          {member.manager.name}
                        </>
                      ) : (
                        <span className="text-faint">No one</span>
                      )}
                    </button>
                  )}
                </Property>
                <Property label="Direct reports">
                  {member.directReports.nodes.length === 0 ? (
                    <span className="text-faint">None</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-2 gap-y-1">
                      {member.directReports.nodes.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => navigate(paths.member(r.id))}
                          className="flex items-center gap-1.5 text-ink hover:underline"
                        >
                          <Avatar name={r.name} kind={r.kind} size={16} />
                          {r.name}
                        </button>
                      ))}
                    </span>
                  )}
                </Property>
                <Property label="Open issues">{member.assignedIssues.nodes.length}</Property>
                <Property label="Joined">{timeAgo(member.createdAt)}</Property>
              </PropertyList>
              {member.kind === "agent" && (
                <PropertyList title="How it runs">
                  <Property label="Runs on" control>
                    <EditableLine
                      label="Runner tags"
                      value={member.runnerTags.join(", ")}
                      placeholder="Any machine"
                      disabled={!editable}
                      allowEmpty
                      onSave={(value) =>
                        update({
                          runnerTags: value
                            .split(",")
                            .map((t) => t.trim().toLowerCase())
                            .filter(Boolean),
                        })
                      }
                      className={lineField}
                    />
                  </Property>
                  <Property label="Cheapest tier" control={editable}>
                    {editable ? (
                      <Select
                        aria-label="Cheapest tier"
                        value={member.modelFloor}
                        options={TIERS}
                        onChange={(modelFloor) => update({ modelFloor })}
                        className={`${propertyButton} w-full`}
                      />
                    ) : (
                      tierLabel(member.modelFloor)
                    )}
                  </Property>
                  <Property label="Dearest tier" control={editable}>
                    {editable ? (
                      <Select
                        aria-label="Dearest tier"
                        value={member.modelCeiling}
                        options={TIERS}
                        onChange={(modelCeiling) => update({ modelCeiling })}
                        className={`${propertyButton} w-full`}
                      />
                    ) : (
                      tierLabel(member.modelCeiling)
                    )}
                  </Property>
                  <Property label="Top runs/week" control>
                    <EditableLine
                      label="Top runs a week"
                      value={String(member.topRunsPerWeek)}
                      disabled={!editable}
                      onSave={(value) => {
                        const n = Number(value);
                        if (Number.isInteger(n) && n >= 0) update({ topRunsPerWeek: n });
                      }}
                      className={lineField}
                    />
                  </Property>
                </PropertyList>
              )}
            </>
          }
        >
          {member.kind === "agent" && canEdit && member.active && <GiveWork agent={member} />}

          {member.kind === "agent" && (
            <Section
              title="Charter"
              description="The agent's job: what it owns, how it works, and when it escalates to you."
            >
              <Prose
                label="Charter"
                value={member.charter ?? ""}
                placeholder="Responsibilities, ownership, and when to escalate…"
                disabled={!canEdit || !member.active}
                onSave={(charter) => update({ charter })}
                className="min-h-16"
              />
              <RevisionList rows={charterHistory} />
            </Section>
          )}

          {member.kind === "agent" && (
            <Section
              title="Lessons"
              description={`What ${member.name} has learned, in its own words. It reads them on every run and rewrites them as it learns.`}
            >
              <Prose
                label="Lessons"
                value={member.lessons ?? ""}
                placeholder="Nothing learned yet."
                disabled={!canEdit || !member.active}
                onSave={(lessons) => update({ lessons })}
                className="min-h-16"
              />
              <RevisionList rows={lessonsHistory} />
            </Section>
          )}

          {member.kind === "agent" && (
            <FeedbackSection agent={member} canGive={canEdit && member.active} rows={feedback} />
          )}

          {member.kind === "agent" && <RunsSection runs={runRows} showAgent={false} />}

          {(canEdit || member.isMe) && (
            <Section
              title="API tokens"
              actions={
                canEdit &&
                member.active && (
                  <button
                    type="button"
                    onClick={async () => {
                      const name = await promptDialog({
                        title: "New API token",
                        label: "Token name",
                        placeholder: "The machine it runs on",
                        initial: "Claude Code",
                        confirmLabel: "Create token",
                      });
                      if (!name) return;
                      const result = await mutate<{ apiTokenCreate: { token: string } }>(
                        "mutation($name: String!, $userId: String) { apiTokenCreate(name: $name, userId: $userId) { token } }",
                        { name, userId: member.id },
                      );
                      if (result) setNewToken(result.apiTokenCreate.token);
                    }}
                    className={button("ghost", "sm")}
                  >
                    + New token
                  </button>
                )
              }
            >
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
                        className="text-faint hover:text-critical"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </DetailLayout>
      </div>
    </div>
  );
}

const tierLabel = (tier: Tier) => TIERS.find((t) => t.value === tier)?.label ?? tier;

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
  const form = useRef<HTMLFormElement>(null);
  const [issue, setIssue] = useState("");
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={button("secondary")}>
        Give {agent.name} work
      </button>
    );
  return (
    <form
      ref={form}
      className="rounded-lg border border-line p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await mutate<{ runCreate: { run: { id: string } } }>(
          "mutation($input: RunCreateInput!) { runCreate(input: $input) { run { id } } }",
          { input: { agentId: agent.id, goal, issueId: issue.trim() || null } },
        );
        if (result) navigate(paths.run(result.runCreate.run.id));
      }}
    >
      <div className="block">
        <span className="mb-1.5 block text-muted">What should {agent.name} get done?</span>
        <div className="rounded-lg border border-line bg-panel px-3 py-2 focus-within:border-faint">
          <RichEditor
            label="Goal"
            autoFocus
            value=""
            onChange={setGoal}
            onSubmit={() => goal.trim() && form.current?.requestSubmit()}
            className="min-h-14"
          />
        </div>
      </div>
      <label className="mt-3 flex items-center gap-2">
        <span className="text-muted">On issue</span>
        <input
          aria-label="On issue"
          value={issue}
          placeholder="Optional, e.g. FIT-3"
          onChange={(e) => setIssue(e.target.value)}
          className={`w-40 ${field}`}
        />
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className={button("ghost")}>
          Cancel
        </button>
        <button type="submit" disabled={!goal.trim()} className={button("primary")}>
          Start
        </button>
      </div>
    </form>
  );
}

function NewToken({ token, name, onDone }: { token: string; name: string; onDone: () => void }) {
  const command = `claude mcp add --transport http yapm ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;
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
          className={button("primary")}
        >
          Copy command
        </button>
        <button type="button" onClick={onDone} className={button("ghost")}>
          Done
        </button>
      </div>
    </div>
  );
}
