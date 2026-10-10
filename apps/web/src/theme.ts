// Light, dark or following the system, like Linear's theme setting. The choice lives in this
// browser; index.html applies it before the first paint so there's no flash.

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "yapm-theme";
const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function themeChoice(): ThemeChoice {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function apply(choice: ThemeChoice) {
  const theme = choice === "system" ? (dark() ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0f0f10" : "#fcfcfc");
}

export function setTheme(choice: ThemeChoice) {
  if (choice === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  // Cross-fade the palette swap where the browser can; motion.css sets its pace.
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !calm) document.startViewTransition(() => apply(choice));
  else apply(choice);
}

/** Keeps "system" in step when the OS switches between light and dark. */
export function watchTheme() {
  apply(themeChoice());
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => apply(themeChoice()));
}
