<!--
  Canvas tab — VueFlow-based, drawer layout (modeled after the user's
  WorkflowEditor.vue reference).

  Why this design fixes the "screen reload every time / plugin click broken"
  issue from the previous iteration:
    • The canvas state (nodes/edges) lives in LOCAL refs that we manage via
      useVueFlow() helpers (addNodes, updateNode, fromObject/toObject).
    • The parent flow model is NOT reactively bound to the canvas. We sync
      one-way at well-defined moments: model → canvas on mount and whenever
      the parent replaces the model (import / AI generate); canvas → model
      via debounced extracts.
    • Adding a plugin from the palette is a single addNodes() call — no
      :nodes prop round-trip, so no recursive update loop.
-->
<template>
  <div class="canvas-tab row no-wrap full-height">

    <!-- ── Left: plugin palette ─────────────────────────────────────── -->
    <div v-if="leftOpen" class="left-pane column no-wrap" style="width: 260px;">
      <NodePalette :plugins="plugins" @add="onAddPlugin" />
    </div>

    <!-- ── Center: VueFlow canvas ───────────────────────────────────── -->
    <div class="flow-container col" @dragover="onDragOver" @drop="onDrop">
      <VueFlow v-model:nodes="nodes" v-model:edges="edges" class="fit" :default-viewport="{ x: 0, y: 0, zoom: 1 }"
        @node-click="onNodeClick" @pane-click="onPaneClick">
        <Background />
        <Controls>
          <ControlButton @click="leftOpen = !leftOpen">
            <q-icon name="build" style="color:black">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Toggle plugin palette
              </q-tooltip>
            </q-icon>
          </ControlButton>
          <ControlButton @click="rightOpen = !rightOpen">
            <q-icon name="settings" style="color:black">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Toggle property panel
              </q-tooltip>
            </q-icon>
          </ControlButton>
          <ControlButton @click="onAddNote">
            <q-icon name="sticky_note_2" style="color:black">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Add note
              </q-tooltip>
            </q-icon>
          </ControlButton>
          <!-- Auto-layout: runs the same dagre TB pass that powers the
               InstanceViewer's GraphView so the editor and run-view stay
               visually consistent. Notes are excluded from the rank
               graph and re-overlaid at their previous positions. -->
          <ControlButton @click="onFormat">
            <q-icon name="account_tree" style="color:black">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Format (auto-layout top-down)
              </q-tooltip>
            </q-icon>
          </ControlButton>
          <ControlButton @click="openJsonPanel">
            <q-icon name="code" style="color:black">
              <q-tooltip anchor="center right" self="center left" :offset="[10, 10]">
                Edit as JSON
              </q-tooltip>
            </q-icon>
          </ControlButton>
        </Controls>
        <MiniMap pannable zoomable />

        <template #node-plugin="props">
          <PluginNode v-bind="props" />
        </template>
        <template #node-note="props">
          <NoteNode v-bind="props" />
        </template>
      </VueFlow>
    </div>

    <!-- ── Node test dialog ──────────────────────────────────────────── -->
    <NodeTestDialog
      v-model="testDialogOpen"
      :node="selectedNode"
    />

    <!-- ── JSON editor panel ─────────────────────────────────────────── -->
    <q-dialog v-model="jsonPanelOpen" position="right" full-height>
      <q-card style="width:520px;max-width:92vw" class="column no-wrap full-height">
        <q-toolbar dense style="background:var(--surface-2);border-bottom:1px solid var(--border)">
          <q-icon name="code" class="q-mr-sm" />
          <q-toolbar-title class="text-subtitle2">Edit as JSON</q-toolbar-title>
          <q-btn flat round dense size="sm" icon="content_copy" @click="copyJson">
            <q-tooltip>Copy</q-tooltip>
          </q-btn>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>

        <div class="col" style="min-height:0;position:relative">
          <textarea
            v-model="jsonText"
            class="json-edit-area"
            spellcheck="false"
            @input="jsonError = ''"
          />
        </div>

        <div v-if="jsonError" class="json-edit-error">
          <q-icon name="error_outline" class="q-mr-xs" />{{ jsonError }}
        </div>

        <q-separator />
        <q-card-actions align="right" class="q-pa-sm">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn unelevated color="primary" no-caps label="Apply" @click="applyJson" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- ── Right: properties + per-node toolbar ─────────────────────── -->
    <div v-if="rightOpen" class="right-pane column no-wrap" style="width: 450px;">
      <q-toolbar dense class="panel-toolbar" style="padding-right:5px!important">
        <span class="text-caption" style="color: var(--text-muted);">
          {{ selectedNode ? "Node" : "Flow" }} properties
        </span>
        <q-space />
        <div>
          <q-btn v-if="selectedNode && selectedNode.type !== 'note'" dense flat round icon="play_arrow" color="positive" size="sm"
            @click="testDialogOpen = true">
            <q-tooltip>Test this node</q-tooltip>
          </q-btn>
          <q-btn v-if="selectedNode" dense flat round icon="delete" color="negative" size="sm"
            @click="onDeleteSelected">
            <q-tooltip>Delete selected node</q-tooltip>
          </q-btn>
          <q-btn dense flat round icon="close" size="sm" @click="rightOpen = false">
            <q-tooltip>Hide panel</q-tooltip>
          </q-btn>
        </div>

      </q-toolbar>

      <q-scroll-area class="col">
        <template v-if="selectedNode?.type === 'note'">
          <div class="q-pa-md text-caption text-grey">
            <q-icon name="sticky_note_2" size="16px" class="q-mr-xs" />
            Note selected. Double-click the note on the canvas to edit
            its text. Use the delete button above to remove it.
          </div>
        </template>
        <component
          v-else-if="selectedNode"
          :is="PluginPropertyPanel"
          :node="selectedNode"
          @update="onUpdateNodeData"
        />
        <div v-else class="q-pa-md text-caption text-grey">
          Click a node on the canvas to edit its properties, or pick a plugin from
          the left palette to add one.
        </div>
      </q-scroll-area>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick, provide } from "vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";

