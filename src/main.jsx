import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-bengali";
import "./styles.css";
import App from "./App.jsx";

function mount() {
  const container = document.getElementById("root");
  if (!container) {
    console.error("Root element #root not found!");
    return;
  }
  try {
    const root = createRoot(container);
    root.render(<App />);
  } catch (err) {
    console.error("Error rendering React app:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}

