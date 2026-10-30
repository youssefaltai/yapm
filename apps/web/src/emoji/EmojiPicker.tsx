import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Anchor, Popover } from "../controls.js";
import { createStore, useStore } from "../ui.js";
import {
  type EmojiEntry,
  recordEmojiUse,
  searchEmoji,
  setSkin,
  useEmojiData,
  useFrequentEmoji,
  useSkin,
  withSkin,
} from "./data.js";

// Linear's emoji picker: search, frequently used, categories you can jump between, skin
// tones, and a preview of the emoji under the pointer with its shortcode.

const COLUMNS = 9;

interface Section {
  id: string;
  name: string;
  emojis: EmojiEntry[];
}

const TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];
const TONE_NAMES = ["Default", "Light", "Medium-light", "Medium", "Medium-dark", "Dark"];

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Line icons for the category tabs, drawn like the app's other icons. */
const TAB_ICONS: Record<string, ReactNode> = {
  frequent: (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Glyph>
  ),
  people: (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 9.5a3 3 0 0 0 5 0" />
      <path d="M6 6.3v.4M10 6.3v.4" />
    </Glyph>
  ),
  nature: (
    <Glyph>
      <path d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10Z" />
      <path d="M3 13 9 7" />
    </Glyph>
  ),
  foods: (
    <Glyph>
      <path d="M3.5 7h9l-1 6.5h-7L3.5 7Z" />
      <path d="M6 7V5.5a2 2 0 0 1 4 0V7" />
    </Glyph>
  ),
  activity: (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="M2.5 6.5c3 1 8 1 11 0M2.5 9.5c3-1 8-1 11 0" />
    </Glyph>
  ),
  places: (
    <Glyph>
      <path d="M3 10.5 4.2 6.5A1.5 1.5 0 0 1 5.6 5.5h4.8a1.5 1.5 0 0 1 1.4 1L13 10.5v2H3v-2Z" />
      <path d="M3 10.5h10M5 12.5v1M11 12.5v1" />
    </Glyph>
  ),
  objects: (
    <Glyph>
      <path d="M6 12h4M6.5 14h3" />
      <path d="M8 2a4 4 0 0 0-2.2 7.3c.4.3.7.8.7 1.2V11h3v-.5c0-.4.3-.9.7-1.2A4 4 0 0 0 8 2Z" />
    </Glyph>
  ),
  symbols: (
    <Glyph>
      <path d="M8 13.5S2.5 10.3 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3c0 4-5.5 7.2-5.5 7.2Z" />
    </Glyph>
  ),
  flags: (
    <Glyph>
      <path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8" />
    </Glyph>
  ),
};

export interface EmojiPickerProps {
  onPick: (emoji: string, entry: EmojiEntry) => void;
  /** Emoji to mark as already chosen, like your own reactions. */
  selected?: string[];
}