import { VueFlow, useVueFlow, Position } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls, ControlButton } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";

import NodePalette from "./NodePalette.vue";
import PluginNode from "./nodes/PluginNode.vue";
import PluginPropertyPanel from "./nodes/PluginPropertyPanel.vue";
import NoteNode from "./nodes/NoteNode.vue";
import NodeTestDialog from "./NodeTestDialog.vue";
import { buildNodeRegistry } from "./NodeRegistry.js";
import { useLayout } from "../useLayout.js";
import { serializeModelToDsl, parseDslToModel } from "./flowModel.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  plugins: { type: Array, default: () => [] },
  validationErrors: { type: Array, default: () => [] }, // [{ node, field, message }]
});
const emit = defineEmits(["update:modelValue"]);

// Provide validation errors to child nodes via inject (avoids prop-drilling
// through VueFlow's node component boundary).
provide("canvasValidationErrors", computed(() => {
  const nodeIds = new Set((props.validationErrors || []).map(e => e.node));
  return nodeIds;
}));

// ── Drawer toggles ──────────────────────────────────────────────────────────
const leftOpen = ref(true);
const rightOpen = ref(false);
const testDialogOpen = ref(false);

// ── JSON editor panel ───────────────────────────────────────────────────────
const jsonPanelOpen = ref(false);
const jsonText      = ref("");
const jsonError     = ref("");

function openJsonPanel() {
  try { jsonText.value = serializeModelToDsl(props.modelValue); }
  catch (e) { jsonText.value = ""; }
  jsonError.value  = "";
  jsonPanelOpen.value = true;
}

function applyJson() {
  try {
    const newModel = parseDslToModel(jsonText.value);
    emit("update:modelValue", newModel);
    jsonPanelOpen.value = false;
    jsonError.value = "";
  } catch (e) {
    jsonError.value = e.message || "Parse error";
  }
}

function copyJson() {
  navigator.clipboard.writeText(jsonText.value).catch(() => {});
}

// ── Drag & drop from palette ────────────────────────────────────────────────
function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
}

async function onDrop(event) {
  event.preventDefault();
  const pluginName = event.dataTransfer.getData("application/daisy-plugin");
  if (!pluginName) return;
  const plugin = (props.plugins || []).find(p => p.name === pluginName);
  if (!plugin) return;
  // Convert the screen drop position to canvas coordinates (accounts for pan + zoom).
  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  await onAddPlugin(plugin, position);
}

// ── VueFlow store ───────────────────────────────────────────────────────────
const nodes = ref([]);
const edges = ref([]);

// useVueFlow gives us imperative helpers that work against the canvas state
// without going through the :nodes/:edges props (which would loop us back
// into the parent's model).
const { addNodes, addEdges, updateNode, onConnect, screenToFlowCoordinate } = useVueFlow();

