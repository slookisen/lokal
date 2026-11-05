// ─── Owner pages: shared colour tokens, light and dark (eierportal T6) ──────
// dev-request 2026-10-30-rfb-eierportal-testrunde-1, T6 «felles drakt, lys og
// mørk». One set of CSS custom properties for the owner pages: «Mine valg»
// (OWNER_PAGE_CSS), the owner portal and the owner's «Mine ordrer» list. The
// light values are today's portal palette, the dark values the palette of
// «Mine valg»'s dark block. `prefers-color-scheme: dark` switches them.
//
// The portal and the orders list only get this CSS (in the body) for a
// subject on OWNER_FEATURES_ALLOWED_SUBJECTS; off the list those pages are
// byte-identical to before. The buyer's order card (ordersShell) never gets it.
//
// Contrast (checked in owner-ui-tokens-t6.test.ts): every text token on its
// background ≥ 4.5:1, every component border / focus colour ≥ 3:1, in both
// themes. Three values changed for that: the input border (#d4d4d4 → #8f8f8f
// light, #4a5640 → #6b7a5e dark) and the dark primary-button hover (#5a9134 →
// #467729). Card borders and dividers are decorative and not checked; the
// logo's accent span is a logotype (WCAG 1.4.3 exception).

export interface OwnerToken {
  /** Custom property name without the leading `--`. */
  name: string;
  light: string;
  dark: string;
}

export const OWNER_TOKENS: readonly OwnerToken[] = [
  { name: "ow-page-bg", light: "#FEFAE0", dark: "#12150e" },
  { name: "ow-text", light: "#1a1a1a", dark: "#ebe8dc" },
  { name: "ow-surface", light: "#fff", dark: "#1c2116" },
  { name: "ow-border", light: "#e5e5e5", dark: "#313b27" },
  { name: "ow-divider", light: "#f0f0e8", dark: "#313b27" },
  { name: "ow-accent", light: "#2D5016", dark: "#b9d99a" },
  { name: "ow-accent-line", light: "#2D5016", dark: "#8fb86e" },
  { name: "ow-logo-accent", light: "#D4A373", dark: "#e2bf97" },
  { name: "ow-text-soft", light: "#404040", dark: "#b5b0a0" },
  { name: "ow-muted", light: "#595959", dark: "#b5b0a0" },
  { name: "ow-faint", light: "#737373", dark: "#b5b0a0" },
  { name: "ow-warn", light: "#92400e", dark: "#f5c27a" },
  { name: "ow-lock", light: "#b45309", dark: "#f5c27a" },
  { name: "ow-btn-primary-bg", light: "#2D5016", dark: "#4c7d2c" },
  { name: "ow-btn-primary-hover", light: "#3a6b1e", dark: "#467729" },
  { name: "ow-btn-primary-text", light: "#fff", dark: "#fff" },
  { name: "ow-btn-secondary-bg", light: "#fff", dark: "transparent" },
  { name: "ow-btn-secondary-text", light: "#2D5016", dark: "#cfe6b8" },
  { name: "ow-btn-secondary-hover", light: "#f3f7ee", dark: "#26301d" },
  { name: "ow-danger", light: "#dc2626", dark: "#fca5a5" },
  { name: "ow-badge-bg", light: "#f0f0e8", dark: "#2a3022" },
  { name: "ow-badge-text", light: "#404040", dark: "#d8d4c4" },
  { name: "ow-badge-new-bg", light: "#e7f2dc", dark: "#2f4a1c" },
  { name: "ow-badge-new-text", light: "#2D5016", dark: "#cfe6b8" },
  { name: "ow-input-bg", light: "#fff", dark: "#12150e" },
  { name: "ow-input-text", light: "#1a1a1a", dark: "#ebe8dc" },
  { name: "ow-input-border", light: "#8f8f8f", dark: "#6b7a5e" },
  { name: "ow-input-disabled-bg", light: "#fafafa", dark: "#1c2116" },
  { name: "ow-ok-bg", light: "#f0fdf4", dark: "#15301d" },
  { name: "ow-ok-text", light: "#166534", dark: "#bbf7d0" },
  { name: "ow-ok-line", light: "#bbf7d0", dark: "#24543a" },
  { name: "ow-err-bg", light: "#fef2f2", dark: "#3a1616" },
  { name: "ow-err-text", light: "#991b1b", dark: "#fecaca" },
  { name: "ow-err-line", light: "#fecaca", dark: "#6b2525" },
  { name: "ow-stat-bg", light: "#FEFAE0", dark: "#12150e" },
  { name: "ow-stat-line", light: "#f0e8c8", dark: "#313b27" },
  { name: "ow-pill-warn-bg", light: "#fdf3e7", dark: "#3a2a12" },
  { name: "ow-pill-warn-text", light: "#7a5218", dark: "#f5c27a" },
  { name: "ow-msg-own-bg", light: "#eef0ea", dark: "#26301d" },
  { name: "ow-msg-other-bg", light: "#fdf8ef", dark: "#1c2116" },
];

