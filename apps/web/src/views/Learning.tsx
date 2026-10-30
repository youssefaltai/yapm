import { useState } from "react";
import { mutate, useQuery, type Workspace } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
import { button, field, Section } from "../layout.js";
import { navigate, paths } from "../router.js";
import { timeAgo } from "../ui.js";

interface Revision {
  id: string;
  content: string;
  reason: string | null;
  createdAt: string;
  author: { name: string } | null;
}

/** A long markdown text that saves when you click away, like a charter or the handbook. */
export function Prose(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  /** The editor's size; long-form text like the handbook keeps the default. */
  className?: string;
  onSave: (value: string) => void;
}) {
  return (
    <div
      className={`rounded-lg border border-line bg-panel px-4 py-3 focus-within:border-faint ${
        props.disabled ? "opacity-80" : ""
      }`}
    >
      <RichEditor
        label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        editable={!props.disabled}
        onBlur={(text) => text !== props.value && props.onSave(text)}
        className={props.className ?? "min-h-32"}
      />
    </div>
  );
}

/**
 * Earlier versions of a text, for a RevisionList. Pages load them alongside their own data and
 * render once both are in, so the history line doesn't pop in under the text.
 */
export function useRevisions(subject: string, entityId?: string): Revision[] | null {
  const { data, error } = useQuery<{ revisions: Revision[] }>(
    `query($subject: String!, $entityId: String) {
      revisions(subject: $subject, entityId: $entityId, first: 20) {
        id content reason createdAt author { name }
      }
    }`,
    { subject, entityId: entityId ?? null },
  );
  return data?.revisions ?? (error ? [] : null);
}

/** Earlier versions, newest first: who changed it, when and why. */
export function RevisionList({ rows }: { rows: Revision[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <details className="mt-2 text-[13px]">
      <summary className="cursor-pointer text-faint hover:text-muted">
        History (
        {rows.length === 20
          ? "20+ versions"
          : rows.length === 1
            ? "1 version"
            : `${rows.length} versions`}
        )
      </summary>
      <div className="mt-2 divide-y divide-line rounded-lg border border-line">
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-2">
            <button
              type="button"
              onClick={() => setOpen(open === r.id ? null : r.id)}
              className="flex w-full items-baseline gap-2 text-left"
            >
              <span className="font-medium">{r.author?.name ?? "The hub"}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{r.reason ?? ""}</span>
              <span className="shrink-0 text-faint">{timeAgo(r.createdAt)}</span>
            </button>
            {open === r.id && (
              <RichText source={r.content || "(empty)"} className="mt-2 text-muted" />
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

export interface FeedbackRow {
  id: string;
  kind: "stop" | "rejection" | "note";
  body: string;
  createdAt: string;
  runId: string | null;
  requestId: string | null;
  author: { name: string } | null;
  issue: { identifier: string } | null;
  addressedAt: string | null;
  addressedNote: string | null;
}

export const KIND_LABEL = { stop: "Stopped run", rejection: "Rejected request", note: "Note" };

/** The owner and an agent's manager may give it feedback; the hub checks again. */
export function canCoach(workspace: Workspace, agentId: string) {
  const agent = workspace.users.nodes.find((u) => u.id === agentId);
  if (agent?.kind !== "agent") return false;
  return workspace.viewer.kind === "owner" || agent.manager?.id === workspace.viewer.id;
}

/** A one-line note for an agent to learn from, optionally about an issue. */
export function FeedbackForm({
  agent,
  issueId,
  label = "Feedback",
  autoFocus,
  onDone,
}: {
  agent: { id: string; name: string };
  issueId?: string;
  label?: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const [body, setBody] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await mutate(
          "mutation($input: FeedbackCreateInput!) { feedbackCreate(input: $input) { success } }",
          { input: { agentId: agent.id, body, issueId } },
        );
        if (result) {
          setBody("");
          onDone?.();
        }
      }}
    >
      <input
        aria-label={label}
        value={body}
        // biome-ignore lint/a11y/noAutofocus: opened on purpose by a click
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone?.()}
        placeholder={`Tell ${agent.name} what to do differently…`}
        className={`flex-1 ${field}`}
      />
      <button type="submit" disabled={!body.trim()} className={button("primary")}>
        Send
      </button>
    </form>
  );
}

/** The feedback an agent has had, for a FeedbackSection; loaded with the page, like revisions. */
export function useAgentFeedback(agentId: string): FeedbackRow[] | null {
  const { data, error } = useQuery<{ feedbacks: FeedbackRow[] }>(
    `query($id: String) {
      feedbacks(agentId: $id, first: 50) {
        id kind body createdAt runId requestId author { name } issue { identifier }
        addressedAt addressedNote
      }
    }`,
    { id: agentId },
  );
  return data?.feedbacks ?? (error ? [] : null);
}

/** What an agent should learn from, and what it changed because of it. */
export function FeedbackSection({
  agent,
  canGive,
  rows,
}: {
  agent: { id: string; name: string };
  canGive: boolean;
  rows: FeedbackRow[];
}) {
  const open = rows.filter((f) => !f.addressedAt).length;
  return (
    <Section
      title="Feedback"
      count={open > 0 ? `${open} open` : undefined}
      description={
        <>
          Why you stopped its runs or rejected its requests, and your notes, here or on its issues.{" "}
          {agent.name} reads the open ones and turns them into lessons.
        </>
      }
    >
      {canGive && (
        <div className="mb-3">
          <FeedbackForm agent={agent} />
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-muted">No feedback yet.</p>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {rows.map((f) => (
            <div key={f.id} className="px-4 py-2.5">
              <div className="flex items-baseline gap-2 text-[12px] text-faint">
                <span>{KIND_LABEL[f.kind]}</span>
                {f.issue && (
                  <button
                    type="button"
                    onClick={() => f.issue && navigate(paths.issue(f.issue.identifier))}
                    className="hover:text-ink"
                  >
                    {f.issue.identifier}
                  </button>
                )}
                {f.runId && (
                  <button
                    type="button"
                    onClick={() => f.runId && navigate(paths.run(f.runId))}
                    className="hover:text-ink"
                  >
                    Run
                  </button>
                )}
                <span className="ml-auto">{timeAgo(f.createdAt)}</span>
              </div>
              <RichText source={f.body} className="mt-0.5" />
              {f.addressedAt ? (
                <p className="mt-1 text-[12px] text-muted">✓ {f.addressedNote}</p>
              ) : (
                <p className="mt-1 text-[12px] text-faint">Not addressed yet</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
