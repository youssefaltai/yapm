import { type ReactNode, useState } from "react";
import { RichText } from "../editor/index.js";
import { navigate, paths } from "../router.js";

/** One event the runner logged; see `transcriptEvents` in the runner. */
export type TranscriptEvent = {
  type: string;
  at?: number;
  id?: string;
  text?: string;
  name?: string;
  input?: string;
  error?: boolean;
  tool?: string;
  state?: string;
  requestId?: string;
  resource?: string | null;
  turns?: number;
};

type Call = { call: TranscriptEvent; result: TranscriptEvent | null };

type Item =
  | { kind: "call"; call: Call }
  | { kind: "permission"; asked: TranscriptEvent; state: string }
  | { kind: "event"; event: TranscriptEvent };

/**
 * Pairs each tool call with its result, which the runner logs as separate events sharing an id,
 * and folds a permission request and its answer into one line. Older runs logged calls without
 * ids; their result follows the call it belongs to.
 */
export function groupTranscript(events: TranscriptEvent[]): Item[] {
  const items: Item[] = [];
  const calls = new Map<string, Call>();
  const permissions = new Map<string, Extract<Item, { kind: "permission" }>>();
  let lastWithoutId: Call | null = null;
  for (const event of events) {
    if (event.type === "tool") {
      const call: Call = { call: event, result: null };
      if (event.id) calls.set(event.id, call);
      else lastWithoutId = call;
      items.push({ kind: "call", call });
    } else if (event.type === "tool_result") {
      const call = event.id ? calls.get(event.id) : lastWithoutId;
      if (call && !call.result) call.result = event;
      else items.push({ kind: "event", event });
      if (!event.id) lastWithoutId = null;
    } else if (event.type === "permission") {
      const asked = event.requestId ? permissions.get(event.requestId) : undefined;
      if (asked) asked.state = event.state ?? asked.state;
      else {
        const item = { kind: "permission" as const, asked: event, state: event.state ?? "waiting" };
        if (event.requestId) permissions.set(event.requestId, item);
        items.push(item);
      }
    } else items.push({ kind: "event", event });
  }
  return items;
}

/** What the agent said and did in a run, step by step. */
export function Transcript({ events, active }: { events: TranscriptEvent[]; active: boolean }) {
  return (
    <ol className="space-y-2">
      {groupTranscript(events).map((item, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: the transcript only grows
        if (item.kind === "call") return <ToolCall key={i} {...item.call} active={active} />;
        if (item.kind === "permission")
          // biome-ignore lint/suspicious/noArrayIndexKey: the transcript only grows
          return <PermissionLine key={i} asked={item.asked} state={item.state} active={active} />;
        // biome-ignore lint/suspicious/noArrayIndexKey: the transcript only grows
        return <EventLine key={i} event={item.event} />;
      })}
    </ol>
  );
}

// Reading tool calls ---------------------------------------------------------

type Input = Record<string, unknown>;

/** The call's arguments. The runner cuts long ones short, which leaves JSON that won't parse. */
function parseInput(raw: string | undefined): Input | null {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  } catch {
    return null;
  }
}

/** The string arguments that survived a cut, so a cut-short call can still say what it was about. */
function salvageInput(raw: string): Input {
  const input: Input = {};
  for (const [, key, value] of raw.matchAll(/"(\w+)":("(?:[^"\\]|\\.)*")/g)) {
    try {
      if (key && value) input[key] = JSON.parse(value);
    } catch {}
  }
  return input;
}

const str = (input: Input | null, key: string) =>
  input && typeof input[key] === "string" ? (input[key] as string) : "";

/** `/Users/ada/finance/x.py` → `~/finance/x.py`. */
const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");

