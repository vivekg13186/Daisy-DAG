<!--
  Node property panel for the FlowDesigner canvas.

  Now driven by the generic PropertyEditor (Quasar-based) instead of
  Tweakpane. This file is the bridge:
    • turns the plugin's JSON-Schema (`plugin.inputSchema`) into the
      PropertyEditor schema dialect (panels + ui_type-tagged children),
    • merges the node's flat data fields and inputs/outputs into a
      single draft object the editor binds against,
    • emits an `update` payload back to the parent (CanvasTab) every
      time the editor mutates the draft.

  Schema mapping rules (JSON Schema → PropertyEditor ui_type):
    - enum          → select
    - boolean       → toggle
    - integer/number → input (type="number") with min/max from schema
    - array<string> → list
    - array<object> → table (per-column ui_type derived recursively)
    - object        → textarea (JSON), parsed back on commit
    - default       → input (type="text")

  Common node-level fields (name, description, executeIf, retry,
  retryDelay, onError, batchOver) sit in their own "Node" panel above
  the plugin's inputs.
-->
<template>
  <PropertyEditor
    v-if="schema && draft"
    :schema="schema"
    :model-value="draft"
    @update:model-value="onEditorChange"
  />
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import PropertyEditor from "../../PropertyEditor.vue";
import { Configs } from "../../../api/client.js";

const props = defineProps({
  node: { type: Object, required: true },
});
const emit = defineEmits(["update"]);

// ── Config names (for config-ref dropdowns) ───────────────────────────
// Fetched once when the panel mounts; shared across all field renders.
const configNames = ref([]);
onMounted(async () => {
  try {
    const list = await Configs.list();
    configNames.value = (list || []).map(c => c.name).filter(Boolean).sort();
  } catch { /* silently fall back to free-text */ }
});

// ── Module-level constants ─────────────────────────────────────────────
// Declared up-front so the `immediate: true` watcher below can call
// `buildDraft()` during setup without tripping the TDZ on these `const`s.
// (Function declarations are hoisted; `const` initialisers are not.)
const NODE_FIELDS = [
  "name", "description", "executeIf", "retry", "retryDelay", "onError", "batchOver", "outputVar",
];

// ── Editor draft ───────────────────────────────────────────────────────
// One flat object that the editor binds against via dotted paths
// ("inputs.url", "outputs.body.id"). Rebuilt whenever a different node
// is selected; in-place edits flow through `onEditorChange`.
const draft = ref(null);

watch(
  () => props.node?.id,
  () => { draft.value = buildDraft(props.node?.data || {}); },
  { immediate: true },
);

// Editor → parent: fold the (possibly JSON-stringified) draft back into
// the canonical node-data shape and emit upward.
function onEditorChange(next) {
  draft.value = next;
  emit("update", foldDraftToData(props.node?.data || {}, next));
}

// ── Schema (JSON Schema → PropertyEditor schema) ──────────────────────
const schema = computed(() => {
  const inputSchema = props.node?.data?.plugin?.inputSchema || {};
  return buildSchema(inputSchema);
});

