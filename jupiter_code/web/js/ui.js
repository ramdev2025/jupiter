/* Toasts, desktop notifications, the shared tooltip, and the theme toggle. */

import { $, el, show } from "./dom.js";

const ICONS = { good: "✓", warning: "⚠", critical: "⚠", info: "ℹ" };

export function toast(kind, message, ms = 6000) {
  const node = el("div", { class: "toast", attrs: { "data-kind": kind, role: "status" } }, [
    el("span", { class: "ico", text: ICONS[kind] || ICONS.info, attrs: { "aria-hidden": "true" } }),
    el("span", { class: "msg", text: message }),
  ]);
  $("toasts").append(node);
  setTimeout(() => node.remove(), ms);
}

export function notify(title, body, tag) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch (_) { /* notifications unavailable in this context */ }
}

export async function requestNotifyPermission() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/* ---- tooltip -------------------------------------------------------- */

export function showTip(ev, text) {
  const tip = $("tip");
  tip.textContent = text;
  show(tip, true);
  const pad = 12;
  const rect = tip.getBoundingClientRect();
  let x = ev.clientX + pad;
  if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, ev.clientY - rect.height - pad)}px`;
}

export function hideTip() { show($("tip"), false); }

/* ---- theme ---------------------------------------------------------- */

const THEME_KEY = "jupiter.theme";
const listeners = new Set();

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  for (const fn of listeners) fn(next);
  return next;
}

/** Re-run when the theme changes - canvas/SVG strokes read themed tokens. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
