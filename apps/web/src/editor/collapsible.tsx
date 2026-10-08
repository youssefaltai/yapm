import { Node, wrappingInputRule } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { useState } from "react";
import { icons } from "./icons.js";

/**
 * Linear's collapsible section. In Markdown it's fenced by `+++` lines, with the title after the
 * opening fence:
 *
 *     +++ Title
 *     Hidden until opened.
 *     +++
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    collapsible: {
      setCollapsible: () => ReturnType;
    };
  }
}

const FENCED = /^\+\+\+[ \t]*([^\n]*)\n((?:[\s\S]*?\n)?)\+\+\+[ \t]*(?:\n+|$)/;

function CollapsibleView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  // New sections start open so you can write in them; existing ones start closed, like Linear.
  const [open, setOpen] = useState(() => node.textContent.trim() === "");
  const title = (node.attrs.title as string) ?? "";
  return (
    <NodeViewWrapper className="collapsible" data-open={open || undefined}>
      <div className="collapsible-header" contentEditable={false}>
        <button
          type="button"
          aria-label={open ? "Collapse section" : "Expand section"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="collapsible-toggle"
        >
          {icons.chevron}
        </button>
        {editor.isEditable ? (
          <input
            aria-label="Section title"
            value={title}
            placeholder="Untitled section"
            onChange={(e) => updateAttributes({ title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setOpen(true);
                editor.commands.focus();
              }
            }}
            className="collapsible-title"
          />
        ) : (
          <button type="button" onClick={() => setOpen(!open)} className="collapsible-title">
            {title || "Untitled section"}
          </button>
        )}
      </div>
      <NodeViewContent className="collapsible-content" hidden={!open} />
    </NodeViewWrapper>
  );
}

export const Collapsible = Node.create({
  name: "collapsible",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return { title: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "details",
        getAttrs: (el) => ({ title: el.querySelector("summary")?.textContent ?? "" }),
        contentElement: (el) => {
          el.querySelector("summary")?.remove();
          return el;
        },
      },
    ];
  },

  renderHTML({ node }) {
    return ["details", ["summary", node.attrs.title], ["div", 0]];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CollapsibleView);
  },

  addCommands() {
    return {
      setCollapsible:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: "collapsible",
              attrs: { title: "" },
              content: [{ type: "paragraph" }],
            })
            .run(),
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\+\+\+\s$/,
        type: this.type,
      }),
    ];
  },

  markdownTokenizer: {
    name: "collapsible",
    level: "block",
    start: (src: string) => src.search(/^\+\+\+/m),
    tokenize: (src, _tokens, lexer) => {
      const match = FENCED.exec(src);
      if (!match) return undefined;
      return {
        type: "collapsible",
        raw: match[0],
        title: (match[1] ?? "").trim(),
        tokens: lexer.blockTokens(match[2] ?? ""),
      };
    },
  },

  parseMarkdown(token, helpers) {
    const content = helpers.parseChildren(token.tokens ?? []);
    return helpers.createNode(
      "collapsible",
      { title: token.title ?? "" },
      content.length ? content : [{ type: "paragraph" }],
    );
  },

  renderMarkdown(node, h) {
    const children = (node.content ?? []).map((child: unknown, index: number) =>
      h.renderChild ? h.renderChild(child as never, index) : h.renderChildren([child as never]),
    );
    const opening = `+++ ${node.attrs?.title ?? ""}`.trimEnd();
    return `${opening}\n${children.join("\n\n")}\n+++`;
  },
});
