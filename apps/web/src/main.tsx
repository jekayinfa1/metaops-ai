import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import OAuthDone from "./screens/OAuthDone";
import "./index.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* PWA is progressive enhancement */ });
  });
}

const isOAuthDone = window.location.pathname === "/oauth/facebook/done";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isOAuthDone ? <OAuthDone /> : <App />}
  </StrictMode>
);