function buildSchema(inputSchema) {
  const required   = new Set(inputSchema.required || []);
  const properties = inputSchema.properties || {};

  // ---- Node panel: common to every node ----------------------------
  const nodePanel = {
    name: "Node",
    children: [
      { ui_type: "input",    type: "text",   label: "Name",        bind: "name",
        validation: { required: true } },
      { ui_type: "textarea",                  label: "Description", bind: "description" },
      { ui_type: "input",    type: "text",   label: "executeIf",   bind: "executeIf",
        hint: "Optional ${expr}; node is skipped when false." },
      { ui_type: "input",    type: "number", label: "Retry",       bind: "retry",
        validation: { min: 0 } },
      { ui_type: "input",    type: "text",   label: "RetryDelay",  bind: "retryDelay",
        hint: "ms or duration string (e.g. 500ms, 2s)" },
      { ui_type: "select",                    label: "On error",   bind: "onError",
        options: ["terminate", "continue"], validation: { required: true } },
      { ui_type: "input",    type: "text",   label: "BatchOver",   bind: "batchOver",
        hint: "Optional ${array}; runs the action once per item." },
    ],
  };

  // ---- Inputs panel: derived from the plugin's schema --------------
  // configRefs lists which input fields reference a stored config by name.
  const configRefNames = new Set(
    (props.node?.data?.plugin?.configRefs || []).map(r => r.name)
  );
  const inputsChildren = Object.entries(properties).map(([key, def]) =>
    fieldFromSchema(`inputs.${key}`, def.title || key, def, required.has(key), configRefNames.has(key))
  );
  const inputsPanel = {
    name: "Inputs",
    children: inputsChildren.length
      ? inputsChildren
      // Plugins without an input schema still get a freeform JSON editor.
      : [{ ui_type: "textarea", label: "Inputs (JSON)", bind: "__json.inputs", hint: "Raw JSON" }],
  };

  // ---- Outputs panel: maps plugin output fields → ctx variable names.
  // Each row pairs a plugin output (dot paths ok, e.g. body.id) with the
  // ctx-variable name it should become available under for downstream
  // nodes. The placeholders read "node output" / "var name" so the
  // intent is obvious without the user having to read the panel hint.
  const outputsPanel = {
    name: "Outputs",
    collapsed: true,
    children: [
      { ui_type: "keyvalues", label: "Map plugin outputs to ctx variables", bind: "outputs",
        keyPlaceholder:   "node output",
        valuePlaceholder: "var name",
        hint: "Each row binds a plugin output field (dot path ok) to a ctx " +
              "variable. Downstream nodes can then read it as ${<var name>}." },
    ],
  };

  // ---- Returns panel: read-only documentation built from outputSchema.
  // Lets the user see what the plugin produces (for ${nodes.<name>.output.X}
  // bindings) without leaving the editor.
  const returnsPanel = buildReturnsPanel(props.node?.data?.plugin);

  return [nodePanel, inputsPanel, outputsPanel, ...(returnsPanel ? [returnsPanel] : [])];
}

/**
 * Build a panel listing the plugin's outputSchema fields, plus a
 * highlight for whichever key the plugin tagged as `primaryOutput`
 * (that's what `outputVar` writes to ctx). Returns null when the
 * plugin doesn't ship an outputSchema.
 *
 * The panel is rendered through PropertyEditor's `info` ui_type, which
 * we add to the editor in the same patch — it's a non-editable list of
 * { label, value } rows.
 */
function buildReturnsPanel(plugin) {
  const schema = plugin?.outputSchema;
  const props  = schema?.properties;
  if (!props || typeof props !== "object" || !Object.keys(props).length) {
    return null;
  }
  const required = new Set(schema.required || []);
  const primary  = plugin?.primaryOutput;
  const rows = Object.entries(props).map(([key, def]) => {
    const tag = describeType(def);
    const tags = [tag];
    if (required.has(key)) tags.push("required");
    if (primary === key)   tags.push("primary");
    return {
      label: key,
      value: [tags.join(" · "), def.description || ""].filter(Boolean).join(" — "),
    };
  });
  return {
    name: "Returns",
    collapsed: true,
    children: [
      { ui_type: "info", label: "", bind: "__returns",
        hint: primary
          ? `Map any field below in the Outputs panel to wire it onto a ctx variable. ` +
            `\`${primary}\` is the plugin's primary value.`
          : "Map any field below in the Outputs panel to wire it onto a ctx variable.",
        rows,
      },
    ],
  };
}

function describeType(def) {
  if (!def) return "any";
  if (Array.isArray(def.enum)) return def.enum.join(" | ");
  if (def.type === "array") {
    const t = def.items?.type;
    return t ? `array<${t}>` : "array";
  }
  if (Array.isArray(def.type)) return def.type.join(" | ");
  return def.type || "any";
}