/** A colour pair the tests hold to a WCAG contrast minimum, in both themes. */
export interface OwnerContrastPair {
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for component borders and focus rings. */
  min: number;
}

export const OWNER_CONTRAST_PAIRS: readonly OwnerContrastPair[] = [
  { fg: "ow-text", bg: "ow-page-bg", min: 4.5 },
  { fg: "ow-text", bg: "ow-surface", min: 4.5 },
  { fg: "ow-accent", bg: "ow-page-bg", min: 4.5 },
  { fg: "ow-accent", bg: "ow-surface", min: 4.5 },
  { fg: "ow-text-soft", bg: "ow-surface", min: 4.5 },
  { fg: "ow-muted", bg: "ow-surface", min: 4.5 },
  { fg: "ow-faint", bg: "ow-surface", min: 4.5 },
  { fg: "ow-faint", bg: "ow-stat-bg", min: 4.5 },
  { fg: "ow-faint", bg: "ow-input-disabled-bg", min: 4.5 },
  { fg: "ow-accent", bg: "ow-stat-bg", min: 4.5 },
  { fg: "ow-warn", bg: "ow-surface", min: 4.5 },
  { fg: "ow-lock", bg: "ow-surface", min: 4.5 },
  { fg: "ow-danger", bg: "ow-surface", min: 4.5 },
  { fg: "ow-btn-primary-text", bg: "ow-btn-primary-bg", min: 4.5 },
  { fg: "ow-btn-primary-text", bg: "ow-btn-primary-hover", min: 4.5 },
  { fg: "ow-btn-secondary-text", bg: "ow-surface", min: 4.5 },
  { fg: "ow-btn-secondary-text", bg: "ow-btn-secondary-hover", min: 4.5 },
  { fg: "ow-badge-text", bg: "ow-badge-bg", min: 4.5 },
  { fg: "ow-badge-new-text", bg: "ow-badge-new-bg", min: 4.5 },
  { fg: "ow-input-text", bg: "ow-input-bg", min: 4.5 },
  { fg: "ow-ok-text", bg: "ow-ok-bg", min: 4.5 },
  { fg: "ow-err-text", bg: "ow-err-bg", min: 4.5 },
  { fg: "ow-pill-warn-text", bg: "ow-pill-warn-bg", min: 4.5 },
  { fg: "ow-text", bg: "ow-msg-own-bg", min: 4.5 },
  { fg: "ow-text", bg: "ow-msg-other-bg", min: 4.5 },
  { fg: "ow-input-border", bg: "ow-surface", min: 3 },
  { fg: "ow-input-border", bg: "ow-input-bg", min: 3 },
  { fg: "ow-accent-line", bg: "ow-surface", min: 3 },
  { fg: "ow-accent-line", bg: "ow-page-bg", min: 3 },
];

function tokenDecls(theme: "light" | "dark"): string {
  return OWNER_TOKENS.map((t) => `--${t.name}: ${t[theme]};`).join(" ");
}

