import type { AnyExtension } from "@tiptap/core";
import HardBreak from "@tiptap/extension-hard-break";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { CodeBlock } from "./codeBlock.js";
import { Collapsible } from "./collapsible.js";
import { Emoji } from "./emoji.js";
import { Mention } from "./mention.js";
import { SlashCommands } from "./slash.js";

/** Everything Linear's editor understands, read from and written back to Markdown. */
export function editorExtensions(options: { placeholder?: string; editable: boolean }) {
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false,
      underline: false,
      hardBreak: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" },
      },
    }),
    // Single newlines are line breaks (as GitHub comments and agents write them), so a break
    // is written back as a plain newline rather than trailing spaces.
    HardBreak.extend({
      renderMarkdown: (_node, _h, ctx) =>
        ctx.parentType === "tableCell" || ctx.parentType === "tableHeader" ? "<br>" : "\n",
    }),
    CodeBlock,
    TaskList,
    TaskItem.configure({
      nested: true,
      onReadOnlyChecked: () => false,
      // The node view leaves this off, and the checklist styles rely on it.
      HTMLAttributes: { "data-type": "taskItem" },
    }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false }),
    Collapsible,
    Mention,
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
  ];
  if (options.editable) {
    extensions.push(
      SlashCommands,
      Emoji,
      Placeholder.configure({
        placeholder: ({ node, editor }) =>
          editor.isEmpty
            ? (options.placeholder ?? "")
            : node.type.name === "heading"
              ? `Heading ${node.attrs.level}`
              : "",
        showOnlyCurrent: true,
      }),
    );
  }
  return extensions;
}