/** Convert one JSON Schema property into a PropertyEditor child. */
function fieldFromSchema(bind, label, def, isRequired, isConfigRef = false) {
  const validation = {};
  if (isRequired)               validation.required = true;
  if (def.minimum !== undefined) validation.min = def.minimum;
  if (def.maximum !== undefined) validation.max = def.maximum;
  if (def.format === "uri")     validation.url = true;

  // 0) config-ref → select from available config names
  if (isConfigRef) {
    return {
      ui_type: "select",
      label,
      bind,
      options: configNames.value,   // configNames is a ref; schema is computed → reruns when it changes
      validation,
      hint: def.description || "Select a configuration set created in Home → Configurations.",
    };
  }

  // 1) enum → select
  if (Array.isArray(def.enum)) {
    return { ui_type: "select", label, bind, options: def.enum, validation, hint: def.description };
  }
  // 2) boolean → toggle
  if (def.type === "boolean") {
    return { ui_type: "toggle", label, bind, hint: def.description };
  }
  // 3) integer / number → numeric input
  if (def.type === "integer" || def.type === "number") {
    return { ui_type: "input", type: "number", label, bind, validation, hint: def.description };
  }
  // 4) array of strings → list
  if (def.type === "array" && (!def.items || def.items.type === "string")) {
    return { ui_type: "list", label, bind, validation, hint: def.description };
  }
  // 5) array of objects → table
  if (def.type === "array" && def.items?.type === "object" && def.items.properties) {
    const itemReq = new Set(def.items.required || []);
    const columns = {};
    for (const [colKey, colDef] of Object.entries(def.items.properties)) {
      columns[colKey] = columnFromSchema(colKey, colDef, itemReq.has(colKey));
    }
    return { ui_type: "table", label, bind, columns, validation, hint: def.description };
  }
  // 6) string flagged as multi-line → plain textarea (binds straight to
  //    inputs.<key>, no JSON shadow). Triggered by a couple of schema
  //    conventions:
  //      · format: "textarea"   (preferred)
  //      · format: "multiline"
  //      · contentMediaType: "text/plain"
  //    Also fires for no-type fields tagged with `format: "textarea"` —
  //    used by plugins like `memory.set` where `value` accepts any
  //    shape (the engine resolves `${var}` to typed output before the
  //    plugin runs), but the editing surface benefits from multi-line
  //    + a placeholder hint.
  if (
    (def.type === "string" || def.type === undefined) &&
    (def.format === "textarea" ||
     def.format === "multiline" ||
     def.contentMediaType === "text/plain")
  ) {
    return {
      ui_type: "textarea",
      label, bind, validation,
      hint: def.description,
      placeholder: def.placeholder,
    };
  }
  // 7) anything else (object, mixed-type arrays, oneOf) → JSON textarea.
  //
  // The shadow key lives under a nested `__json` tree so PropertyEditor's
  // dotted-path resolver walks it cleanly (e.g. `__json.inputs.headers`
  // becomes draft.__json.inputs.headers, NOT a flat key with a dot in
  // its name — that mismatched the editor's split('.') walk).
  //
  // Plugins can pass a `placeholder` example string on the schema (custom
  // convention) — it'll appear inside the textarea while the field is empty.
  if (def.type === "object" || def.type === "array") {
    return { ui_type: "textarea", label: `${label} (JSON)`, bind: `__json.${bind}`,
             hint: def.description || "Edit as JSON",
             placeholder: def.placeholder };
  }
  // 8) default → string input. Includes URL formatting via validation
  //    and honours a custom `placeholder` so plugins can hint at the
  //    expected shape (e.g. `${someVar}`).
  return {
    ui_type: "input",
    type: def.format === "uri" ? "url" : "text",
    label, bind, validation,
    hint: def.description,
    placeholder: def.placeholder,
  };
}

/** Convert one item-schema property into a table column descriptor. */
function columnFromSchema(name, colDef, isRequired) {
  const validation = isRequired ? { required: true } : {};
  if (colDef.minimum !== undefined) validation.min = colDef.minimum;
  if (colDef.maximum !== undefined) validation.max = colDef.maximum;

  if (Array.isArray(colDef.enum)) {
    return { name, field: name, label: name, ui_type: "select", options: colDef.enum, validation };
  }
  if (colDef.type === "boolean") {
    return { name, field: name, label: name, ui_type: "toggle" };
  }
  if (colDef.type === "integer" || colDef.type === "number") {
    return { name, field: name, label: name, ui_type: "input", type: "number", validation };
  }
  return { name, field: name, label: name, ui_type: "input", type: "text", validation };
}