// VueFlow handles keyboard delete (Backspace / Delete) internally and
// mutates our v-model'd `nodes` / `edges` refs directly. The
// `useVueFlow().onNodesChange` callback is unreliable in v-model mode,
// so instead we watch array *lengths* — any time they change, we know
// something was added or removed (button click, keyboard, drag-delete,
// drag-connect, programmatic) and we flush the canvas state to the
// parent model. We react to BOTH grow and shrink because VueFlow's
// internal store→v-model sync is deferred one tick (watchPausable in
// useWatchProps), so a synchronous extractAndEmit() right after
// addEdges()/addNodes() would otherwise read stale arrays — that was
// the cause of "edge appears on canvas but doesn't make it into the
// JSON or save" reports.
let lastNodeCount = nodes.value.length;
let lastEdgeCount = edges.value.length;
watch(() => nodes.value.length, (next) => {
  if (next < lastNodeCount) {
    // A node disappeared — clear selection in case it was the gone one.
    if (selectedNodeId.value && !nodes.value.some(n => n.id === selectedNodeId.value)) {
      selectedNodeId.value = null;
    }
  }
  lastNodeCount = next;
  extractAndEmit();
});
watch(() => edges.value.length, (next) => {
  lastEdgeCount = next;
  extractAndEmit();
});

// Auto-add edges when the user drags a connection between two handles.
// VueFlow's `addEdges` only updates its internal store synchronously;
// the v-model'd `edges.value` is mirrored across one nextTick later, so
// awaiting that flush before extracting prevents the new edge from
// dropping out of the emitted model.
onConnect(async (connection) => {
  // Avoid duplicates.
  const dup = edges.value.find(e => e.source === connection.source && e.target === connection.target);
  if (dup) return;
  addEdges([{
    id: `e-${connection.source}-${connection.target}-${Date.now()}`,
    source: connection.source,
    target: connection.target,
  }]);
  // Wait for VueFlow's store→v-model sync, then push the change up.
  // (The length watcher above also catches this, but emitting here
  // explicitly closes a small race with a click-Save-immediately-after.)
  await nextTick();
  extractAndEmit();
});

// ── Node registry ───────────────────────────────────────────────────────────
const registry = computed(() => buildNodeRegistry(props.plugins));

// ── Selection ───────────────────────────────────────────────────────────────
const selectedNodeId = ref(null);
const selectedNode = computed(() =>
  selectedNodeId.value ? nodes.value.find(n => n.id === selectedNodeId.value) || null : null
);

function onNodeClick({ node }) {
  selectedNodeId.value = node.id;
  rightOpen.value = true;
}
function onPaneClick() {
  selectedNodeId.value = null;
}

