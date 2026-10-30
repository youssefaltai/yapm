import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DialogHost, TooltipHost } from "./controls.js";
import { registerServiceWorker } from "./push.js";
import "./styles.css";
import { watchTheme } from "./theme.js";

watchTheme();
registerServiceWorker();
// iOS ignores the viewport's maximum-scale for pinches; an app doesn't zoom.
document.addEventListener("gesturestart", (event) => event.preventDefault());

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
      <DialogHost />
      <TooltipHost />
    </StrictMode>,
  );
}
