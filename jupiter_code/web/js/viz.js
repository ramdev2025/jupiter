/* The two data marks: a trend sparkline and the expiry meter. */

import { clear, show } from "./dom.js";
import { showTip, hideTip } from "./ui.js";
import { POLL_MS } from "./store.js";

const W = 160, H = 40, PAD = 5;

function svgNode(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * A 12-point trend line for a stat tile: history in the de-emphasised step of
 * the accent ramp, the current value as an accent end-dot. The dot carries a
 * 2px ring in the surface colour so it stays legible over the line.
 */
export function drawSpark(svg, data, label = "claimed") {
  if (!svg) return;
  if (!data || data.length < 2) { show(svg, false); return; }
  show(svg, true);
  clear(svg);

  const peak = Math.max(1, ...data);
  const step = W / (data.length - 1);
  const pts = data.map((v, i) => [i * step, H - PAD - (v / peak) * (H - PAD * 2)]);

  svg.append(svgNode("polyline", {
    points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    fill: "none",
    stroke: "var(--accent-quiet)",
    "stroke-width": "2",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  }));

  const [cx, cy] = pts[pts.length - 1];
  svg.append(svgNode("circle", {
    cx: cx.toFixed(1), cy: cy.toFixed(1), r: "4",
    fill: "var(--accent)", stroke: "var(--surface-1)", "stroke-width": "2",
  }));

  // Hover reads a value off the line; the tile's own number and the claims
  // table still carry every value, so the tooltip only ever enhances.
  svg.onpointermove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H) || 1;
    const i = Math.max(0, Math.min(data.length - 1,
      Math.round(((ev.clientX - rect.left) / scale) / step)));
    const ago = (data.length - 1 - i) * (POLL_MS / 1000);
    showTip(ev, `${data[i]} ${label} · ${ago === 0 ? "now" : `${ago}s ago`}`);
  };
  svg.onpointerleave = hideTip;
}

/**
 * Size and colour an expiry meter. The fill encodes time remaining only -
 * conflict lives in the badge - so the two channels never confuse each other.
 */
export function paintMeter(meter, fill, fraction) {
  const frac = Math.max(0, Math.min(1, fraction || 0));
  fill.style.width = `${(frac * 100).toFixed(1)}%`;
  meter.dataset.urgency = frac > 0.5 ? "ok" : frac > 0.2 ? "warning" : "critical";
}