/** `create_issue` → `Create issue`, `getIssue` → `Get issue`. */
function humanize(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type IconName = "terminal" | "file" | "edit" | "search" | "globe" | "list" | "agent" | "tool";

interface ToolView {
  icon: IconName;
  title: string;
  /** A short line after the title: the file, command, query or record the call is about. */
  subject?: string;
  /** Show the subject in monospace, for commands, paths and patterns. */
  code?: boolean;
  /** The MCP server, when it isn't the hub. */
  source?: string;
  /** A tailored view of the input, in place of the generic list of arguments. */
  body?: (input: Input) => ReactNode;
  /** Input keys the subject or body already show. */
  shown?: string[];
  hideOutput?: boolean;
}

/** Arguments that usually name what a call is about, most telling first. */
const SUBJECT_KEYS = ["identifier", "id", "issueId", "title", "name", "query", "url", "key"];

function describe(name: string, input: Input | null): ToolView {
  const path = shortPath(str(input, "file_path") || str(input, "notebook_path"));
  switch (name) {
    case "Bash": {
      const description = str(input, "description");
      return {
        icon: "terminal",
        title: description || "Run command",
        subject: description ? undefined : str(input, "command"),
        code: true,
        body: (i) => <CodeBlock prompt>{str(i, "command")}</CodeBlock>,
        shown: ["command", "description"],
      };
    }
    case "Read": {
      const offset = Number(input?.offset ?? 0);
      const limit = Number(input?.limit ?? 0);
      const range = limit ? ` · lines ${offset || 1}–${(offset || 1) + limit - 1}` : "";
      return {
        icon: "file",
        title: "Read",
        subject: path + range,
        code: true,
        shown: ["file_path", "offset", "limit"],
      };
    }
    case "Write":
      return {
        icon: "edit",
        title: "Write",
        subject: path,
        code: true,
        body: (i) => <CodeBlock>{str(i, "content")}</CodeBlock>,
        shown: ["file_path", "content"],
      };
    case "Edit":
      return {
        icon: "edit",
        title: "Edit",
        subject: path,
        code: true,
        body: (i) => <Diff before={str(i, "old_string")} after={str(i, "new_string")} />,
        shown: ["file_path", "old_string", "new_string"],
      };
    case "MultiEdit":
      return {
        icon: "edit",
        title: "Edit",
        subject: path,
        code: true,
        body: (i) => (
          <div className="space-y-2">
            {(Array.isArray(i.edits) ? (i.edits as Input[]) : []).map((edit, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: edits have no ids
              <Diff key={n} before={str(edit, "old_string")} after={str(edit, "new_string")} />
            ))}
          </div>
        ),
        shown: ["file_path", "edits"],
      };
    case "NotebookEdit":
      return {
        icon: "edit",
        title: "Edit notebook",
        subject: path,
        code: true,
        body: (i) => <CodeBlock>{str(i, "new_source")}</CodeBlock>,
        shown: ["notebook_path", "new_source"],
      };
    case "Grep": {
      const where = str(input, "path") || str(input, "glob");
      return {
        icon: "search",
        title: "Search",
        subject: str(input, "pattern") + (where ? `  in ${shortPath(where)}` : ""),
        code: true,
        shown: ["pattern", "path", "glob"],
      };
    }
    case "Glob":
      return {
        icon: "search",
        title: "Find files",
        subject: str(input, "pattern"),
        code: true,
        shown: ["pattern"],
      };
    case "WebSearch":
      return { icon: "globe", title: "Search the web", subject: str(input, "query") };
    case "WebFetch":
      return {
        icon: "globe",
        title: "Fetch",
        subject: str(input, "url").replace(/^https?:\/\//, ""),
        code: true,
        shown: ["url"],
      };
    case "TodoWrite": {
      const todos = Array.isArray(input?.todos) ? (input.todos as Input[]) : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        icon: "list",
        title: "Update plan",
        subject: todos.length ? `${done} of ${todos.length} done` : undefined,
        body: () => <Todos todos={todos} />,
        shown: ["todos"],
        hideOutput: true,
      };
    }
    case "Task":
    case "Agent":
      return {
        icon: "agent",
        title: "Subagent",
        subject: str(input, "description"),
        body: (i) => <Prose>{str(i, "prompt")}</Prose>,
        shown: ["description", "prompt"],
      };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const subjectKey = SUBJECT_KEYS.find((key) => str(input, key));
  return {
    icon: "tool",
    title: humanize(mcp ? (mcp[2] ?? name) : name),
    subject: subjectKey ? str(input, subjectKey) : undefined,
    source: mcp && mcp[1] !== "yapm" ? mcp[1] : undefined,
  };
}

// Tool calls -----------------------------------------------------------------

function ToolCall({
  call,
  result,
  active,
}: {
  call: TranscriptEvent;
  result: TranscriptEvent | null;
  active: boolean;
}) {
  const failed = result?.error === true;
  const [open, setOpen] = useState(failed);
  const name = call.name ?? "";
  const input = parseInput(call.input);
  const view = describe(name, input ?? salvageInput(call.input ?? ""));
  const extra = input ? Object.entries(input).filter(([key]) => !view.shown?.includes(key)) : [];

  return (
    <li
      className={`overflow-hidden rounded-lg border bg-panel ${failed ? "border-critical/30" : "border-line"}`}
    >
      <button
        type="button"
        data-tool-toggle
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={name}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised"
      >
        <span className={failed ? "text-critical" : "text-muted"}>{icons[view.icon]}</span>
        <span className="shrink-0 font-medium">{view.title}</span>
        {view.subject && (
          <span
            className={`min-w-0 truncate text-muted ${view.code ? "font-mono text-[12px]" : ""}`}
          >
            {view.subject}
          </span>
        )}
        {view.source && (
          <span className="shrink-0 rounded border border-line px-1.5 text-[11px] text-faint">
            {view.source}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <CallStatus result={result} active={active} />
          <span
            className={`text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          >
            {chevron}
          </span>
        </span>
      </button>
      {open && (
        <div className="animate-fade-in space-y-3 border-t border-line px-3 py-3">
          {input === null ? (
            <Section label="Input, cut short">
              <CodeBlock>{call.input ?? ""}</CodeBlock>
            </Section>
          ) : (
            <>
              {view.body && <Section label="Input">{view.body(input)}</Section>}
              {extra.length > 0 && (
                <Section label={view.body ? "Options" : "Input"}>
                  <Arguments entries={extra} />
                </Section>
              )}
            </>
          )}
          {!view.hideOutput && (
            <Section label={failed ? "Error" : "Output"}>
              {result ? (
                <Output text={result.text ?? ""} error={failed} />
              ) : (
                <p className="text-faint">
                  {active ? "Waiting for the result…" : "The run ended before this returned."}
                </p>
              )}
            </Section>
          )}
        </div>
      )}
    </li>
  );
}

function CallStatus({ result, active }: { result: TranscriptEvent | null; active: boolean }) {
  if (result?.error) return <span className="text-[12px] text-critical">Failed</span>;
  if (result) return null;
  if (active)
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-accent">
        <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" />
        Running
      </span>
    );
  return <span className="text-[12px] text-faint">No result</span>;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-faint">{label}</p>
      {children}
    </div>
  );
}

const codeBox =
  "max-h-80 overflow-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words";

function CodeBlock({ children, prompt }: { children: string; prompt?: boolean }) {
  return (
    <pre className={codeBox}>
      {prompt && <span className="text-faint select-none">$ </span>}
      {children}
    </pre>
  );
}

function Prose({ children }: { children: string }) {
  return <p className="whitespace-pre-wrap text-muted">{children}</p>;
}

/** The call's result: JSON indented, anything else as the tool printed it. */
function Output({ text, error }: { text: string; error: boolean }) {
  if (!text.trim()) return <p className="text-faint">No output</p>;
  let shown = text;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") shown = JSON.stringify(value, null, 2);
  } catch {}
  return (
    <pre className={`${codeBox} ${error ? "border-critical/30 bg-critical/5 text-critical" : ""}`}>
      {shown}
    </pre>
  );
}

/** The arguments of a call without a tailored view, as a list of names and values. */
function Arguments({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate font-mono text-[12px] text-faint">{key}</dt>
          <dd className="min-w-0">
            {typeof value === "string" && !value.includes("\n") && value.length <= 120 ? (
              <span className="break-words">{value}</span>
            ) : typeof value === "string" ? (
              <div className="max-h-80 overflow-auto rounded-md border border-line bg-canvas px-3 py-2">
                <RichText source={value} />
              </div>
            ) : typeof value === "number" || typeof value === "boolean" || value === null ? (
              <span className="font-mono text-[12px]">{String(value)}</span>
            ) : Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null) ? (
              <span className="break-words">{value.length ? value.join(", ") : "None"}</span>
            ) : (
              <pre className={codeBox}>{JSON.stringify(value, null, 2)}</pre>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** An edit as the lines it took out and the lines it put in. */
function Diff({ before, after }: { before: string; after: string }) {
  const lines = (text: string) => (text ? text.split("\n") : []);
  return (
    <pre className={`${codeBox} px-0`}>
      {lines(before).map((line, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no ids
        <div key={`-${n}`} className="bg-critical/10 px-3">
          <span className="text-critical select-none">- </span>
          {line}
        </div>
      ))}
      {lines(after).map((line, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no ids
        <div key={`+${n}`} className="bg-success/10 px-3">
          <span className="text-success select-none">+ </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

function Todos({ todos }: { todos: Input[] }) {
  return (
    <ul className="space-y-1">
      {todos.map((todo, n) => {
        const status = String(todo.status ?? "pending");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: todos have no ids
          <li key={n} className="flex items-center gap-2">
            <span
              className={`grid size-3.5 shrink-0 place-items-center rounded-full border ${
                status === "completed"
                  ? "border-success bg-success text-canvas"
                  : status === "in_progress"
                    ? "border-accent"
                    : "border-faint"
              }`}
              role="img"
              aria-label={status.replace("_", " ")}
            >
              {status === "completed" && checkmark}
              {status === "in_progress" && <span className="size-1.5 rounded-full bg-accent" />}
            </span>
            <span className={status === "completed" ? "text-muted line-through" : ""}>
              {String(todo.content ?? "")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Other events ---------------------------------------------------------------

const PERMISSION: Record<string, { label: string; className: string }> = {
  waiting: { label: "Waiting for your approval to use", className: "text-warning" },
  approved: { label: "Approved", className: "text-success" },
  rejected: { label: "Rejected", className: "text-critical" },
};

function PermissionLine({
  asked,
  state,
  active,
}: {
  asked: TranscriptEvent;
  state: string;
  active: boolean;
}) {
  const s =
    state === "waiting" && !active
      ? { label: "Asked for approval to use", className: "text-faint" }
      : (PERMISSION[state] ?? { label: "Withdrew the request to use", className: "text-faint" });
  const requestId = asked.requestId;
  return (
    <li className="flex items-center gap-2 px-3 py-1 text-[13px]">
      <span className={s.className}>{shield}</span>
      <span className="min-w-0 truncate">
        <span className={s.className}>{s.label}</span>{" "}
        <span className="font-medium">{asked.tool}</span>
        {asked.resource && (
          <span className="font-mono text-[12px] text-muted"> {asked.resource}</span>
        )}
      </span>
      {requestId && (
        <button
          type="button"
          onClick={() => navigate(paths.request(requestId))}
          className="ml-auto shrink-0 text-[12px] text-muted hover:text-ink"
        >
          {state === "waiting" && active ? "Review" : "View request"}
        </button>
      )}
    </li>
  );
}

function EventLine({ event }: { event: TranscriptEvent }) {
  switch (event.type) {
    case "text":
      return (
        <li className="py-1">
          <RichText source={event.text ?? ""} />
        </li>
      );
    case "tool_result":
      return (
        <li>
          <Output text={event.text ?? ""} error={event.error === true} />
        </li>
      );
    case "result":
      return (
        <li className="flex items-center gap-3 pt-2 text-[12px] text-faint">
          <span className="h-px flex-1 bg-line" />
          Session ended after {event.turns ?? 0} {event.turns === 1 ? "turn" : "turns"}
          <span className="h-px flex-1 bg-line" />
        </li>
      );
    default:
      return <li className="text-[12px] text-faint">{event.type}</li>;
  }
}

// Icons ----------------------------------------------------------------------

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="block"
    >
      {children}
    </svg>
  );
}

const icons: Record<IconName, ReactNode> = {
  terminal: (
    <Icon>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75" />
    </Icon>
  ),
  file: (
    <Icon>
      <path d="M4.5 1.75h4.75l3 3v8.25a1.25 1.25 0 0 1-1.25 1.25h-6.5A1.25 1.25 0 0 1 3.25 13V3a1.25 1.25 0 0 1 1.25-1.25z" />
      <path d="M9.25 1.75V5h3" />
    </Icon>
  ),
  edit: (
    <Icon>
      <path d="M10.5 2.5a1.4 1.4 0 0 1 2 2L5.25 11.75l-2.75.75.75-2.75z" />
      <path d="M9.25 3.75l2 2" />
    </Icon>
  ),
  search: (
    <Icon>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.5 3.5" />
    </Icon>
  ),
  globe: (
    <Icon>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.75 1.75 2.5 3.9 2.5 6.25S9.75 12.5 8 14.25C6.25 12.5 5.5 10.35 5.5 8S6.25 3.5 8 1.75z" />
    </Icon>
  ),
  list: (
    <Icon>
      <path d="m2.25 4 1 1 1.75-2M2.25 10.5l1 1 1.75-2M7.5 4.25h6.25M7.5 10.75h6.25" />
    </Icon>
  ),
  agent: (
    <Icon>
      <rect x="2.75" y="4.75" width="10.5" height="8.5" rx="2.5" />
      <path d="M8 2v2.75M6 8.75v.5M10 8.75v.5" />
    </Icon>
  ),
  tool: (
    <Icon>
      <path d="M9 1.75 3.5 9h4L7 14.25 12.5 7h-4z" />
    </Icon>
  ),
};

const chevron = (
  <Icon size={12}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);

const checkmark = (
  <Icon size={10}>
    <path d="m3.5 8.25 3 3 6-6.5" strokeWidth="2.2" />
  </Icon>
);

const shield = (
  <Icon>
    <path d="M8 1.75 13 3.5v4c0 3.25-2.25 5.5-5 6.75C5.25 13 3 10.75 3 7.5v-4z" />
  </Icon>
);
