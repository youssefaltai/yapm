import { lazy, Suspense } from "react";
import type { RichEditorProps } from "./RichEditor.js";

// The editor is the biggest part of the app, so it loads on its own after the first paint.
const Editor = lazy(() => import("./RichEditor.js").then((m) => ({ default: m.RichEditor })));

/** Until the editor arrives, the Markdown shows as plain text in the same place. */
function Fallback({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`rich whitespace-pre-wrap ${className}`}>{text}</div>;
}

export function RichEditor(props: RichEditorProps) {
  return (
    <Suspense fallback={<Fallback text={props.value} className={props.className} />}>
      <Editor {...props} />
    </Suspense>
  );
}

/** Markdown from members and agents, shown exactly as the editor shows it. */
export function RichText({ source, className = "" }: { source: string; className?: string }) {
  return (
    <Suspense fallback={<Fallback text={source} className={className} />}>
      <Editor value={source} editable={false} className={className} />
    </Suspense>
  );
}