/** The custom properties, light by default and dark under prefers-color-scheme. */
export const OWNER_TOKEN_CSS = `
  :root { color-scheme: light dark; ${tokenDecls("light")} }
  @media (prefers-color-scheme: dark) {
    :root { ${tokenDecls("dark")} }
  }
`;

// ─── Colour inline styles → token classes ──────────────────────────────────
// The allowlisted owner pages carry no inline style that sets a colour: each
// known colour declaration moves to a class on the tokens (light value =
// the old inline value). Unknown declarations are left as they are, which
// the T6 test catches.

const INLINE_COLOUR_CLASSES: Record<string, { cls: string; css: string }> = {
  "color:#737373": { cls: "ow-c-faint", css: "color: var(--ow-faint);" },
  "color:#7a5218": { cls: "ow-c-pill-warn", css: "color: var(--ow-pill-warn-text);" },
  "background:#fdf3e7": { cls: "ow-bg-pill-warn", css: "background: var(--ow-pill-warn-bg);" },
  "background:#eef0ea": { cls: "ow-bg-msg-own", css: "background: var(--ow-msg-own-bg);" },
  "background:#fdf8ef": { cls: "ow-bg-msg-other", css: "background: var(--ow-msg-other-bg);" },
};

function inlineClassCss(): string {
  return Object.values(INLINE_COLOUR_CLASSES).map((c) => `.${c.cls} { ${c.css} }`).join(" ");
}

/**
 * The portal's ep-* components on the tokens (same light look as
 * PORTAL_PALETTE_CSS in the head, apart from the input border), plus the
 * classes that replace colour inline styles (ownerThemeHtml). Body CSS for
 * an allowlisted subject's portal only.
 */
export const OWNER_PORTAL_THEME_CSS = `${OWNER_TOKEN_CSS}
  body { background: var(--ow-page-bg); color: var(--ow-text); }
  a, .ep-logo { color: var(--ow-accent); }
  .ep-logo span { color: var(--ow-logo-accent); }
  .ep-card { background: var(--ow-surface); border-color: var(--ow-border); }
  .ep-card h1, .ep-card h2 { color: var(--ow-accent); }
  .ep-card h2 { border-bottom-color: var(--ow-divider); }
  .ep-field label { color: var(--ow-text-soft); }
  .ep-field input, .ep-field textarea { color: var(--ow-input-text); background: var(--ow-input-bg); border-color: var(--ow-input-border); }
  .ep-field input:focus, .ep-field textarea:focus { outline-color: var(--ow-accent-line); border-color: var(--ow-accent-line); }
  .ep-field input[disabled], .ep-field textarea[disabled] { background: var(--ow-input-disabled-bg); color: var(--ow-faint); }
  .ep-field .ep-hint { color: var(--ow-faint); }
  .ep-field .ep-lock { color: var(--ow-lock); }
  .ep-btn-primary { background: var(--ow-btn-primary-bg); color: var(--ow-btn-primary-text); }
  .ep-btn-primary:hover, .ep-btn-primary:focus { background: var(--ow-btn-primary-hover); }
  .ep-btn-secondary { background: var(--ow-btn-secondary-bg); color: var(--ow-btn-secondary-text); border-color: var(--ow-accent-line); }
  .ep-btn-secondary:hover { background: var(--ow-btn-secondary-hover); }
  .ep-btn-ghost { color: var(--ow-faint); }
  .ep-btn-ghost:hover { color: var(--ow-danger); }
  .ep-alert-error { background: var(--ow-err-bg); color: var(--ow-err-text); border-color: var(--ow-err-line); }
  .ep-alert-ok { background: var(--ow-ok-bg); color: var(--ow-ok-text); border-color: var(--ow-ok-line); }
  .ep-stat { background: var(--ow-stat-bg); border-color: var(--ow-stat-line); }
  .ep-stat-num { color: var(--ow-accent); }
  .ep-stat-label, .ep-audit-meta { color: var(--ow-faint); }
  .ep-audit-item { border-bottom-color: var(--ow-divider); }
  @media (prefers-color-scheme: dark) { .ep-card { box-shadow: none; } }
  ${inlineClassCss()}
`;

