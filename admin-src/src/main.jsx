import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { applyTheme, readTheme } from "./theme.js";

// الوضع يُطبَّق قبل أول رسم — الفاتح افتراضياً (KANAF-ORD-0008 §2.3).
applyTheme(readTheme());

createRoot(document.getElementById("root")).render(<App />);
