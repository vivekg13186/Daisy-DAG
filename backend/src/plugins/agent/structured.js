// Shared one-shot LLM call used by agent.extract / agent.classify /
// agent.tools. Lives outside src/plugins/builtin/ so the plugin
// auto-loader doesn't register it as an action.
//
// What this gives each caller:
//   • A single function that bundles the bits every structured-output
//     plugin needs to do anyway: guardrails (input + output), quota
//     check, callProvider, cost rollup, telemetry. Saves each plugin
//     from re-implementing the same 100-line dance.
//   • A stateless contract — no conversation history, no prompt cache.
//     Structured plugins want determinism per call; history would
//     pollute results.
//
// The plugin supplies:
//   • the agent + cfg pair from loadAgent
//   • the *generated* system prompt (extract/classify build their own)
//   • the user text
//   • maxTokens
//
// Returns { text, usage, latencyMs }. The caller validates / parses
// the text per its own contract (JSON-schema for extract, label match
// for classify, tool-use for agent.tools).

import { callProvider } from "./util.js";
import { chargeTokens } from "../../engine/limits.js";
import {
  loadProjectPolicy,
  mergePolicy,
  applyGuardrails,
} from "../../guardrails/apply.js";

/**
 * runOneShot — single-turn LLM invocation with the full Daisy
 * production plumbing (guardrails / quota / cost rollup / telemetry).
 *
 *   await runOneShot({
 *     agent, cfg,                  // from loadAgent
 *     systemPrompt,                // plugin-generated
 *     userText,                    // post-templating user input
 *     maxTokens,                   // ceiling
 *     ctx, hooks,                  // engine plumbing
 *     telemetryKind,               // 'extract' | 'classify' | 'tools' — used as agent.kind in events
 *   })
 *
 * Returns { text, usage, latencyMs, redactedInput, redactedOutput }.
 *
 * Throws GuardrailBlockedError when a block-mode detector fires.
 * Throws BudgetExhaustedError when ctx-level token cap is hit.
 * Throws QUOTA_EXCEEDED when the project monthly token cap is hit.
 */
export async function runOneShot({
  agent, cfg,
  systemPrompt,
  userText,
  maxTokens = 1024,
  ctx, hooks,
  telemetryKind = "extract",
}) {
  const workspaceId = ctx?.execution?.workspaceId;
  const projectId   = ctx?.execution?.projectId;
  const guardrailCtx = {
    workspaceId,
    projectId,
    executionId: ctx?.execution?.id || null,
    node:        ctx?.node?.name || null,
    agentId:     agent.id,
    agentTitle:  agent.title,
  };
  const projectPolicy = await loadProjectPolicy(projectId);
  const policy = mergePolicy(projectPolicy, agent.guardrails_override);

  // ── Guardrails: input side ─────────────────────────────────────
  let finalUserText = String(userText ?? "");
  let redactedInput = false;
  {
    const r = await applyGuardrails({ text: finalUserText, side: "input", policy, ctx: guardrailCtx });
    if (r.text !== finalUserText) {
      finalUserText = r.text;
      redactedInput = true;
      if (hooks?.stream?.log) {
        hooks.stream.log("warn",
          `guardrails redacted input (${r.violations.map(v => v.detector).join(", ")})`);
      }
    }
    const warned = r.violations.filter(v => v.action_taken === "warned");
    if (warned.length && hooks?.stream?.log) {
      hooks.stream.log("warn",
        `guardrails flagged input: ${warned.map(v => v.detector).join(", ")}`);
    }
  }

  // ── Quota pre-call check ───────────────────────────────────────
  if (projectId) {
    try {
      const { assertQuota } = await import("../../auth/quotas.js");
      await assertQuota(projectId, "tokens_per_month");
    } catch (e) {
      if (e.code === "QUOTA_EXCEEDED") throw e;
      // Other errors are permissive (DB unreachable) — same policy as
      // the agent plugin.
    }
  }

  if (hooks?.stream?.log) {
    hooks.stream.log(
      "info",
      `${telemetryKind} via "${agent.title}" → ${cfg.provider}/${cfg.model}`,
    );
  }

  // ── LLM call ───────────────────────────────────────────────────
  const startedAt = Date.now();
  const { text: rawText, usage } = await callProvider({
    cfg,
    system:    systemPrompt,
    messages:  [{ role: "user", content: finalUserText }],
    maxTokens,
    // No streaming — structured plugins parse the full response.
    onText:    null,
  });
  const latencyMs = Date.now() - startedAt;
  const inTok  = Number(usage?.inputTokens)  || 0;
  const outTok = Number(usage?.outputTokens) || 0;
  chargeTokens(ctx, ctx?._parsed, inTok + outTok);

  // ── Quota increment + per-call telemetry ───────────────────────
  if (projectId) {
    try {
      const { incrementUsage } = await import("../../auth/quotas.js");
      incrementUsage(projectId, "tokens_per_month", inTok + outTok)
        .catch(() => {});
      const { recordAgentTokenEvent } = await import("./usage.js");
      recordAgentTokenEvent({
        workspaceId,
        projectId,
        executionId:  ctx?.execution?.id || null,
        agentId:      agent.id,
        agentTitle:   agent.title,
        provider:     cfg.provider,
        model:        cfg.model,
        inputTokens:  inTok,
        outputTokens: outTok,
        cacheHit:     false,
        latencyMs,
        // Captured in usage.kind so the admin /usage breakdown can
        // separate "classify" vs "extract" vs "chat" calls. The
        // recordAgentTokenEvent helper accepts the field even if the
        // current schema doesn't surface it — forward-compatible.
        kind:         telemetryKind,
      }).catch(() => {});
    } catch { /* ignore — telemetry-grade */ }
  }

  // ── Guardrails: output side ────────────────────────────────────
  let finalText = rawText;
  let redactedOutput = false;
  {
    const r = await applyGuardrails({ text: finalText, side: "output", policy, ctx: guardrailCtx });
    if (r.text !== finalText) {
      finalText = r.text;
      redactedOutput = true;
      if (hooks?.stream?.log) {
        hooks.stream.log("warn",
          `guardrails redacted output (${r.violations.map(v => v.detector).join(", ")})`);
      }
    }
    const warned = r.violations.filter(v => v.action_taken === "warned");
    if (warned.length && hooks?.stream?.log) {
      hooks.stream.log("warn",
        `guardrails flagged output: ${warned.map(v => v.detector).join(", ")}`);
    }
  }

  return {
    text:           finalText,
    usage,
    latencyMs,
    redactedInput,
    redactedOutput,
  };
}
