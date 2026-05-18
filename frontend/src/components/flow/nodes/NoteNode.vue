<!--
  NoteNode — a free-text sticky note that sits in the canvas background.
  =========================
  Differences from PluginNode:
    • No connection handles. Notes aren't part of the DAG; the engine
      never sees them.
    • Yellow sticky-note styling so they're visually distinct from
      "real" nodes.
    • Inline editable: double-click switches to a textarea, blur (or
      Esc) commits the change back to node.data via updateNode().
    • Drawn beneath plugin nodes via zIndex: -1 on the VueFlow node
      object (set by the canvas when notes are added).

  Formatting:
    Notes store their text as plain markdown. Display mode renders via
    `marked.parse()` so **bold**, *italic*, lists, links, and inline
    HTML (used for <u>underline</u>) come out formatted. Edit mode is
    just a plain textarea — the user types the markdown source
    directly. No toolbar, no Cmd/Ctrl shortcuts: those used to swallow
    plain letter keystrokes (typing 'i' triggered the italic wrap
    handler's preventDefault) and the workflow author audience is
    comfortable with raw markdown anyway.

  The text + position are persisted under meta.notes in the workflow
  DSL — see flowModel.js. Saved JSON round-trips notes alongside
  positions but keeps `nodes`/`edges` purely about execution.
-->

<template>
  <div
    class="note-node"
    :class="{ selected, editing }"
    @dblclick.stop="enterEdit"
  >
    <textarea
      v-if="editing"
      ref="textareaRef"
      v-model="localText"
      class="note-textarea nodrag"
      placeholder="Type a note… (markdown: **bold**, *italic*, <u>underline</u>, - bullets, [link](url))"
      @blur="commit"
      @keydown.escape.stop.prevent="cancel"
      @keydown.enter.stop="onEnter"
      @mousedown.stop
    />
    <div v-else class="note-display">
      <div
        v-if="data.text"
        class="note-rendered"
        v-html="rendered"
      ></div>
      <span v-else class="note-placeholder">Double-click to edit</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { marked } from "marked";

const props = defineProps({
  id:       { type: String, required: true },
  data:     { type: Object, required: true },
  selected: { type: Boolean, default: false },
});

const { updateNode } = useVueFlow();

const editing      = ref(false);
const localText    = ref("");
const textareaRef  = ref(null);

// `breaks: true` so a literal newline in the source becomes a <br>
// (otherwise the user has to double-space each line, which doesn't
// match the way people type into a sticky note).
marked.use({ breaks: true });

// Render markdown for display. Wrapped in computed so Vue caches across
// re-renders of the same data.text.
const rendered = computed(() => {
  try { return marked.parse(String(props.data?.text || "")); }
  catch { return escapeHtml(props.data?.text || ""); }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function enterEdit() {
  localText.value = String(props.data.text || "");
  editing.value   = true;
  nextTick(() => {
    textareaRef.value?.focus();
    // Place the caret at the end of existing text rather than
    // selecting-all (felt jumpy when users mostly want to append).
    const len = localText.value.length;
    try { textareaRef.value?.setSelectionRange(len, len); } catch { /* fine */ }
  });
}

function commit() {
  // Only emit a mutation if the text actually changed — keeps the
  // canvas extract+emit pipeline quiet when the user just opened
  // the editor and clicked away.
  if (localText.value !== (props.data.text || "")) {
    updateNode(props.id, { data: { ...props.data, text: localText.value } });
  }
  editing.value = false;
}

function cancel() {
  // Drop the buffered edit and revert.
  editing.value = false;
}

// Enter alone inserts a newline; Cmd/Ctrl-Enter commits. Matches the
// behaviour of most chat / Notion-style note editors.
function onEnter(e) {
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    textareaRef.value?.blur();   // triggers commit
  }
}
</script>

<style scoped>
.note-node {
  background:    #fef9c3;
  color:         #422006;
  border:        1px solid #ca8a04;
  border-radius: 4px;
  padding:       8px 10px;
  min-width:     200px;
  max-width:     340px;
  min-height:    52px;
  font-size:     12px;
  line-height:   1.45;
  box-shadow:    0 1px 3px rgba(0, 0, 0, 0.08);
  word-break:    break-word;
  cursor:        move;
  z-index: 0;
}
.note-node.selected {
  border-color: var(--primary, #2f6df3);
  box-shadow:   0 0 0 2px rgba(47, 109, 243, 0.22);
}

.note-display { cursor: text; }
.note-placeholder {
  color:      #92400e;
  font-style: italic;
}

/* Tight margins on rendered HTML so a single-line note doesn't get a
   chunky <p> top/bottom margin from any global stylesheet. */
.note-rendered :deep(p) { margin: 0 0 4px; }
.note-rendered :deep(p:last-child) { margin-bottom: 0; }
.note-rendered :deep(ul),
.note-rendered :deep(ol) {
  margin: 0 0 4px;
  padding-left: 20px;
}
.note-rendered :deep(li) { margin: 0; }
.note-rendered :deep(code) {
  background: rgba(0, 0, 0, 0.08);
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.note-rendered :deep(a) {
  color: #1e40af;
  text-decoration: underline;
}

.note-textarea {
  width:      100%;
  min-height: 52px;
  background: transparent;
  border:     none;
  outline:    none;
  font:       inherit;
  color:      inherit;
  resize:     vertical;
}

/* Dark theme: keep the sticky-note vibe but mute the yellow so it
   doesn't glare against the dark canvas. */
html[data-theme="dark"] .note-node {
  background:   #422006;
  color:        #fde68a;
  border-color: #b45309;
}
html[data-theme="dark"] .note-placeholder { color: #fcd34d; }
html[data-theme="dark"] .note-rendered :deep(a) { color: #93c5fd; }
html[data-theme="dark"] .note-rendered :deep(code) {
  background: rgba(255, 255, 255, 0.08);
}
</style>
