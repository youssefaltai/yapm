/** Markdown as one line of plain text, for previews like Inbox rows. */
export function plainText(markdown: string | null | undefined) {
  return (markdown ?? "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|\+\+\+\s*)/gm, "")
    .replace(/^\s*(?:-{3,}|\*{3,}|\|?[\s:|-]+\|[\s:|-]*)$/gm, "")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