// ── Notes (sticky-note overlay) ─────────────────────────────────────────────
// Notes are first-class VueFlow nodes of type "note" but they round-trip
// through `meta.notes` in the DSL (never through `nodes`/`edges`), so
// the engine doesn't see them and the workflow's execution stays
// unaffected. zIndex: -1 keeps them visually beneath plugin nodes
// without intercepting clicks meant for nodes on top.
async function onAddNote() {
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? `note-${crypto.randomUUID()}`
    : `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Drop the note near the centre of the current viewport. Without a
  // viewport-aware placement the note can land off-screen on a
  // panned/zoomed canvas. The 60 + slight per-note offset keeps
  // successive notes from stacking on top of each other.
  const offset = nodes.value.filter(n => n.type === "note").length * 18;
  addNodes([{
    id,
    type:        "note",
    position:    { x: 80 + offset, y: 60 + offset },
    data:        { text: "" },
    zIndex:      -1,
    selectable:  true,
    draggable:   true,
  }]);
  selectedNodeId.value = id;
  await nextTick();
  extractAndEmit();
}

// ── Palette → addNodes ──────────────────────────────────────────────────────
//
// `addNodes` (like `addEdges`) only mutates VueFlow's internal store
// synchronously; the v-model'd `nodes` ref catches up one nextTick later.
// Awaiting that tick before extractAndEmit ensures the new node is
// included in the emitted model rather than dropping out as stale state.
async function onAddPlugin(plugin, position = null) {
  const entry = registry.value[plugin.name];
  if (!entry) return;
  const node = entry.defaultNode();
  if (position) node.position = position;
  // Pick a unique on-screen name based on the action.
  const taken = new Set(nodes.value.map(n => n.data?.name).filter(Boolean));
  if (taken.has(node.data.name)) {
    let i = 2;
    while (taken.has(`${node.data.name}-${i}`)) i++;
    node.data.name = `${node.data.name}-${i}`;
  }
  addNodes([node]);
  selectedNodeId.value = node.id;
  rightOpen.value = true;
  await nextTick();
  extractAndEmit();
}

// ── Auto-layout ─────────────────────────────────────────────────────────────
// Runs the same dagre top-down (TB) pass GraphView uses on the
// InstanceViewer, so the editor and the run view stay visually consistent.
//
// Note nodes are deliberately excluded from the rank graph: dagre would
// treat them as floating roots and push them somewhere awkward. We
// re-attach them at their existing positions so user annotations don't
// jump around when the rest of the canvas snaps.
const { layout } = useLayout();
function onFormat() {
  const pluginNodes = nodes.value.filter(n => n.type !== "note");
  const noteNodes   = nodes.value.filter(n => n.type === "note");
  if (!pluginNodes.length) return;

  const laidOut = layout(pluginNodes, edges.value, "TB");
  // Preserve user-set selection / dimensions on each touched node by
  // merging the new position into the original object rather than
  // taking dagre's shape wholesale.
  const byId = new Map(laidOut.map(n => [n.id, n]));
  nodes.value = [
    ...pluginNodes.map(n => byId.get(n.id) ? { ...n, position: byId.get(n.id).position } : n),
    ...noteNodes,
  ];
  // Flush positions into the model so a save right after Format
  // captures them — extractAndEmit reads node.position back into
  // meta.positions.
  scheduleExtract();
}

// ── Property panel updates → updateNode ─────────────────────────────────────
// Property edits fire per-keystroke from the right pane; debounce them.
function onUpdateNodeData(newData) {
  if (!selectedNode.value) return;
  updateNode(selectedNode.value.id, { data: { ...selectedNode.value.data, ...newData } });
  scheduleExtract();
}

function onDeleteSelected() {
  if (!selectedNodeId.value) return;
  const id = selectedNodeId.value;
  nodes.value = nodes.value.filter(n => n.id !== id);
  edges.value = edges.value.filter(e => e.source !== id && e.target !== id);
  selectedNodeId.value = null;
  // Structural change — flush immediately. The previous debounced
  // extract meant a fast user click on Save (within 200ms) saved the
  // stale model with the just-deleted node still present.
  extractAndEmit();
}

// ── Sync model → canvas ────────────────────────────────────────────────────
//
// We do this once on mount and again whenever the parent replaces the model
// (import / AI generate). The watcher uses identity equality so editing a
// field inside the model (which doesn't change the model reference) doesn't
// trigger a re-import — only outright replacement does.
let suspendExtract = false;
function applyModel(model) {
  suspendExtract = true;
  // Convert flow model to VueFlow nodes/edges.
  const nameToId = new Map();
  const newNodes = (model.nodes || []).map((n, i) => {
    const plugin = (props.plugins || []).find(p => p.name === n.action) || { name: n.action, inputSchema: {}, outputSchema: {} };
    const pos = model.meta?.positions?.[n.name] || { x: 100 + (i % 4) * 220, y: 60 + Math.floor(i / 4) * 120 };
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `n-${Date.now()}-${i}`;
    nameToId.set(n.name, id);
    return {
      id,
      type: "plugin",
      // Top-down orientation: each node's source handle sits on its
      // bottom edge, target on its top. Matches the InstanceViewer's
      // dagre "TB" layout so saved positions read naturally there too.
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      position: { x: pos.x, y: pos.y },
      data: {
        action: n.action,
        name: n.name,
        description: n.description || "",
        inputs: { ...(n.inputs || {}) },
        outputs: { ...(n.outputs || {}) },
        executeIf: n.executeIf || "",
        retry: n.retry || 0,
        retryDelay: n.retryDelay || 0,
        onError: n.onError || "terminate",
        batchOver: n.batchOver || "",
        outputVar: n.outputVar || "",
        plugin,
      },
    };
  });
  const newEdges = (model.edges || []).map((e, i) => ({
    id: `e-${i}-${e.from}-${e.to}`,
    source: nameToId.get(e.from) || e.from,
    target: nameToId.get(e.to) || e.to,
  }));

  // Notes ride alongside plugin nodes in VueFlow's `nodes` array but
  // come from `meta.notes` rather than `model.nodes` (they're not part
  // of the DAG). zIndex: -1 keeps them visually behind plugin nodes.
  const noteNodes = (model.meta?.notes || []).map(n => ({
    id:         String(n.id),
    type:       "note",
    position:   { x: Number(n.x) || 0, y: Number(n.y) || 0 },
    data:       { text: String(n.text || "") },
    zIndex:     -1,
    selectable: true,
    draggable:  true,
  }));
  newNodes.push(...noteNodes);

  nodes.value = newNodes;
  edges.value = newEdges;
  selectedNodeId.value = null;
  // Reset the shrink-detection baselines so applyModel (which can lower
  // the counts when re-loading a smaller flow) doesn't trip a phantom
  // extract once `suspendExtract` clears.
  lastNodeCount = newNodes.length;
  lastEdgeCount = newEdges.length;
  // Release after the canvas processes the new arrays.
  nextTick().then(() => { suspendExtract = false; });
}

// ── Sync canvas → model (debounced) ────────────────────────────────────────
let extractTimer = null;
function scheduleExtract() {
  if (suspendExtract) return;
  if (extractTimer) clearTimeout(extractTimer);
  extractTimer = setTimeout(() => {
    extractTimer = null;
    extractAndEmit();
  }, 200);
}

function extractAndEmit() {
  if (suspendExtract) return;
  // Cancel any pending debounce — we're emitting now.
  if (extractTimer) { clearTimeout(extractTimer); extractTimer = null; }

  // Build the canvas-side patch of model. Walk the VueFlow nodes once
  // and bucket by type: plugin → model.nodes (with positions), note →
  // meta.notes (text + x/y). Anything else gets dropped.
  const idToName = new Map();
  const positions = {};
  const newNodes  = [];
  const newNotes  = [];
  for (const n of nodes.value) {
    if (n.type === "note") {
      newNotes.push({
        id:   String(n.id),
        text: String(n.data?.text || ""),
        x:    Math.round(n.position?.x ?? 0),
        y:    Math.round(n.position?.y ?? 0),
      });
      continue;
    }
    const dagName = (n.data?.name || `node-${n.id}`).trim();
    idToName.set(n.id, dagName);
    positions[dagName] = {
      x: Math.round(n.position?.x ?? 0),
      y: Math.round(n.position?.y ?? 0),
    };
    newNodes.push({
      name: dagName,
      action: n.data?.action || "",
      description: n.data?.description || "",
      inputs: n.data?.inputs || {},
      outputs: n.data?.outputs || {},
      executeIf: n.data?.executeIf || "",
      retry: n.data?.retry || 0,
      retryDelay: n.data?.retryDelay || 0,
      onError: n.data?.onError || "terminate",
      batchOver: n.data?.batchOver || "",
      outputVar: n.data?.outputVar || "",
    });
  }
  const newEdges = edges.value
    .map(e => ({ from: idToName.get(e.source), to: idToName.get(e.target) }))
    .filter(e => e.from && e.to);

  emit("update:modelValue", {
    ...props.modelValue,
    nodes: newNodes,
    edges: newEdges,
    meta: {
      ...(props.modelValue.meta || {}),
      positions,
      notes: newNotes,
    },
  });
}

// Track outright model replacement (import / AI generate / route change).
// We compare by reference — fields inside the same object don't trigger this.
let lastSeenModelRef = null;
watch(() => props.modelValue, (m) => {
  if (m === lastSeenModelRef) return;
  lastSeenModelRef = m;
  // Compare plugin-node counts only — notes live on the canvas via
  // VueFlow's `nodes` array but come from `meta.notes`, so counting
  // them here would over-trigger applyModel on every note add/remove.
  const canvasPluginCount = nodes.value.filter(n => n.type !== "note").length;
  const sameNodeCount = (m.nodes?.length || 0) === canvasPluginCount;
  if (sameNodeCount && canvasPluginCount > 0) {
    // assume our local state is already authoritative — skip re-importing
    return;
  }
  applyModel(m);
}, { immediate: true });

onBeforeUnmount(() => {
  if (extractTimer) clearTimeout(extractTimer);
});
</script>

<style scoped>
.canvas-tab {
  width: 100%;
  height: 100%;
  background: var(--bg);
}

.flow-container {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  position: relative;
}

.left-pane {
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.right-pane {
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.panel-toolbar {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.json-edit-area {
  width: 100%;
  height: 100%;
  padding: 12px 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  border: none;
  outline: none;
  resize: none;
  background: var(--surface);
  color: var(--text);
}
.json-edit-error {
  padding: 6px 12px;
  background: rgba(220,38,38,0.08);
  color: #b91c1c;
  border-top: 1px solid rgba(220,38,38,0.2);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
