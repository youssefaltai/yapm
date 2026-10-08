import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { common, createLowlight } from "lowlight";
import { useState } from "react";
import { icons } from "./icons.js";

const lowlight = createLowlight(common);

const LANGUAGES: [string, string][] = [
  ["", "Plain text"],
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["graphql", "GraphQL"],
  ["xml", "HTML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["markdown", "Markdown"],
  ["php", "PHP"],
  ["python", "Python"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["scss", "SCSS"],
  ["shell", "Shell"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
];

function languageName(language: string | null) {
  if (!language) return "Plain text";
  return LANGUAGES.find(([id]) => id === language)?.[1] ?? language;
}

function CodeBlockView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const language = (node.attrs.language as string | null) ?? "";
  const [copied, setCopied] = useState(false);
  const known = LANGUAGES.some(([id]) => id === language);
  return (
    <NodeViewWrapper className="code-block">
      <div className="code-block-bar" contentEditable={false}>
        {editor.isEditable ? (
          <select
            aria-label="Code language"
            value={language}
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
          >
            {!known && <option value={language}>{language}</option>}
            {LANGUAGES.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <span>{languageName(language)}</span>
        )}
        <button
          type="button"
          aria-label="Copy code"
          title="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(node.textContent).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : icons.copy}
        </button>
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : ""} />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true });
