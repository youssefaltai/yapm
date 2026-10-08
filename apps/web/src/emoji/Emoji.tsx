import { displayEmoji, isShortcode, useEmojiData } from "./data.js";

/** One stored emoji or shortcode, drawn in colour. */
export function Emoji({ value, className = "" }: { value: string; className?: string }) {
  const data = useEmojiData(isShortcode(value));
  return <span className={`emoji ${className}`}>{displayEmoji(value, data)}</span>;
}
