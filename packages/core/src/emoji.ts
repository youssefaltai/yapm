import { SHORTCODES } from "./emoji-shortcodes.js";
import { badRequest } from "./errors.js";

/** Variation selector 16, which asks for an emoji to draw in colour rather than as text. */
const VS16 = String.fromCodePoint(0xfe0f);

let byName: Map<string, string> | undefined;
let qualified: Map<string, string> | undefined;

function tables() {
  if (!byName || !qualified) {
    byName = new Map();
    qualified = new Map();
    const parts = SHORTCODES.split(" ");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const name = parts[i] as string;
      const emoji = parts[i + 1] as string;
      byName.set(name, emoji);
      // "❤" with and without VS16 is the same emoji; keep the form that renders in colour.
      if (emoji.includes(VS16)) qualified.set(emoji.replaceAll(VS16, ""), emoji);
    }
  }
  return { byName, qualified };
}

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/**
 * Turns what a person or an agent typed into one emoji: `👍`, `+1` and `:+1:` all become `👍`,
 * so the same reaction always groups together and never shows as text.
 */
export function normalizeEmoji(input: string): string {
  const value = input.trim();
  const name = value.replace(/^:(.+):$/, "$1").toLowerCase();
  if (/^[\w+-]+$/.test(name)) {
    const emoji = tables().byName.get(name);
    if (!emoji) throw badRequest(`Unknown emoji ":${name}:"`);
    return emoji;
  }
  if (!PICTOGRAPH.test(value))
    throw badRequest("Emoji must be an emoji or a shortcode like :tada:");
  const bare = value.replaceAll(VS16, "");
  return tables().qualified.get(bare) ?? value;
}