/** The picker itself, without a popover: search, tabs, grid and preview. */
export function EmojiPicker({ onPick, selected = [] }: EmojiPickerProps) {
  const data = useEmojiData();
  const skin = useSkin();
  const frequent = useFrequentEmoji();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState("frequent");
  const [toning, setToning] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);

  const sections = useMemo<Section[]>(() => {
    if (!data) return [];
    if (query.trim()) {
      return [{ id: "search", name: "Search results", emojis: searchEmoji(data, query, 180) }];
    }
    return [
      {
        id: "frequent",
        name: "Frequently used",
        emojis: frequent.flatMap((id) => data.byId.get(id) ?? []),
      },
      ...data.categories,
    ];
  }, [data, query, frequent]);

  // Each section starts a new row, so arrow keys move by rows within and across sections.
  const { flat, rows, rowOf } = useMemo(() => {
    const flat: EmojiEntry[] = [];
    const rows: number[][] = [];
    const rowOf: number[] = [];
    for (const section of sections) {
      section.emojis.forEach((entry, i) => {
        if (i % COLUMNS === 0) rows.push([]);
        rows[rows.length - 1]?.push(flat.length);
        rowOf.push(rows.length - 1);
        flat.push(entry);
      });
    }
    return { flat, rows, rowOf };
  }, [sections]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search starts at the top
  useEffect(() => {
    setActive(0);
    scroller.current?.scrollTo({ top: 0 });
  }, [query]);

  useLayoutEffect(() => {
    if (!keyboard.current) return;
    scroller.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (entry: EmojiEntry) => {
    recordEmojiUse(entry.id);
    onPick(withSkin(entry, skin), entry);
  };

  const move = (event: KeyboardEvent) => {
    if (!flat.length) return;
    const row = rowOf[active] ?? 0;
    const col = rows[row]?.indexOf(active) ?? 0;
    const inRow = (r: number) => {
      const cells = rows[r];
      return cells ? (cells[Math.min(col, cells.length - 1)] ?? active) : active;
    };
    const next: Record<string, () => number> = {
      ArrowRight: () => Math.min(active + 1, flat.length - 1),
      ArrowLeft: () => Math.max(active - 1, 0),
      ArrowDown: () => inRow(Math.min(row + 1, rows.length - 1)),
      ArrowUp: () => inRow(Math.max(row - 1, 0)),
    };
    const go = next[event.key];
    if (go) {
      // Left and right still move the caret while there's text to edit.
      if (query && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
      event.preventDefault();
      keyboard.current = true;
      setActive(go());
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = flat[active];
      if (entry) pick(entry);
    }
  };

  const jump = (id: string) => {
    setQuery("");
    setTab(id);
    const el = scroller.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && scroller.current) scroller.current.scrollTop = el.offsetTop;
  };

  // The tab follows the section at the top of the grid.
  const onScroll = () => {
    const box = scroller.current;
    if (!box || query) return;
    let current = "frequent";
    for (const el of box.querySelectorAll<HTMLElement>("[data-section]")) {
      if (el.offsetTop <= box.scrollTop + 8) current = el.dataset.section ?? current;
    }
    setTab(current);
  };

  const preview = flat[active];
  const mine = new Set(selected);
  let index = 0;

  return (
    <div className="flex h-[min(352px,70vh)] w-[min(340px,calc(100vw-18px))] flex-col">
      <div className="flex items-center gap-1.5 border-line border-b px-2 py-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-raised px-2.5">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="text-faint">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="m10.5 10.5 3 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            // biome-ignore lint/a11y/noAutofocus: the picker opens to type into
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={move}
            placeholder="Search emoji…"
            aria-label="Search emoji"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint"
          />
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label="Skin tone"
            title="Skin tone"
            onClick={() => setToning((v) => !v)}
            className="emoji flex size-8 items-center justify-center rounded-md text-[17px] hover:bg-raised"
          >
            {TONES[skin]}
          </button>
          {toning && (
            <fieldset
              aria-label="Skin tone"
              className="absolute top-9 right-0 z-10 m-0 flex animate-pop-in gap-0.5 rounded-lg border border-line bg-panel p-1 shadow-xl"
            >
              {TONES.map((tone, i) => (
                <button
                  key={tone}
                  type="button"
                  aria-pressed={i === skin}
                  aria-label={TONE_NAMES[i]}
                  title={TONE_NAMES[i]}
                  onClick={() => {
                    setSkin(i);
                    setToning(false);
                  }}
                  className={`emoji flex size-8 items-center justify-center rounded-md text-[17px] hover:bg-raised ${
                    i === skin ? "bg-raised" : ""
                  }`}
                >
                  {tone}
                </button>
              ))}
            </fieldset>
          )}
        </div>
      </div>

      <div className="flex justify-between border-line border-b px-1.5" role="tablist">
        {[{ id: "frequent", name: "Frequently used" }, ...(data?.categories ?? [])].map((c) => {
          const current = !query && tab === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={current}
              aria-label={c.name}
              title={c.name}
              onClick={() => jump(c.id)}
              className={`relative flex h-8 flex-1 items-center justify-center ${
                current ? "text-ink" : "text-faint hover:text-muted"
              }`}
            >
              {TAB_ICONS[c.id]}
              <span
                className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent transition-opacity ${
                  current ? "opacity-100" : "opacity-0"
                }`}
              />
            </button>
          );
        })}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
      >
        {!data && <Status>Loading emoji…</Status>}
        {data && !flat.length && <Status>No emoji match “{query}”</Status>}
        {sections.map((section) =>
          section.emojis.length ? (
            <div key={section.id} data-section={section.id}>
              <p className="sticky top-0 z-[1] bg-panel/95 px-1.5 pt-2 pb-1 font-medium text-[11px] text-faint backdrop-blur-sm">
                {section.name}
              </p>
              <div className="grid grid-cols-9">
                {section.emojis.map((entry) => {
                  const i = index++;
                  const native = withSkin(entry, skin);
                  const chosen = mine.has(native) || mine.has(entry.skins[0] ?? "");
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      data-index={i}
                      aria-label={entry.name}
                      onMouseEnter={() => {
                        keyboard.current = false;
                        setActive(i);
                      }}
                      onClick={() => pick(entry)}
                      aria-pressed={chosen || undefined}
                      className={`emoji flex aspect-square items-center justify-center rounded-md text-[22px] leading-none transition-transform active:scale-90 ${
                        chosen
                          ? i === active
                            ? "bg-accent/30"
                            : "bg-accent/20"
                          : i === active
                            ? "bg-raised"
                            : ""
                      }`}
                    >
                      {native}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null,
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2.5 border-line border-t px-3">
        {preview ? (
          <>
            <span className="emoji text-[24px] leading-none">{withSkin(preview, skin)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">{preview.name}</span>
              <span className="block truncate text-[11px] text-faint">:{preview.id}:</span>
            </span>
          </>
        ) : (
          <span className="text-faint">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return <p className="px-2 py-8 text-center text-faint">{children}</p>;
}

// Host ------------------------------------------------------------------------

interface OpenPicker {
  anchor: Anchor;
  onPick: (emoji: string, entry: EmojiEntry) => void;
  selected?: string[];
  /** Called after the picker closes, picked or not, e.g. to refocus an editor. */
  onClose?: () => void;
}

const pickerStore = createStore<OpenPicker | null>(null);

/** Opens the emoji picker beside an element or a caret, and closes it after a pick. */
export function openEmojiPicker(options: OpenPicker) {
  pickerStore.set(options);
}

export function EmojiPickerHost() {
  const open = useStore(pickerStore);
  if (!open) return null;
  const close = () => {
    pickerStore.set(null);
    open.onClose?.();
  };
  return (
    <Popover anchor={open.anchor} onClose={close} label="Emoji picker">
      <EmojiPicker
        selected={open.selected}
        onPick={(emoji, entry) => {
          open.onPick(emoji, entry);
          close();
        }}
      />
    </Popover>
  );
}
