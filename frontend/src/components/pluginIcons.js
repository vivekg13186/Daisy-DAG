// Plugin icon registry.
// =========================
// Two flavours of icon a plugin can render:
//
//   1. brand — a single-path SVG (24x24 viewBox, simple-icons style)
//      with a brand colour. Used for recognisable third-party services
//      (Jira, GitHub, npm, …).
//   2. material — a Quasar / Material Symbols icon name plus a colour.
//      Used for the built-in plugins (file, csv, http, agent, …) and
//      for brands where we don't have a verified SVG path yet.
//
// Resolution order (PluginIcon component):
//   • exact match on the plugin name        e.g. "jira"
//   • prefix match on dot-separated name    e.g. "google-sheets.search" → "google-sheets"
//   • generic fallback (the puzzle-piece "extension" icon)
//
// Adding a new brand:
//   • If you have the simple-icons SVG path data (CC0), drop it under
//     BRAND_ICONS with `type: "brand"`.
//   • If you don't, use `type: "material"` + a sensible Material icon
//     name plus the brand colour. Looks decent even without the logo.
//   • simple-icons.org has 3k+ logos; copy the `d` attribute from the
//     SVG download — it's a single <path>.

const BRAND_ICONS = {
  // ── Known SVG paths (simple-icons, CC0) ─────────────────────────────
  jira: {
    type: "brand",
    color: "#0052CC",
    path: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.762a1.005 1.005 0 0 0-1.001-1.005zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057a5.215 5.215 0 0 0 5.215 5.214V1.005A1.005 1.005 0 0 0 23.013 0z",
  },
  github: {
    type: "brand",
    color: "#181717",
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  git: {
    type: "brand",
    color: "#F05032",
    path: "M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187",
  },
  npm: {
    type: "brand",
    color: "#CB3837",
    path: "M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0v1.336H8.001V8.667h5.334v5.332h-2.669v-.001zm12.001 0h-1.33v-4h-1.336v4h-1.335v-4h-1.33v4h-2.671V8.667h8.002v5.331zM10.665 10H12v2.667h-1.335V10z",
  },
  slack: {
    type: "brand",
    color: "#4A154B",
    path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  },
  reddit: {
    type: "brand",
    color: "#FF4500",
    path: "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12.5c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z",
  },

  // ── No verified SVG yet — Material icon with brand colour ───────────
  "google-sheets":   { type: "material", color: "#0F9D58", icon: "grid_on" },
  "microsoft-teams": { type: "material", color: "#6264A7", icon: "groups" },
  openai:            { type: "material", color: "#412991", icon: "psychology" },
  anthropic:         { type: "material", color: "#D97757", icon: "psychology" },
};

// Material icons for the built-in plugins. Coloured neutrally; users
// can recolour by editing this table — the icon component falls back
// to the theme's text colour when no `color` is set.
const MATERIAL_ICONS = {
  "http.request": "language",
  "web.scrape":   "public",
  "sql":          "storage",
  "email.send":   "mail_outline",
  "file":         "description",
  "csv":          "table_view",
  "excel":        "grid_on",
  "log":          "terminal",
  "delay":        "timer",
  "transform":    "transform",
  "condition":    "rule",
  "agent":        "psychology",
  "memory":       "save",
  "user":         "person",
  "workflow.fire":"play_arrow",
  "shell.exec":   "terminal",
  "ssh":          "lan",
  "ftp":          "folder_shared",
  "mqtt":         "router",
  "default":      "extension",
};

// Resolve plugin name (e.g. "jira", "google-sheets.search", "csv.read")
// to an icon descriptor: { type, color?, icon?, path? }.
export function resolvePluginIcon(action) {
  if (!action) return { type: "material", icon: MATERIAL_ICONS.default };

  // 1. Exact brand match.
  if (BRAND_ICONS[action]) return BRAND_ICONS[action];

  // 2. Prefix brand match — for plugins like "jira" we just want jira's
  //    icon; for "jira.something" we still want it (n8n-style: one icon
  //    per integration regardless of operation).
  const prefix = action.split(".")[0];
  if (BRAND_ICONS[prefix]) return BRAND_ICONS[prefix];

  // 3. Exact Material map.
  if (MATERIAL_ICONS[action]) return { type: "material", icon: MATERIAL_ICONS[action] };

  // 4. Prefix Material map.
  if (MATERIAL_ICONS[prefix]) return { type: "material", icon: MATERIAL_ICONS[prefix] };

  // 5. Generic fallback.
  return { type: "material", icon: MATERIAL_ICONS.default };
}
