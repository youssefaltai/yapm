import { type Editor, Extension, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { openEmojiPicker } from "../emoji/EmojiPicker.js";
import { icons } from "./icons.js";
import { type SuggestionItem, suggestionMenu } from "./SuggestionMenu.js";

type Run = (editor: Editor, range: Range) => void;

const block = (run: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>): Run => {
  return (editor, range) => {
    run(editor.chain().focus().deleteRange(range)).run();
  };
};

/** Linear's `/` menu, with the Markdown shortcut for each block on the right. */
const COMMANDS: {
  id: string;
  label: string;
  keywords: string;
  hint?: string;
  icon: React.ReactNode;
  run: Run;
}[] = [
  {
    id: "text",
    label: "Text",
    keywords: "paragraph plain",
    icon: icons.text,
    run: block((c) => c.setParagraph()),
  },
  {
    id: "h1",
    label: "Heading 1",
    keywords: "title big h1",
    hint: "#",
    icon: icons.h1,
    run: block((c) => c.setHeading({ level: 1 })),
  },
  {
    id: "h2",
    label: "Heading 2",
    keywords: "subtitle h2",
    hint: "##",
    icon: icons.h2,
    run: block((c) => c.setHeading({ level: 2 })),
  },
  {
    id: "h3",
    label: "Heading 3",
    keywords: "small h3",
    hint: "###",
    icon: icons.h3,
    run: block((c) => c.setHeading({ level: 3 })),
  },
  {
    id: "bullet",
    label: "Bulleted list",
    keywords: "unordered ul bullet",
    hint: "-",
    icon: icons.bullet,
    run: block((c) => c.toggleBulletList()),
  },
  {
    id: "numbered",
    label: "Numbered list",
    keywords: "ordered ol",
    hint: "1.",
    icon: icons.numbered,
    run: block((c) => c.toggleOrderedList()),
  },
  {
    id: "checklist",
    label: "Checklist",
    keywords: "todo task checkbox",
    hint: "[]",
    icon: icons.check,
    run: block((c) => c.toggleTaskList()),
  },
  {
    id: "code",
    label: "Code block",
    keywords: "snippet pre",
    hint: "```",
    icon: icons.codeBlock,
    run: block((c) => c.toggleCodeBlock()),
  },
  {
    id: "quote",
    label: "Blockquote",
    keywords: "quote citation",
    hint: ">",
    icon: icons.quote,
    run: block((c) => c.toggleBlockquote()),
  },
  {
    id: "collapsible",
    label: "Collapsible section",
    keywords: "toggle details fold accordion",
    hint: "+++",
    icon: icons.collapsible,
    run: block((c) => c.setCollapsible()),
  },
  {
    id: "table",
    label: "Table",
    keywords: "grid rows columns",
    icon: icons.table,
    run: block((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })),
  },
  {
    id: "divider",
    label: "Divider",
    keywords: "horizontal rule hr line separator",
    hint: "---",
    icon: icons.divider,
    run: block((c) => c.setHorizontalRule()),
  },
  {
    id: "mention",
    label: "Mention",
    keywords: "person member agent issue at",
    hint: "@",
    icon: icons.mention,
    run: (editor, range) => editor.chain().focus().insertContentAt(range, "@").run(),
  },
  {
    id: "emoji",
    label: "Emoji",
    keywords: "smiley icon",
    hint: ":",
    icon: icons.emoji,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      const { from } = editor.state.selection;
      const caret = editor.view.coordsAtPos(from);
      openEmojiPicker({
        anchor: {
          getBoundingClientRect: () =>
            new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top),
        },
        onPick: (emoji) => editor.chain().focus().insertContent(emoji).run(),
        onClose: () => editor.commands.focus(),
      });
    },
  },
];

export const slashKey = new PluginKey("slash");

export const SlashCommands = Extension.create({
  name: "slashCommands",
  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestionItem, SuggestionItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: "/",
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => {
          const q = query.toLowerCase();
          return COMMANDS.filter((c) => `${c.label} ${c.keywords}`.toLowerCase().includes(q)).map(
            (c) => ({
              id: c.id,
              label: c.label,
              icon: c.icon,
              hint: c.hint,
              run: ({ editor, range }) => c.run(editor, range),
            }),
          );
        },
        command: ({ editor, range, props }) => props.run({ editor, range }),
        render: suggestionMenu,
      }),
    ];
  },
});
