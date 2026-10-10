import { useEffect } from "react";
import { createStore, useStore } from "../ui.js";

// The full emoji set loads on demand from @emoji-mart/data (Unicode 15, Apple's order),
// so it stays out of the main bundle until a picker or a shortcode needs it.

export interface EmojiEntry {
  /** The shortcode, like `tada` or `+1`. */
  id: string;
  name: string;
  keywords: string[];
  /** The default emoji first, then the five skin tones when the emoji has them. */
  skins: string[];
}

export interface EmojiCategory {
  id: string;
  name: string;
  emojis: EmojiEntry[];
}

export interface EmojiData {
  categories: EmojiCategory[];
  byId: Map<string, EmojiEntry>;
  /** Any form of an emoji, with or without skin tone or U+FE0F, to its entry. */
  byNative: Map<string, EmojiEntry>;
}

const CATEGORY_NAMES: Record<string, string> = {
  people: "Smileys & People",
  nature: "Animals & Nature",
  foods: "Food & Drink",
  activity: "Activity",
  places: "Travel & Places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags",
};

interface RawData {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<
    string,
    { id: string; name: string; keywords: string[]; skins: { native: string }[] }
  >;
  aliases: Record<string, string>;
}

/** Variation selector 16, which asks for an emoji to draw in colour rather than as text. */
const VS16 = String.fromCodePoint(0xfe0f);
const bare = (native: string) => native.replaceAll(VS16, "");

let loading: Promise<EmojiData> | undefined;
let loaded: EmojiData | undefined;
const loadedStore = createStore<EmojiData | undefined>(undefined);

export function loadEmoji(): Promise<EmojiData> {
  loading ??= import("@emoji-mart/data/sets/15/native.json").then((module) => {
    const raw = (module.default ?? module) as unknown as RawData;
    const byId = new Map<string, EmojiEntry>();
    const byNative = new Map<string, EmojiEntry>();
    const entries = new Map<string, EmojiEntry>();
    for (const e of Object.values(raw.emojis)) {
      const entry: EmojiEntry = {
        id: e.id,
        name: e.name,
        keywords: e.keywords,
        skins: e.skins.map((s) => s.native),
      };
      entries.set(e.id, entry);
      byId.set(e.id, entry);
      for (const native of entry.skins) {
        byNative.set(native, entry);
        byNative.set(bare(native), entry);
      }
    }
    for (const [alias, id] of Object.entries(raw.aliases)) {
      const entry = entries.get(id);
      if (entry) byId.set(alias, entry);
    }
    const categories = raw.categories.map((c) => ({
      id: c.id,
      name: CATEGORY_NAMES[c.id] ?? c.id,
      emojis: c.emojis.flatMap((id) => entries.get(id) ?? []),
    }));
    loaded = { categories, byId, byNative };
    loadedStore.set(loaded);
    return loaded;
  });
  return loading;
}

/** The emoji set, or undefined while it loads. Starts loading on first use. */
export function useEmojiData(enabled = true): EmojiData | undefined {
  const data = useStore(loadedStore);
  useEffect(() => {
    if (enabled && !data) void loadEmoji();
  }, [enabled, data]);
  return data;
}

/** The entry for an emoji or a shortcode (`👍`, `+1`, `:tada:`), once the set has loaded. */
export function lookupEmoji(value: string, data = loaded): EmojiEntry | undefined {
  if (!data) return undefined;
  const name = value.replace(/^:(.+):$/, "$1");
  return data.byId.get(name) ?? data.byNative.get(value) ?? data.byNative.get(bare(value));
}

/** Whether a stored value is a shortcode rather than the emoji itself, like older `+1` reactions. */
export const isShortcode = (value: string) => /^:?[\w+-]+:?$/.test(value);

/**
 * The emoji to show for a stored value: shortcodes become the emoji, and text-style
 * forms like `❤` gain U+FE0F so they draw in colour.
 */
export function displayEmoji(value: string, data = loaded): string {
  const entry = lookupEmoji(value, data);
  if (!entry) return value;
  if (isShortcode(value)) return entry.skins[0] ?? value;
  const index = entry.skins.findIndex((s) => bare(s) === bare(value));
  return index >= 0 ? (entry.skins[index] ?? value) : value;
}

// Search --------------------------------------------------------------------

/**
 * Emoji matching a query, best first: exact shortcode, then shortcodes and names that
 * start with it, then any word or keyword that does.
 */
export function searchEmoji(data: EmojiData, query: string, limit = Infinity): EmojiEntry[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  if (!q) return [];
  const scored: [number, number, EmojiEntry][] = [];
  let order = 0;
  for (const category of data.categories) {
    for (const entry of category.emojis) {
      order++;
      const name = entry.name.toLowerCase();
      let score = -1;
      if (entry.id === q) score = 0;
      else if (entry.id.startsWith(q)) score = 1;
      else if (name.startsWith(q)) score = 2;
      else if (entry.id.split(/[_-]/).some((w) => w.startsWith(q))) score = 3;
      else if (name.split(" ").some((w) => w.startsWith(q))) score = 4;
      else if (entry.keywords.some((k) => k.startsWith(q))) score = 5;
      else if (q.length > 2 && (entry.id.includes(q) || name.includes(q))) score = 6;
      if (score >= 0) scored.push([score, order, entry]);
    }
  }
  // Among prefix matches the shortest wins, so `hea` finds ❤️ `heart` before `heart_eyes`.
  scored.sort(
    (a, b) => a[0] - b[0] || (a[0] <= 2 ? a[2].id.length - b[2].id.length : 0) || a[1] - b[1],
  );
  return scored.slice(0, limit).map(([, , entry]) => entry);
}

// Preferences ---------------------------------------------------------------

const SKIN_KEY = "yapm-emoji-skin";
const RECENT_KEY = "yapm-emoji-recent";

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** 0 is the default yellow; 1 to 5 are light to dark. */
export const skinStore = createStore<number>(read(SKIN_KEY, 0));

export function setSkin(tone: number) {
  skinStore.set(tone);
  write(SKIN_KEY, tone);
}

/** The emoji in the chosen skin tone, when it has tones. */
export const withSkin = (entry: EmojiEntry, tone: number) =>
  entry.skins[tone] ?? entry.skins[0] ?? "";

// Frequently used: a count per shortcode that decays, so new favourites rise quickly.
type Usage = Record<string, number>;
const DEFAULT_RECENT = [
  "+1",
  "heart",
  "tada",
  "smile",
  "eyes",
  "rocket",
  "pray",
  "white_check_mark",
];
const recentStore = createStore<Usage>(read(RECENT_KEY, {}));

export function recordEmojiUse(id: string) {
  const usage: Usage = {};
  for (const [key, count] of Object.entries(recentStore.get())) {
    const decayed = count * 0.95;
    if (decayed > 0.2) usage[key] = decayed;
  }
  usage[id] = (usage[id] ?? 0) + 1;
  recentStore.set(usage);
  write(RECENT_KEY, usage);
}

/** Shortcodes for the "Frequently used" row: the most used, topped up with Linear's defaults. */
export function useFrequentEmoji(count = 16): string[] {
  const usage = useStore(recentStore);
  const ids = Object.entries(usage)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  for (const id of DEFAULT_RECENT) if (!ids.includes(id)) ids.push(id);
  return ids.slice(0, count);
}

/** Re-renders when the chosen skin tone changes. */
export function useSkin(): number {
  return useStore(skinStore);
}
