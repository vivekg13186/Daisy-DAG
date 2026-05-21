<!--
  Left palette in the canvas tab. Lists every registered action plugin grouped
  by prefix (the part before the first '.'). Drag a row onto the canvas to add
  the plugin at the drop position. The + button is a quick-add fallback.
-->
<template>
  <div class="palette column no-wrap full-height">
    <div class="q-pa-sm">
      <q-input v-model="filter" rounded dense outlined placeholder="Filter…" class="q-pa-xs">
        <template v-slot:prepend><q-icon name="search" size="16px" /></template>
      </q-input>
    </div>

    <q-list dense bordered separator class="col scroll" style="border: 0;">
      <q-expansion-item v-for="g in groups" :key="g.prefix" dense dense-toggle default-opened :label="g.prefix"
         header-class="palette-header">
        <q-item
          v-for="p in g.items" :key="p.name"
          dense draggable="true"
          class="palette-item"
          @dragstart="onDragStart(p, $event)"
          @dragend="dragging = null"
          v-ripple
        >
          <q-item-section avatar>
            <PluginIcon :action="p.name" size="18px" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ p.name }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-btn flat round dense size="xs" icon="add" @click.stop="$emit('add', p)">
              <q-tooltip>Add to canvas</q-tooltip>
            </q-btn>
          </q-item-section>
        </q-item>
      </q-expansion-item>
      <div v-if="groups.length === 0" class="q-pa-md text-caption text-grey text-center">
        No matching plugins.
      </div>
    </q-list>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import PluginIcon from "../PluginIcon.vue";

const props = defineProps({
  plugins: { type: Array, default: () => [] },
});
defineEmits(["add"]);

const dragging = ref(null);

function onDragStart(plugin, event) {
  dragging.value = plugin.name;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/daisy-plugin", plugin.name);
}

const filter = ref("");

const groups = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const filtered = props.plugins.filter(p =>
    !f || p.name.toLowerCase().includes(f) || (p.description || "").toLowerCase().includes(f)
  );
  const byPrefix = new Map();
  for (const p of filtered) {
    const prefix = p.name.includes(".") ? p.name.split(".")[0] : "core";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(p);
  }
  return [...byPrefix.entries()]
    .map(([prefix, items]) => ({ prefix, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
});
</script>

<style scoped>
.palette { background: var(--surface); }
.palette-item { cursor: grab; }
.palette-item:active { cursor: grabbing; }
.palette :deep(.palette-header) {
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
}
.palette :deep(.q-item) {
  font-size: 12px;
}
.palette :deep(.q-item:hover) {
  background: var(--primary-soft);
  color: var(--text);
}
</style>
