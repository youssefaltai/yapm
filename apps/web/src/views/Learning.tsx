import { useState } from "react";
import { mutate, useQuery } from "../data.js";
import { RichEditor, RichText } from "../editor/index.js";
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
        className="min-h-32"
      />
    </div>
  );
}

/** Earlier versions, newest first: who changed it, when and why. */
export function RevisionList({ subject, entityId }: { subject: string; entityId?: string }) {
  const { data } = useQuery<{ revisions: Revision[] }>(
    `query($subject: String!, $entityId: String) {
      revisions(subject: $subject, entityId: $entityId, first: 20) {
        id content reason createdAt author { name }
      }
    }`,
    { subject, entityId: entityId ?? null },
  );
  const [open, setOpen] = useState<string | null>(null);
  const rows = data?.revisions ?? [];
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

interface FeedbackRow {
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

const KIND_LABEL = { stop: "Stopped run", rejection: "Rejected request", note: "Note" };

/** What an agent should learn from, and what it changed because of it. */
export function FeedbackSection({
  agent,
  canGive,
}: {
  agent: { id: string; name: string };
  canGive: boolean;
}) {
  const { data } = useQuery<{ feedbacks: FeedbackRow[] }>(
    `query($id: String) {
      feedbacks(agentId: $id, first: 50) {
        id kind body createdAt runId requestId author { name } issue { identifier }
        addressedAt addressedNote
      }
    }`,
    { id: agent.id },
  );
  const [body, setBody] = useState("");
  const rows = data?.feedbacks ?? [];
  const open = rows.filter((f) => !f.addressedAt).length;
  return (
    <section className="mt-8">
      <h2 className="mb-2 font-medium">
        Feedback{" "}
        {open > 0 && <span className="text-[12px] font-normal text-faint">{open} open</span>}
      </h2>
      <p className="mb-2 text-faint">
        Why you stopped its runs or rejected its requests, and your notes. {agent.name} reads the
        open ones and turns them into lessons.
      </p>
      {canGive && (
        <form
          className="mb-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate(
              "mutation($input: FeedbackCreateInput!) { feedbackCreate(input: $input) { success } }",
              { input: { agentId: agent.id, body } },
            );
            if (result) setBody("");
          }}
        >
          <input
            aria-label="Feedback"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Tell ${agent.name} what to do differently…`}
            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 outline-none placeholder:text-faint focus:border-faint"
          />
          <button
            type="submit"
            disabled={!body.trim()}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
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
    </section>
  );
}