/**
 * The owner's «Mine ordrer» list: its light palette stays the page's own
 * (ordersShell CSS in the head); the tokens add the dark theme, plus the
 * classes that replace colour inline styles. Body CSS, allowlisted only.
 */
export const OWNER_ORDERS_THEME_CSS = `${OWNER_TOKEN_CSS}
  @media (prefers-color-scheme: dark) {
    body { background: var(--ow-page-bg); color: var(--ow-text); }
    a, .mo-link { color: var(--ow-accent); }
    .mo-sub, .mo-date, .mo-hint, .mo-empty { color: var(--ow-muted); }
    .mo-items-line, .mo-pick-line, .mo-tl li { color: var(--ow-text-soft); }
    .mo-tab { background: var(--ow-surface); border-color: var(--ow-border); color: var(--ow-text); }
    .mo-tab[aria-current=page] { background: var(--ow-btn-primary-bg); color: var(--ow-btn-primary-text); border-color: var(--ow-btn-primary-bg); }
    .mo-count { background: var(--ow-badge-bg); color: var(--ow-badge-text); }
    .mo-tab[aria-current=page] .mo-count { background: var(--ow-surface); color: var(--ow-accent); }
    .mo-row { background: var(--ow-surface); border-color: var(--ow-border); }
    .mo-detail, .mo-items li { border-color: var(--ow-divider); }
    .mo-wait { background: var(--ow-pill-warn-bg); color: var(--ow-pill-warn-text); }
    .mo-ok { background: var(--ow-ok-bg); color: var(--ow-ok-text); }
    .mo-end { background: var(--ow-badge-bg); color: var(--ow-badge-text); }
    .mo-primary { background: var(--ow-btn-primary-bg); color: var(--ow-btn-primary-text); }
    .mo-secondary { background: var(--ow-badge-bg); color: var(--ow-text); border-color: var(--ow-input-border); }
    .mo-pick input { background: var(--ow-input-bg); color: var(--ow-input-text); border-color: var(--ow-input-border); }
    .mo-form textarea { background: var(--ow-input-bg); color: var(--ow-input-text); }
    .mo-menu summary { color: var(--ow-pill-warn-text); }
    .mo-banner.ok { background: var(--ow-ok-bg); color: var(--ow-ok-text); border-color: var(--ow-ok-line); }
    .mo-banner.warn { background: var(--ow-pill-warn-bg); color: var(--ow-pill-warn-text); border-color: var(--ow-pill-warn-text); }
  }
  ${inlineClassCss()}
`;

/**
 * Rewrites every opening tag's `style="…"` so a known colour declaration
 * becomes a token class (merged into an existing class attribute); the other
 * declarations stay inline, in order. A tag without a known colour
 * declaration is returned unchanged.
 */
export function ownerThemeHtml(html: string): string {
  return html.replace(/<[a-zA-Z][^<>]*\sstyle="[^"]*"[^<>]*>/g, (tag) => {
    const m = /\sstyle="([^"]*)"/.exec(tag);
    if (!m) return tag;
    const decls = m[1].split(";").map((d) => d.trim()).filter(Boolean);
    const classes: string[] = [];
    const kept: string[] = [];
    for (const d of decls) {
      const hit = INLINE_COLOUR_CLASSES[d.replace(/\s+/g, "")];
      if (hit) classes.push(hit.cls);
      else kept.push(d);
    }
    if (!classes.length) return tag;
    let out = kept.length
      ? tag.replace(m[0], ` style="${kept.join(";")};"`)
      : tag.replace(m[0], "");
    if (/\sclass="/.test(out)) out = out.replace(/\sclass="([^"]*)"/, (_s, c: string) => ` class="${c} ${classes.join(" ")}"`);
    else out = out.replace(/^<([a-zA-Z][\w-]*)/, (_s, n: string) => `<${n} class="${classes.join(" ")}"`);
    return out;
  });
}
