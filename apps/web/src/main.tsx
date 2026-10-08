import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { registerServiceWorker } from "./push.js";
import "./styles.css";
import { watchTheme } from "./theme.js";

watchTheme();
registerServiceWorker();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
