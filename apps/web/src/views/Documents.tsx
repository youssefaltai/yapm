import { useEffect, useRef, useState } from "react";
import { createDocument } from "../actions.js";
import { mutate, useQuery } from "../data.js";
import { RichEditor } from "../editor/index.js";
import { navigate, paths } from "../router.js";
import { timeAgo } from "../ui.js";
import { ProjectDot } from "./Projects.js";

interface DocumentRow {
  id: string;
  title: string;
  updatedAt: string;
  updatedBy: { name: string } | null;
  project: { id: string; name: string; color: string } | null;
}

export function DocumentsView() {
  const [query, setQuery] = useState("");
  const { data, error } = useQuery<{ documents: { nodes: DocumentRow[] } }>(
    "query($q: String) { documents(first: 200, query: $q) { nodes { id title updatedAt updatedBy { name } project { id name color } } } }",
    { q: query.trim() || null },
  );
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        <span className="font-medium">Documents</span>
        <input
          aria-label="Search documents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles"
          className="ml-3 w-40 rounded-md border border-line bg-panel px-2 py-0.5 outline-none placeholder:text-faint focus:border-faint"
        />
        <button
          type="button"
          onClick={() => void createDocument()}
          className="ml-auto rounded-md bg-accent px-2.5 py-1 font-medium text-white"
        >
          New document
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-red-400">{error}</p>}
        {data && data.documents.nodes.length === 0 && (
          <p className="px-6 py-16 text-center text-muted">
            {query ? "No document matches." : "No documents yet. Briefs, plans and notes go here."}
          </p>
        )}
        <ul>
          {data?.documents.nodes.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => navigate(paths.document(d.id))}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left hover:bg-raised md:px-6"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                {d.project && (
                  <span className="flex max-w-40 items-center gap-1.5 truncate text-[12px] text-muted max-sm:hidden">
                    <ProjectDot color={d.project.color} size={8} />
                    {d.project.name}
                  </span>
                )}
                <span className="shrink-0 text-[12px] text-faint">
                  {d.updatedBy?.name ? `${d.updatedBy.name}, ` : ""}
                  {timeAgo(d.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface DocumentDetail extends DocumentRow {
  content: string;
  createdAt: string;
  creator: { name: string } | null;
}

/** A Markdown document, written in place like Linear's; it saves as you pause. */
export function DocumentPage({ id }: { id: string }) {
  const { data, error } = useQuery<{ document: DocumentDetail }>(
    "query($id: String!) { document(id: $id) { id title content createdAt updatedAt creator { name } updatedBy { name } project { id name color } } }",
    { id },
  );
  const doc = data?.document;
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const saved = useRef({ title: "", content: "" });
  const loaded = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only server changes matter here
  useEffect(() => {
    if (!doc) return;
    // Take the server's copy unless there are unsaved local edits.
    if (!loaded.current || (title === saved.current.title && content === saved.current.content)) {
      setTitle(doc.title);
      setContent(doc.content);
      saved.current = { title: doc.title, content: doc.content };
      loaded.current = true;
    }
  }, [doc]);

  useEffect(() => {
    if (!loaded.current) return;
    if (title === saved.current.title && content === saved.current.content) return;
    const timer = setTimeout(() => {
      const input: Record<string, string> = {};
      if (title.trim() && title !== saved.current.title) input.title = title;
      if (content !== saved.current.content) input.content = content;
      if (!Object.keys(input).length) return;
      saved.current = { title: input.title ?? saved.current.title, content };
      void mutate(
        "mutation($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success } }",
        { id, input },
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [title, content, id]);

  if (error) return <p className="px-6 py-10 text-center text-muted">{error}</p>;
  if (!doc) return null;
  // A brand new document opens ready to write in.
  const fresh = doc.content === "" && doc.title === "Untitled";
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
        {doc.project ? (
          <button
            type="button"
            onClick={() => doc.project && navigate(paths.project(doc.project.id))}
            className="flex items-center gap-1.5 text-muted hover:text-ink"
          >
            <ProjectDot color={doc.project.color} size={8} />
            {doc.project.name}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => navigate(paths.documents())}
            className="text-muted hover:text-ink"
          >
            Documents
          </button>
        )}
        <span className="text-faint">›</span>
        <span className="min-w-0 truncate font-medium">{title || "Untitled"}</span>
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm(`Delete "${doc.title}"?`)) return;
            if (
              await mutate("mutation($id: String!) { documentDelete(id: $id) { success } }", { id })
            )
              navigate(doc.project ? paths.project(doc.project.id) : paths.documents());
          }}
          className="ml-auto rounded-md px-2 py-0.5 text-faint hover:text-red-400"
        >
          Delete
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl px-4 py-8 md:px-6">
          <input
            aria-label="Document title"
            // biome-ignore lint/a11y/noAutofocus: a new document opens to be named
            autoFocus={fresh}
            onFocus={(e) => fresh && e.currentTarget.select()}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-transparent text-2xl font-semibold outline-none"
          />
          <p className="mt-1 mb-6 text-[12px] text-faint">
            {doc.updatedBy?.name ?? doc.creator?.name ?? "Someone"} edited {timeAgo(doc.updatedAt)}
          </p>
          <RichEditor
            label="Content"
            value={content}
            onChange={setContent}
            placeholder="Write something, or press / for blocks…"
            className="min-h-[50vh] text-[15px]"
          />
        </article>
      </div>
    </div>
  );
}
