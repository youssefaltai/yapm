import { useEffect, useRef, useState } from "react";
import { createDocument, documentContextMenu } from "../actions.js";
import { contextMenu } from "../contextMenu.js";
import { confirmDialog } from "../controls.js";
import { mutate, useQuery } from "../data.js";
import { RichEditor } from "../editor/index.js";
import {
  Breadcrumbs,
  button,
  listRow,
  PageBody,
  PageHeader,
  PageTitle,
  pageHeading,
  smallField,
} from "../layout.js";
import { navigate, paths } from "../router.js";
import { EmptyState, ListSkeleton, PageSkeleton } from "../states.js";
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
      <PageHeader
        actions={
          <button
            type="button"
            onClick={() => void createDocument()}
            className={button("primary", "sm")}
          >
            New document
          </button>
        }
      >
        <PageTitle>Documents</PageTitle>
        <input
          aria-label="Search documents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles"
          className={`w-40 ${smallField}`}
        />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-red-400">{error}</p>}
        {!data && !error && <ListSkeleton rows={6} />}
        {data &&
          data.documents.nodes.length === 0 &&
          (query ? (
            <EmptyState
              icon="search"
              title="No document matches"
              description={`Nothing is titled like “${query.trim()}”. Try another word.`}
              action={{ label: "Clear search", onClick: () => setQuery("") }}
            />
          ) : (
            <EmptyState
              icon="document"
              title="No documents yet"
              description="Briefs, plans and notes go here, written by you or your agents."
              action={{ label: "New document", onClick: () => void createDocument() }}
            />
          ))}
        <ul>
          {data?.documents.nodes.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => navigate(paths.document(d.id))}
                onContextMenu={contextMenu(() => documentContextMenu(d))}
                className={listRow}
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
  if (!doc) return <PageSkeleton />;
  // A brand new document opens ready to write in.
  const fresh = doc.content === "" && doc.title === "Untitled";
  return (
    <div className="flex h-full animate-fade-in flex-col">
      <PageHeader
        actions={
          <button
            type="button"
            onClick={async () => {
              if (
                !(await confirmDialog({
                  title: `Delete “${doc.title || "Untitled"}”?`,
                  body: "The document is deleted for everyone.",
                  confirmLabel: "Delete",
                  destructive: true,
                }))
              )
                return;
              if (
                await mutate("mutation($id: String!) { documentDelete(id: $id) { success } }", {
                  id,
                })
              )
                navigate(doc.project ? paths.project(doc.project.id) : paths.documents());
            }}
            className={button("ghost", "sm")}
          >
            Delete
          </button>
        }
      >
        <Breadcrumbs
          trail={[
            doc.project
              ? {
                  label: (
                    <>
                      <ProjectDot color={doc.project.color} size={8} />
                      {doc.project.name}
                    </>
                  ),
                  to: paths.project(doc.project.id),
                }
              : { label: "Documents", to: paths.documents() },
          ]}
        >
          <span className="truncate">{title || "Untitled"}</span>
        </Breadcrumbs>
      </PageHeader>
      <PageBody>
        <article>
          <input
            aria-label="Document title"
            // biome-ignore lint/a11y/noAutofocus: a new document opens to be named
            autoFocus={fresh}
            onFocus={(e) => fresh && e.currentTarget.select()}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`w-full bg-transparent outline-none ${pageHeading}`}
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
      </PageBody>
    </div>
  );
}
