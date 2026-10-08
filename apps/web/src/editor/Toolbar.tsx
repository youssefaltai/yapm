import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { icons } from "./icons.js";

function Button({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-7 min-w-7 items-center justify-center rounded px-1.5 ${
        active ? "bg-raised text-ink" : "text-muted hover:bg-raised hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />;
}

/** Opens the link field in the toolbar, from the button or Cmd+K. */
export const linkRequests = new EventTarget();

/** Linear's formatting toolbar: it floats over selected text. */
export function Toolbar({ editor }: { editor: Editor }) {
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      numbered: e.isActive("orderedList"),
      check: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
    }),
  });

  const openLink = () => {
    setHref((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinking(true);
  };

  useEffect(() => {
    const onRequest = (event: Event) => {
      if ((event as CustomEvent<Editor>).detail === editor) openLink();
    };
    linkRequests.addEventListener("open", onRequest);
    return () => linkRequests.removeEventListener("open", onRequest);
  });

  useEffect(() => {
    if (linking) inputRef.current?.focus();
  }, [linking]);

  const applyLink = () => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url)
      chain.setLink({ href: /^[a-z][\w+.-]*:|^\//i.test(url) ? url : `https://${url}` }).run();
    else chain.unsetLink().run();
    setLinking(false);
  };

  const heading = (level: 1 | 2 | 3) => editor.chain().focus().toggleHeading({ level }).run();

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8, onHide: () => setLinking(false) }}
      shouldShow={({ editor: e, state: s }) =>
        e.isEditable && !s.selection.empty && !e.isActive("codeBlock") && !e.isActive("mention")
      }
      className="z-50"
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex origin-bottom animate-pop-in items-center gap-0.5 rounded-lg border border-line bg-panel p-1 text-[13px] shadow-2xl"
      >
        {linking ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
          >
            <input
              ref={inputRef}
              aria-label="Link"
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setLinking(false);
                  editor.commands.focus();
                }
              }}
              placeholder="Paste or type a link…"
              className="w-60 bg-transparent px-2 py-1 outline-none placeholder:text-faint"
            />
            <Button label="Apply link" onClick={applyLink}>
              ↵
            </Button>
            {state.link && (
              <Button
                label="Remove link"
                onClick={() => {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  setLinking(false);
                }}
              >
                ✕
              </Button>
            )}
          </form>
        ) : (
          <>
            <Button
              label="Bold"
              active={state.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              {icons.bold}
            </Button>
            <Button
              label="Italic"
              active={state.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              {icons.italic}
            </Button>
            <Button
              label="Strikethrough"
              active={state.strike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              {icons.strike}
            </Button>
            <Button
              label="Code"
              active={state.code}
              onClick={() => editor.chain().focus().toggleCode().run()}
            >
              {icons.code}
            </Button>
            <Button label="Link" active={state.link} onClick={openLink}>
              {icons.link}
            </Button>
            <Divider />
            <Button label="Heading 1" active={state.h1} onClick={() => heading(1)}>
              {icons.h1}
            </Button>
            <Button label="Heading 2" active={state.h2} onClick={() => heading(2)}>
              {icons.h2}
            </Button>
            <Button label="Heading 3" active={state.h3} onClick={() => heading(3)}>
              {icons.h3}
            </Button>
            <Divider />
            <Button
              label="Bulleted list"
              active={state.bullet}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              {icons.bullet}
            </Button>
            <Button
              label="Numbered list"
              active={state.numbered}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              {icons.numbered}
            </Button>
            <Button
              label="Checklist"
              active={state.check}
              onClick={() => editor.chain().focus().toggleTaskList().run()}
            >
              {icons.check}
            </Button>
            <Button
              label="Blockquote"
              active={state.quote}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            >
              {icons.quote}
            </Button>
            <Button
              label="Code block"
              active={state.codeBlock}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              {icons.codeBlock}
            </Button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
