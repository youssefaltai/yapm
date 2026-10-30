import { Extension, InputRule } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import {
  type EmojiEntry,
  loadEmoji,
  lookupEmoji,
  recordEmojiUse,
  searchEmoji,
  skinStore,
  withSkin,
} from "../emoji/data.js";
import { type SuggestionItem, suggestionMenu } from "./SuggestionMenu.js";

export const emojiKey = new PluginKey("emoji");

/** Linear's emoji picker: type `:` and two letters of a shortcode. */
export const Emoji = Extension.create({
  name: "emoji",
  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestionItem, SuggestionItem>({
        editor: this.editor,
        pluginKey: emojiKey,
        char: ":",
        minQueryLength: 2,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: async ({ query }) => {
          const data = await loadEmoji();
          return searchEmoji(data, query, 8).map((entry: EmojiEntry) => {
            const emoji = withSkin(entry, skinStore.get());
            return {
              id: entry.id,
              label: `:${entry.id}:`,
              icon: <span className="emoji text-[17px]">{emoji}</span>,
              run: ({ editor, range }) => {
                recordEmojiUse(entry.id);
                editor.chain().focus().insertContentAt(range, `${emoji} `).run();
              },
            };
          });
        },
        command: ({ editor, range, props }) => props.run({ editor, range }),
        render: suggestionMenu,
      }),
    ];
  },
  addInputRules() {
    // `:tada:` typed in full becomes the emoji, as in Linear. Typing the `:` query loads the set.
    return [
      new InputRule({
        find: /(?:^|\s):([a-z0-9_+-]+):$/,
        handler: ({ state, range, match }) => {
          const entry = match[1] ? lookupEmoji(match[1]) : undefined;
          if (!entry) return null;
          const emoji = withSkin(entry, skinStore.get());
          const start = range.from + (match[0].startsWith(":") ? 0 : 1);
          state.tr.insertText(emoji, start, range.to);
        },
      }),
    ];
  },
});
