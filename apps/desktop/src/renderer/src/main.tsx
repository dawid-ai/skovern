import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/controls.css";
import "./styles/select.css";
import "./styles/replies.css";
import "./styles/lists.css";
import "./styles/tables.css";
import "./styles/content.css";
import "./styles/shell.css";
import "./styles/bubbles.css";
import "./styles/chat.css";
import "./styles/receipts.css";
import "./styles/receipt-rows.css";
import "./styles/brain.css";
import "./styles/your-brain.css";
import "./styles/pages.css";
import "./styles/update-notice.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