// ── Draft / data marshalling ──────────────────────────────────────────
//
// The editor binds against a draft object shaped like:
//   {
//     name, description, executeIf, retry, retryDelay, onError, batchOver,
//     inputs:  { ... },           // mirrors node.data.inputs
//     outputs: { ... },           // mirrors node.data.outputs
//     __json: {                   // shadow tree for JSON-text editors
//       inputs: {
//         headers: "{ ... }",     // raw JSON text the user is editing
//         body:    "{ ... }",
//       },
//     },
//   }
//
// Schema fields with bind="__json.inputs.headers" walk into the same
// nested path the seed code wrote, so PropertyEditor's split('.') resolver
// always finds the value. On every change we re-parse each shadow string
// and fold the result back into `inputs.<key>` before emitting up.
//
// `NODE_FIELDS` is declared near the top of the script so the
// immediate-mode watcher in setup can call `buildDraft()` without a TDZ
// error.

function buildDraft(data) {
  const out = {};
  for (const k of NODE_FIELDS) out[k] = data[k] ?? defaultFor(k);
  out.inputs  = { ...(data.inputs  || {}) };
  out.outputs = { ...(data.outputs || {}) };
  out.__json  = { inputs: {} };

  // For any input that's a complex type (object / mixed-array), seed a
  // shadow string under __json.inputs.<key> so the textarea has something
  // to render. Strings and primitive arrays are edited via their natural
  // ui_types, not the shadow path.
  const inputSchema = data.plugin?.inputSchema || {};
  for (const [k, def] of Object.entries(inputSchema.properties || {})) {
    if (!def) continue;
    const v = out.inputs[k];
    const isShadowed =
      def.type === "object"
      || (def.type === "array" && def.items && def.items.type !== "object" && def.items.type !== "string");
    if (isShadowed) {
      out.__json.inputs[k] = v == null ? "" : JSON.stringify(v, null, 2);
    }
  }
  // Plugins without an input schema render the whole `inputs` object as
  // a single JSON textarea bound at __json.inputs (a string at that path).
  if (!Object.keys(inputSchema.properties || {}).length) {
    out.__json.inputs = JSON.stringify(out.inputs, null, 2);
  }
  return out;
}

function foldDraftToData(prevData, next) {
  const merged = { ...prevData };
  for (const k of NODE_FIELDS) merged[k] = next[k];

  // Start from the editor's inputs and apply any JSON-shadow overrides.
  const inputs  = { ...(next.inputs  || {}) };
  const outputs = { ...(next.outputs || {}) };

  // The shadow tree may be:
  //   1. `__json.inputs` is a STRING — plugin had no input schema, the user
  //      edited the whole `inputs` object as one JSON blob.
  //   2. `__json.inputs` is an OBJECT — per-field shadows (e.g. headers, body)
  //      that should be parsed and folded back into `inputs.<key>`.
  // Invalid JSON in either case is silently preserved at the prior parsed
  // value so a half-typed edit doesn't blow away the structured data.
  const shadow = next.__json?.inputs;
  if (typeof shadow === "string") {
    try {
      const parsed = shadow ? JSON.parse(shadow) : {};
      Object.assign(inputs, parsed || {});
    } catch { /* keep prior */ }
  } else if (shadow && typeof shadow === "object") {
    for (const [k, raw] of Object.entries(shadow)) {
      if (typeof raw !== "string") continue;       // unexpected shape — skip
      if (raw === "") { delete inputs[k]; continue; }
      try { inputs[k] = JSON.parse(raw); }
      catch { /* keep prior */ }
    }
  }

  merged.inputs  = inputs;
  merged.outputs = outputs;
  return merged;
}

function defaultFor(key) {
  switch (key) {
    case "retry":       return 0;
    case "onError":     return "terminate";
    default:            return "";
  }
}
</script>
