import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { type RefObject, useEffect, useRef } from "react";
import { navigate } from "../router.js";
import { editorExtensions } from "./extensions.js";
import { linkRequests, Toolbar } from "./Toolbar.js";
import "./editor.css";

export interface RichEditorProps {
  /** The Markdown to show. Changing it from outside replaces the content. */
  value: string;
  /** Every edit, as Markdown. */
  onChange?: (markdown: string) => void;
  /** Called on blur, only if the text was edited since it was last loaded. */
  onBlur?: (markdown: string) => void;
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  /** Escape; without it, Escape just leaves the editor. */
  onEscape?: () => void;
  placeholder?: string;
  /** The accessible name, like a textarea's label. */
  label?: string;
  autoFocus?: boolean;
  editable?: boolean;
  className?: string;
}

function editorKeys(props: RefObject<RichEditorProps>) {
  return [
    Extension.create({
      name: "editorSubmitKeys",
      // Ahead of the built-in keymap, so Cmd+Enter submits even from inside a code block.
      priority: 1000,
      addKeyboardShortcuts() {
        return {
          "Mod-Enter": () => {
            if (!props.current.onSubmit) return false;
            props.current.onSubmit();
            return true;
          },
          "Mod-k": ({ editor }) => {
            if (editor.state.selection.empty) return false;
            linkRequests.dispatchEvent(new CustomEvent("open", { detail: editor }));
            return true;
          },
        };
      },
    }),
    Extension.create({
      name: "editorEscapeKey",
      // Below the menus, so Escape closes an open slash or mention menu first.
      priority: 50,
      addKeyboardShortcuts() {
        return {
          Escape: ({ editor }) => {
            if (props.current.onEscape) props.current.onEscape();
            else editor.commands.blur();
            return true;
          },
        };
      },
    }),
  ];
}

/** Opens links: in place for the hub's own pages, in a new tab otherwise. */
function openLink(href: string) {
  const url = new URL(href, location.href);
  if (url.origin === location.origin) navigate(url.pathname + url.search);
  else window.open(url.href, "_blank", "noopener,noreferrer");
}

/**
 * Linear's editor: Markdown shortcuts as you type, `/` for blocks, `@` for people and issues,
 * `:` for emoji, a toolbar over selected text, and Markdown in and out.
 */
export function RichEditor(props: RichEditorProps) {
  const editable = props.editable ?? true;
  const propsRef = useRef(props);
  propsRef.current = props;
  const loaded = useRef(props.value);
  const dirty = useRef(false);

  const editor = useEditor(
    {
      extensions: [
        ...editorExtensions({ placeholder: props.placeholder, editable }),
        ...editorKeys(propsRef),
      ],
      content: props.value,
      contentType: "markdown",
      editable,
      autofocus: props.autoFocus ? "end" : false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: `rich ${props.className ?? ""}`,
          ...(props.label ? { "aria-label": props.label } : {}),
          ...(editable ? { role: "textbox", "aria-multiline": "true" } : {}),
          spellcheck: editable ? "true" : "false",
        },
        handleClick: (view, _pos, event) => {
          const link = (event.target as HTMLElement).closest("a[href]");
          if (!link || !view.dom.contains(link)) return false;
          if (view.editable && !(event.metaKey || event.ctrlKey)) return false;
          event.preventDefault();
          openLink(link.getAttribute("href") ?? "");
          return true;
        },
      },
      onUpdate: ({ editor: e }) => {
        const markdown = e.getMarkdown();
        loaded.current = markdown;
        dirty.current = true;
        propsRef.current.onChange?.(markdown);
      },
      onBlur: ({ editor: e, event }) => {
        // Moving into the toolbar or a menu isn't leaving the editor.
        const next = event.relatedTarget as HTMLElement | null;
        if (next?.closest("[data-editor-menu], [role=toolbar]")) return;
        if (!dirty.current) return;
        dirty.current = false;
        propsRef.current.onBlur?.(e.getMarkdown());
      },
    },
    [editable],
  );

  // A new value from outside (the server, or a cleared composer) replaces the content, unless
  // it's what we just emitted or you're in the middle of editing.
  useEffect(() => {
    if (!editor || props.value === loaded.current) return;
    if (editor.isFocused && dirty.current) return;
    loaded.current = props.value;
    dirty.current = false;
    editor.commands.setContent(props.value, { contentType: "markdown", emitUpdate: false });
  }, [editor, props.value]);

  if (!editor) return null;
  return (
    <>
      <EditorContent editor={editor} />
      {editable && <Toolbar editor={editor} />}
    </>
  );
}
