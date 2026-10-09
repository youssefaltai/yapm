import { mergeAttributes, Node } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import { useEffect, useState } from "react";
import { workspaceStore } from "../actions.js";
import { graphql } from "../api.js";
import { onInvalidate, type StateType } from "../data.js";
import { navigate, paths } from "../router.js";
import { Avatar, StatusIcon } from "../ui.js";
import { type SuggestionItem, suggestionMenu } from "./SuggestionMenu.js";

/**
 * Mentions of members and issues, shown as chips like Linear's. In Markdown a member is `@Name`
 * (what the hub reads to notify them) and an issue is its identifier, e.g. `PF-12`.
 */

function members() {
  return [...(workspaceStore.get()?.users.nodes ?? [])].sort(
    (a, b) => b.name.length - a.name.length,
  );
}

function teamKeys() {
  return new Set((workspaceStore.get()?.teams.nodes ?? []).map((t) => t.key));
}

const ISSUE_AT_START = /^([A-Z][A-Z0-9]{0,9})-(\d+)(?![\w-])/;
const ISSUE_ANYWHERE = /(?<![\w@/#-])[A-Z][A-Z0-9]{0,9}-\d+(?![\w-])/;
const AT_ANYWHERE = /(?<![\w@])@/;

function firstIndex(...indexes: number[]) {
  const found = indexes.filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
}

interface IssuePreview {
  title: string;
  state: { type: StateType; color: string };
}

const issueCache = new Map<string, Promise<IssuePreview | null>>();

function issuePreview(identifier: string) {
  let cached = issueCache.get(identifier);
  if (!cached) {
    cached = graphql<{ issue: IssuePreview }>(
      "query($id: String!) { issue(id: $id) { title state { type color } } }",
      { id: identifier },
    )
      .then((data) => data.issue)
      .catch(() => null);
    issueCache.set(identifier, cached);
  }
  return cached;
}

// A mentioned issue's title and status change like any other data.
onInvalidate(() => issueCache.clear());

function MentionChip({ node, selected }: ReactNodeViewProps) {
  const { kind, id, label } = node.attrs as { kind: "user" | "issue"; id: string; label: string };
  const [issue, setIssue] = useState<IssuePreview | null>(null);
  useEffect(() => {
    if (kind !== "issue") return;
    let alive = true;
    const load = () =>
      void issuePreview(id).then((preview) => alive && preview && setIssue(preview));
    load();
    const stop = onInvalidate(load);
    return () => {
      alive = false;
      stop();
    };
  }, [kind, id]);
  const member =
    kind === "user" ? workspaceStore.get()?.users.nodes.find((m) => m.id === id) : null;
  return (
    <NodeViewWrapper
      as="span"
      data-mention={kind}
      contentEditable={false}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        navigate(kind === "user" ? paths.member(id) : paths.issue(id));
      }}
      className={`mention ${selected ? "is-selected" : ""}`}
      // NodeViewWrapper sets white-space: normal inline, which beats the stylesheet and wraps a
      // long issue title inside the chip.
      style={{ whiteSpace: "nowrap" }}
    >
      {kind === "user" ? (
        <>
          <Avatar name={label} kind={member?.kind} size={14} />
          <span>{label}</span>
        </>
      ) : (
        <>
          {issue && <StatusIcon type={issue.state.type} color={issue.state.color} size={12} />}
          <span className="mention-id">{label}</span>
          {issue && <span className="mention-title">{issue.title}</span>}
        </>
      )}
    </NodeViewWrapper>
  );
}

export const mentionKey = new PluginKey("mention");

export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "user" },
      id: { default: "" },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-mention]",
        getAttrs: (el) => ({
          kind: el.getAttribute("data-mention"),
          id: el.getAttribute("data-id"),
          label: el.getAttribute("data-label"),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": node.attrs.kind,
        "data-id": node.attrs.id,
        "data-label": node.attrs.label,
      }),
      node.attrs.kind === "user" ? `@${node.attrs.label}` : node.attrs.label,
    ];
  },

  renderText({ node }) {
    return node.attrs.kind === "user" ? `@${node.attrs.label}` : node.attrs.label;
  },

  renderMarkdown(node) {
    const attrs = node.attrs as { kind: string; label: string };
    return attrs.kind === "user" ? `@${attrs.label}` : attrs.label;
  },

  markdownTokenizer: {
    name: "mention",
    level: "inline",
    start: (src: string) => firstIndex(src.search(AT_ANYWHERE), src.search(ISSUE_ANYWHERE)),
    tokenize: (src: string) => {
      if (src.startsWith("@")) {
        const lower = src.toLowerCase();
        for (const member of members()) {
          const name = `@${member.name.toLowerCase()}`;
          if (lower.startsWith(name) && !/\w/.test(src[name.length] ?? " ")) {
            return {
              type: "mention",
              raw: src.slice(0, name.length),
              kind: "user",
              id: member.id,
              label: member.name,
            };
          }
        }
        return undefined;
      }
      const issue = ISSUE_AT_START.exec(src);
      if (issue?.[1] && teamKeys().has(issue[1])) {
        return { type: "mention", raw: issue[0], kind: "issue", id: issue[0], label: issue[0] };
      }
      return undefined;
    },
  },

  parseMarkdown(token) {
    return {
      type: "mention",
      attrs: { kind: token.kind, id: token.id, label: token.label },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChip, { as: "span" });
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestionItem, SuggestionItem>({
        editor: this.editor,
        pluginKey: mentionKey,
        char: "@",
        allowSpaces: false,
        items: async ({ query }) => {
          const q = query.toLowerCase();
          const people: SuggestionItem[] = members()
            .filter((m) => m.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 6)
            .map((m) => ({
              id: `user:${m.id}`,
              label: m.name,
              section: "People",
              icon: <Avatar name={m.name} kind={m.kind} size={16} />,
              hint: m.kind === "agent" ? "Agent" : undefined,
              run: ({ editor, range }) =>
                editor
                  .chain()
                  .focus()
                  .insertContentAt(range, [
                    { type: "mention", attrs: { kind: "user", id: m.id, label: m.name } },
                    { type: "text", text: " " },
                  ])
                  .run(),
            }));
          if (!q) return people;
          const found = await graphql<{
            searchIssues: {
              nodes: { identifier: string; title: string; state: IssuePreview["state"] }[];
            };
          }>(
            "query($term: String!) { searchIssues(term: $term, first: 6) { nodes { identifier title state { type color } } } }",
            { term: query },
          ).catch(() => null);
          const issues: SuggestionItem[] = (found?.searchIssues.nodes ?? []).map((i) => ({
            id: `issue:${i.identifier}`,
            label: `${i.identifier} ${i.title}`,
            section: "Issues",
            icon: <StatusIcon type={i.state.type} color={i.state.color} size={13} />,
            run: ({ editor, range }) =>
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  {
                    type: "mention",
                    attrs: { kind: "issue", id: i.identifier, label: i.identifier },
                  },
                  { type: "text", text: " " },
                ])
                .run(),
          }));
          return [...people, ...issues];
        },
        command: ({ editor, range, props }) => props.run({ editor, range }),
        render: suggestionMenu,
      }),
    ];
  },
});
