/* Toasts, desktop notifications, the shared tooltip, and appearance notifications. */

import { $, el, show } from "./dom.js";

const ICONS = {
  good:     `<svg class="ico" aria-hidden="true"><use href="#ico-check"/></svg>`,
  warning:  `<svg class="ico" aria-hidden="true"><use href="#ico-alert-triangle"/></svg>`,
  critical: `<svg class="ico" aria-hidden="true"><use href="#ico-alert-circle"/></svg>`,
  info:     `<svg class="ico" aria-hidden="true"><use href="#ico-info"/></svg>`,
};

export function toast(kind, message, ms = 6000) {
  const node = el("div", { class: "toast", attrs: { "data-kind": kind, role: "status" } }, [
    el("span", { class: "ico", html: ICONS[kind] || ICONS.info, attrs: { "aria-hidden": "true" } }),
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

/* Redraw canvas visualizations when the system appearance changes. */
export function onThemeChange(fn) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", fn);
  return () => media.removeEventListener("change", fn);
}
