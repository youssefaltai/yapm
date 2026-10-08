import { Extension, InputRule } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { type SuggestionItem, suggestionMenu } from "./SuggestionMenu.js";

/** Common emoji by their Slack and GitHub shortcodes, typed as `:name`. */
const EMOJI: [string, string][] = [
  ["+1", "👍"],
  ["thumbsup", "👍"],
  ["-1", "👎"],
  ["thumbsdown", "👎"],
  ["smile", "😄"],
  ["grin", "😁"],
  ["joy", "😂"],
  ["rofl", "🤣"],
  ["slightly_smiling_face", "🙂"],
  ["wink", "😉"],
  ["blush", "😊"],
  ["heart_eyes", "😍"],
  ["thinking", "🤔"],
  ["neutral_face", "😐"],
  ["expressionless", "😑"],
  ["unamused", "😒"],
  ["roll_eyes", "🙄"],
  ["grimacing", "😬"],
  ["relieved", "😌"],
  ["sleeping", "😴"],
  ["sunglasses", "😎"],
  ["nerd", "🤓"],
  ["confused", "😕"],
  ["worried", "😟"],
  ["cry", "😢"],
  ["sob", "😭"],
  ["scream", "😱"],
  ["angry", "😠"],
  ["rage", "😡"],
  ["exploding_head", "🤯"],
  ["partying_face", "🥳"],
  ["upside_down", "🙃"],
  ["shrug", "🤷"],
  ["facepalm", "🤦"],
  ["pray", "🙏"],
  ["clap", "👏"],
  ["wave", "👋"],
  ["raised_hands", "🙌"],
  ["muscle", "💪"],
  ["ok_hand", "👌"],
  ["point_right", "👉"],
  ["point_up", "☝️"],
  ["eyes", "👀"],
  ["brain", "🧠"],
  ["heart", "❤️"],
  ["orange_heart", "🧡"],
  ["yellow_heart", "💛"],
  ["green_heart", "💚"],
  ["blue_heart", "💙"],
  ["purple_heart", "💜"],
  ["broken_heart", "💔"],
  ["fire", "🔥"],
  ["sparkles", "✨"],
  ["star", "⭐"],
  ["zap", "⚡"],
  ["boom", "💥"],
  ["tada", "🎉"],
  ["confetti_ball", "🎊"],
  ["rocket", "🚀"],
  ["100", "💯"],
  ["white_check_mark", "✅"],
  ["heavy_check_mark", "✔️"],
  ["x", "❌"],
  ["warning", "⚠️"],
  ["no_entry", "⛔"],
  ["question", "❓"],
  ["exclamation", "❗"],
  ["bulb", "💡"],
  ["memo", "📝"],
  ["pencil", "✏️"],
  ["pushpin", "📌"],
  ["paperclip", "📎"],
  ["link", "🔗"],
  ["lock", "🔒"],
  ["key", "🔑"],
  ["bell", "🔔"],
  ["calendar", "📅"],
  ["clock", "🕐"],
  ["hourglass", "⏳"],
  ["alarm_clock", "⏰"],
  ["chart_with_upwards_trend", "📈"],
  ["chart_with_downwards_trend", "📉"],
  ["bar_chart", "📊"],
  ["moneybag", "💰"],
  ["dollar", "💵"],
  ["credit_card", "💳"],
  ["receipt", "🧾"],
  ["bank", "🏦"],
  ["house", "🏠"],
  ["car", "🚗"],
  ["airplane", "✈️"],
  ["package", "📦"],
  ["gift", "🎁"],
  ["shopping_cart", "🛒"],
  ["email", "📧"],
  ["phone", "📱"],
  ["computer", "💻"],
  ["gear", "⚙️"],
  ["wrench", "🔧"],
  ["hammer", "🔨"],
  ["bug", "🐛"],
  ["construction", "🚧"],
  ["mag", "🔍"],
  ["books", "📚"],
  ["book", "📖"],
  ["mortar_board", "🎓"],
  ["trophy", "🏆"],
  ["medal", "🏅"],
  ["dart", "🎯"],
  ["checkered_flag", "🏁"],
  ["triangular_flag", "🚩"],
  ["seedling", "🌱"],
  ["evergreen_tree", "🌲"],
  ["sunny", "☀️"],
  ["cloud", "☁️"],
  ["rainbow", "🌈"],
  ["snowflake", "❄️"],
  ["coffee", "☕"],
  ["tea", "🍵"],
  ["pizza", "🍕"],
  ["apple", "🍎"],
  ["avocado", "🥑"],
  ["cake", "🍰"],
  ["beer", "🍺"],
  ["wine_glass", "🍷"],
  ["running", "🏃"],
  ["weight_lifting", "🏋️"],
  ["bike", "🚲"],
  ["yoga", "🧘"],
  ["pill", "💊"],
  ["hospital", "🏥"],
  ["dog", "🐶"],
  ["cat", "🐱"],
  ["unicorn", "🦄"],
  ["robot", "🤖"],
  ["ghost", "👻"],
  ["skull", "💀"],
  ["poop", "💩"],
  ["see_no_evil", "🙈"],
  ["handshake", "🤝"],
  ["speech_balloon", "💬"],
  ["thought_balloon", "💭"],
  ["zzz", "💤"],
  ["recycle", "♻️"],
  ["arrow_right", "➡️"],
  ["arrow_left", "⬅️"],
  ["arrow_up", "⬆️"],
  ["arrow_down", "⬇️"],
  ["red_circle", "🔴"],
  ["yellow_circle", "🟡"],
  ["green_circle", "🟢"],
  ["blue_circle", "🔵"],
];

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
        items: ({ query }) => {
          const q = query.toLowerCase();
          const seen = new Set<string>();
          return EMOJI.filter(([name, emoji]) => {
            if (!name.includes(q) || seen.has(emoji)) return false;
            seen.add(emoji);
            return true;
          })
            .sort(([a], [b]) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)))
            .slice(0, 8)
            .map(([name, emoji]) => ({
              id: name,
              label: `:${name}:`,
              icon: <span className="text-[14px]">{emoji}</span>,
              run: ({ editor, range }) =>
                editor.chain().focus().insertContentAt(range, `${emoji} `).run(),
            }));
        },
        command: ({ editor, range, props }) => props.run({ editor, range }),
        render: suggestionMenu,
      }),
    ];
  },
  addInputRules() {
    // `:tada:` typed in full becomes the emoji, as in Linear.
    const map = new Map(EMOJI);
    return [
      new InputRule({
        find: /(?:^|\s):([a-z0-9_+-]+):$/,
        handler: ({ state, range, match }) => {
          const emoji = match[1] ? map.get(match[1]) : undefined;
          if (!emoji) return null;
          const start = range.from + (match[0].startsWith(":") ? 0 : 1);
          state.tr.insertText(emoji, start, range.to);
        },
      }),
    ];
  },
});
