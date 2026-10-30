import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/** One row in the slash, mention or emoji menu. */
export interface SuggestionItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown faint on the right, like the Markdown shortcut for a block. */
  hint?: string;
  section?: string;
  run: (props: { editor: SuggestionProps["editor"]; range: SuggestionProps["range"] }) => void;
}

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

interface MenuProps {
  items: SuggestionItem[];
  command: (item: SuggestionItem) => void;
  loading?: boolean;
}

const SuggestionList = forwardRef<MenuHandle, MenuProps>(function SuggestionList(
  { items, command, loading },
  ref,
) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new results reset the highlight
  useEffect(() => setActive(0), [items]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
        setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
        setActive((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[active];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (!items.length && !loading) return null;
  let lastSection: string | undefined;
  return (
    <div
      ref={listRef}
      role="listbox"
      className="max-h-80 w-64 origin-top-left animate-pop-in overflow-y-auto rounded-lg border border-line bg-panel p-1 text-[13px] shadow-2xl"
    >
      {!items.length && <p className="px-2 py-1.5 text-faint">Searching…</p>}
      {items.map((item, index) => {
        const header = item.section && item.section !== lastSection ? item.section : null;
        lastSection = item.section;
        return (
          <div key={item.id}>
            {header && <p className="px-2 pt-2 pb-1 text-[11px] text-faint">{header}</p>}
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              data-index={index}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => {
                // Keep the editor's selection; choosing happens on click.
                e.preventDefault();
              }}
              onClick={() => command(item)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                index === active ? "bg-raised text-ink" : "text-ink/90"
              }`}
            >
              {item.icon && (
                <span className="flex min-w-4 shrink-0 justify-center text-muted">{item.icon}</span>
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[11px] text-faint">{item.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
});

/** Shows a suggestion plugin's items in a floating menu under the typed trigger. */
export function suggestionMenu() {
  let renderer: ReactRenderer<MenuHandle, MenuProps> | null = null;
  let unmount: (() => void) | null = null;
  return {
    onStart: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => {
      renderer = new ReactRenderer(SuggestionList, {
        editor: props.editor,
        props: { items: props.items, command: props.command, loading: props.loading },
      });
      const el = renderer.element as HTMLElement;
      el.style.zIndex = "60";
      el.dataset.editorMenu = "";
      document.body.appendChild(el);
      unmount = props.mount(el);
    },
    onUpdate: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => {
      renderer?.updateProps({ items: props.items, command: props.command, loading: props.loading });
    },
    onKeyDown: (props: SuggestionKeyDownProps) => renderer?.ref?.onKeyDown(props) ?? false,
    onExit: () => {
      unmount?.();
      unmount = null;
      renderer?.destroy();
      renderer?.element.remove();
      renderer = null;
    },
  };
}
