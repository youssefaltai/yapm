import { useRef } from "react";
import type { Anchor } from "../controls.js";
import { mutate } from "../data.js";
import type { MenuItem, MenuSpec } from "../ui.js";
import {
  displayEmoji,
  type EmojiData,
  type EmojiEntry,
  isShortcode,
  loadEmoji,
  lookupEmoji,
  recordEmojiUse,
  searchEmoji,
  skinStore,
  useEmojiData,
  withSkin,
} from "./data.js";
import { openEmojiPicker } from "./EmojiPicker.js";

export interface Reaction {
  id: string;
  emoji: string;
  user: { id: string; name: string; isMe: boolean };
}

export type ReactionTarget = { issueId?: string; commentId?: string };

/** Linear's quick reactions, offered first in the right-click menu. */
const QUICK = ["+1", "-1", "heart", "tada", "smile", "eyes", "rocket", "pray"];

function toggleReaction(reactions: Reaction[], emoji: string, target: ReactionTarget) {
  const key = displayEmoji(emoji);
  const mine = reactions.find((r) => r.user.isMe && displayEmoji(r.emoji) === key);
  if (mine)
    return mutate("mutation($id: String!) { reactionDelete(id: $id) { success } }", {
      id: mine.id,
    });
  return mutate(
    "mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }",
    { input: { emoji, ...target } },
  );
}

const names = (list: Reaction[]) => {
  const people = list.map((r) => (r.user.isMe ? "You" : r.user.name));
  return people.length > 1
    ? `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}`
    : (people[0] ?? "");
};

/** Opens the full picker to add a reaction, beside the button that asked. */
export function openReactionPicker(anchor: Anchor, reactions: Reaction[], target: ReactionTarget) {
  openEmojiPicker({
    anchor,
    selected: reactions.filter((r) => r.user.isMe).map((r) => displayEmoji(r.emoji)),
    onPick: (emoji) => void toggleReaction(reactions, emoji, target),
  });
}

/** The right-click "Add reaction" submenu: quick reactions, search, and the full picker. */
export async function reactionMenu(
  reactions: Reaction[],
  target: ReactionTarget,
  anchor: () => Anchor | null,
): Promise<MenuSpec> {
  const data = await loadEmoji();
  const mine = new Set(reactions.filter((r) => r.user.isMe).map((r) => displayEmoji(r.emoji)));
  const item = (entry: EmojiEntry): MenuItem => {
    const emoji = withSkin(entry, skinStore.get());
    return {
      id: entry.id,
      label: entry.name,
      keywords: `${entry.id} ${entry.keywords.join(" ")}`,
      icon: <span className="emoji text-[15px]">{emoji}</span>,
      checked: mine.has(emoji) || mine.has(entry.skins[0] ?? ""),
      onSelect: () => {
        recordEmojiUse(entry.id);
        void toggleReaction(reactions, emoji, target);
      },
    };
  };
  return {
    placeholder: "Add reaction…",
    items: [
      ...QUICK.flatMap((id) => {
        const entry = data.byId.get(id);
        return entry ? [item(entry)] : [];
      }),
      {
        id: "more",
        label: "More emoji…",
        icon: <SmileyPlus size={15} />,
        onSelect: () => {
          const at = anchor();
          if (at) openReactionPicker(at, reactions, target);
        },
      },
    ],
    search: async (query) =>
      searchEmoji(data, query, 30)
        .filter((entry) => !QUICK.includes(entry.id))
        .map(item),
  };
}

/** Reactions under an issue or a comment, as pills you click to add or remove yours. */
export function Reactions({
  reactions,
  target,
  addWhenEmpty = true,
}: {
  reactions: Reaction[];
  target: ReactionTarget;
  /** Show the add button with no reactions yet; comments offer it in their hover actions. */
  addWhenEmpty?: boolean;
}) {
  const addRef = useRef<HTMLButtonElement>(null);
  // Older reactions may be stored as shortcodes like `+1`; those need the emoji set to draw.
  const data: EmojiData | undefined = useEmojiData(reactions.some((r) => isShortcode(r.emoji)));
  const groups = new Map<string, Reaction[]>();
  for (const r of reactions) {
    const key = displayEmoji(r.emoji, data);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (!groups.size && !addWhenEmpty) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {[...groups].map(([emoji, list]) => {
        const isMine = list.some((r) => r.user.isMe);
        const entry = lookupEmoji(emoji, data);
        const shortcode = entry ? `:${entry.id}:` : emoji;
        return (
          <button
            key={emoji}
            type="button"
            aria-pressed={isMine}
            aria-label={`${emoji} ${list.length}: ${names(list)} reacted with ${shortcode}`}
            title={`${names(list)} reacted with ${shortcode}`}
            onClick={() => void toggleReaction(reactions, emoji, target)}
            className={`flex h-[26px] animate-pop-in items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-[12px] tabular-nums transition-colors ${
              isMine
                ? "border-accent/50 bg-accent/15 text-ink hover:bg-accent/25"
                : "border-line bg-raised/40 text-muted hover:border-faint/60 hover:text-ink"
            }`}
          >
            <span className="emoji text-[15px]">{emoji}</span>
            <span>{list.length}</span>
          </button>
        );
      })}
      <button
        ref={addRef}
        type="button"
        aria-label="Add reaction"
        title="Add reaction"
        onClick={() => addRef.current && openReactionPicker(addRef.current, reactions, target)}
        className="flex h-[26px] w-[30px] items-center justify-center rounded-full border border-transparent text-faint transition hover:border-line hover:bg-raised hover:text-ink"
      >
        <SmileyPlus />
      </button>
    </div>
  );
}

/** A smiley with a plus, Linear's "add reaction" icon. */
export function SmileyPlus({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M13.9 8.6A6 6 0 1 1 7.4 2.1" />
      <path d="M5.5 9.6a3 3 0 0 0 5 0" />
      <path d="M6 6.4v.3M9.8 6.4v.3" />
      <path d="M12.5 1.5v4M10.5 3.5h4" />
    </svg>
  );
}
