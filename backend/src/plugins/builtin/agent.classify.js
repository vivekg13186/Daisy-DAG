// agent.classify — single-label or multi-label classification.
//
// Pick one (or several) labels from a fixed list to describe the
// input text. Returns labels + per-label confidences in a stable
// shape that's easy to branch on downstream (executeIf, transform).
//
// Single-label mode (default):
//   labels = ["billing", "tech", "feedback"]
//   → { label: "tech", confidence: 0.78, scores: { billing: 0.07, tech: 0.78, feedback: 0.15 } }
//
// Multi-label mode (multiLabel: true):
//   labels = ["bug", "performance", "ui", "docs"]
//   → { labels: ["bug","performance"], scores: { bug: 0.83, performance: 0.62, ui: 0.10, docs: 0.05 } }
//   (threshold defaults to 0.5; tune via `threshold` input)
//
// Like agent.extract, the bound agent is used for provider creds +
// guardrails + telemetry. The agent's prompt is ignored — this
// plugin builds its own.

import { loadAgent, tryParseJson } from "../agent/util.js";
import { runOneShot } from "../agent/structured.js";

const DEFAULT_THRESHOLD = 0.5;

export default {
  name: "agent.classify",
  category: "ai",
  description:
    "Classify the input text into one of the supplied labels " +
    "(single-label mode, default) or multiple labels (multiLabel:true). " +
    "Returns the picked label(s) + per-label confidences. The bound " +
    "agent supplies provider creds + guardrails; its prompt is ignored.",

  inputSchema: {
    type: "object",
    required: ["agent", "labels", "text"],
    properties: {
      agent: {
        type: "string",
        title: "Agent",
        minLength: 1,
        description:
          "Title of a stored agent (Home → Agents). Used for provider " +
          "creds + guardrails + cost tracking.",
      },
      labels: {
        title: "Labels",
        description:
          "Array of label strings. Usually a `${var}` reference. " +
          "Example: [\"billing\",\"tech\",\"feedback\"].",
      },
      text: {
        type: "string",
        title: "Input text",
        format: "textarea",
        description: "Text to classify. Usually a `${var}` reference.",
      },
      multiLabel: {
        type: "boolean", default: false,
        title: "Multi-label mode",
        description:
          "When true, the plugin may return multiple labels — anything " +
          "scoring above `threshold` is included.",
      },
      threshold: {
        type: "number", minimum: 0, maximum: 1, default: DEFAULT_THRESHOLD,
        title: "Multi-label threshold",
        description: "Score above which a label is considered chosen (multi-label only).",
      },
      instruction: {
        type: "string",
        title: "Extra instruction",
        format: "textarea",
        description:
          "Optional plain-English nudge — for example, a definition for " +
          "an ambiguous label.",
      },
      maxTokens: {
        type: "integer", minimum: 1, maximum: 4000, default: 512,
        title: "Max output tokens",
      },
    },
  },

  primaryOutput: "label",

  outputSchema: {
    type: "object",
    required: ["scores"],
    properties: {
      label:      { type: ["string", "null"], description: "Picked label (single-label mode). Null if no label passed sanity checks." },
      labels:     { type: "array",             description: "Picked labels (multi-label mode)." },
      confidence: { type: ["number", "null"],  description: "Confidence on `label` (single-label)." },
      scores:     { type: "object",            description: "Per-label score map (every requested label)." },
      raw:        { type: "string" },
      usage:      { type: "object" },
    },
  },

  async execute(input, ctx, hooks) {
    const labels = normaliseLabels(input.labels);
    if (labels.length < 2) {
      throw new Error("agent.classify: `labels` must be an array of at least 2 distinct strings");
    }
    const multiLabel = !!input.multiLabel;
    const threshold  = clamp01(input.threshold ?? DEFAULT_THRESHOLD);
    const maxTokens  = input.maxTokens ?? 512;
    const text       = String(input.text ?? "");

    const { agent, cfg } = await loadAgent(ctx, input.agent);

    const systemPrompt = buildClassifySystem(labels, multiLabel, input.instruction);

    const { text: rawText, usage } = await runOneShot({
      agent, cfg,
      systemPrompt,
      userText:      text,
      maxTokens,
      ctx, hooks,
      telemetryKind: "classify",
    });

    const parsed = tryParseJson(rawText) || {};
    const scores = normaliseScores(parsed.scores, labels);

    if (multiLabel) {
      const picked = labels.filter(l => scores[l] >= threshold);
      return {
        labels:     picked,
        label:      null,
        confidence: null,
        scores,
        raw:        rawText,
        usage,
      };
    }
    // Single-label: pick the max-scoring label.
    let bestLabel = null, bestScore = -Infinity;
    for (const l of labels) {
      if (scores[l] > bestScore) { bestScore = scores[l]; bestLabel = l; }
    }
    return {
      label:      bestLabel,
      confidence: bestScore === -Infinity ? null : bestScore,
      labels:     bestLabel ? [bestLabel] : [],
      scores,
      raw:        rawText,
      usage,
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function normaliseLabels(raw) {
  // Accept either a real array or a JSON string (literal pasted in
  // the property panel). Trim + dedupe so a wonky input still works.
  let arr = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[")) { try { arr = JSON.parse(t); } catch { /* fall through */ } }
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out  = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function buildClassifySystem(labels, multiLabel, instruction) {
  const labelList = labels.map(l => `  - ${l}`).join("\n");
  const lines = [
    "You are a classification model.",
    multiLabel
      ? "Read the user's text and decide which of the labels below apply (any number, possibly zero)."
      : "Read the user's text and decide which single label below best applies.",
    "",
    "Labels:",
    labelList,
    "",
    "Emit a SINGLE JSON object with this exact shape:",
    `  {"scores": {"<label>": <number 0-1>, ...}}`,
    "",
    "Rules:",
    "- Include EVERY label from the list as a key in `scores` (use 0 when irrelevant).",
    "- Values must be numbers between 0 and 1 — your confidence that the label applies.",
    multiLabel
      ? `- Multiple labels may score above the picker's threshold; do not artificially zero them out.`
      : `- Exactly one label should score noticeably higher than the rest (the winner).`,
    "- Output JSON only — no markdown, no commentary, no fenced code block.",
  ];
  if (instruction) {
    lines.push("", "Additional instruction:", instruction);
  }
  return lines.join("\n");
}

function normaliseScores(rawScores, labels) {
  // Build a complete {label: number} map. Missing labels → 0;
  // out-of-range values clamped; non-numbers coerced or zeroed.
  const out = {};
  const src = rawScores && typeof rawScores === "object" ? rawScores : {};
  for (const l of labels) {
    const v = src[l];
    if (typeof v === "number" && isFinite(v)) {
      out[l] = clamp01(v);
    } else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      out[l] = clamp01(Number(v));
    } else {
      out[l] = 0;
    }
  }
  return out;
}

function clamp01(n) {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return n > 100 ? 0 : (n > 1 ? (n / 100) : n);
  return n;
}
