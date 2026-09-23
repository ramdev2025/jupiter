/* DOM helpers.
 *
 * Rule this whole frontend keeps: teammate-supplied strings (file paths,
 * notes, display names, announcements) only ever reach the DOM through
 * textContent. `frag()` takes STATIC markup written in this codebase and
 * never interpolated data - bind data afterwards with .textContent.
 */

export const $ = (id) => document.getElementById(id);

/** Build an element. `text` is set via textContent, so it is always safe. */
export function el(tag, opts = {}, kids = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html;   // static markup only
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
  }
  if (opts.on) for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
  for (const kid of [].concat(kids)) if (kid != null) node.append(kid);
  return node;
}

/**
 * Parse a static markup string into a DocumentFragment.
 * NEVER pass interpolated user/teammate data to this.
 */
export function frag(markup) {
  const tpl = document.createElement("template");
  tpl.innerHTML = markup.trim();
  return tpl.content;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node, visible) {
  if (node) node.hidden = !visible;
}

/** Replace a container's children with one node/fragment. */
export function render(container, node) {
  clear(container);
  container.append(node);
}

/** Two initials for an avatar, from a display name. */
export function initials(name) {
  const parts = String(name || "?").trim().split(/[\s_-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Wire every [data-copy="<id>"] button in a subtree to the clipboard. */
export function wireCopyButtons(root, onFail) {
  for (const btn of root.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", async () => {
      const target = root.querySelector(`#${btn.dataset.copy}`) || $(btn.dataset.copy);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent);
        const was = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = was; }, 1400);
      } catch (_) {
        if (onFail) onFail();
      }
    });
  }
}
