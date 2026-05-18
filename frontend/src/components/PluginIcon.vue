<!--
  PluginIcon — renders a brand-coloured SVG (or coloured Material icon)
  for a given plugin action name. Used wherever the UI needs to
  represent a plugin: the canvas node, the left palette, the Plugins
  admin list.

  Props
    action  string  the plugin name (e.g. "jira", "csv.read", "agent")
    size    string  CSS size (default "16px"). Same value used for both
                    the inline SVG and the q-icon fallback so visual
                    alignment is identical regardless of which icon
                    flavour gets rendered.

  Resolution lives in `pluginIcons.js` — see that file for how the name
  is mapped to a brand SVG, a Material icon, or the generic fallback.
-->

<template>
  <span class="plugin-icon" :style="{ width: size, height: size }">
    <svg
      v-if="resolved.type === 'brand' && resolved.path"
      :width="size"
      :height="size"
      viewBox="0 0 24 24"
      :aria-label="action"
      role="img"
    >
      <path :d="resolved.path" :fill="resolved.color || 'currentColor'" />
    </svg>
    <q-icon
      v-else
      :name="resolved.icon || 'extension'"
      :size="size"
      :style="resolved.color ? { color: resolved.color } : undefined"
      :aria-label="action"
    />
  </span>
</template>

<script setup>
import { computed } from "vue";
import { resolvePluginIcon } from "./pluginIcons.js";

const props = defineProps({
  action: { type: String, default: "" },
  size:   { type: String, default: "16px" },
});

const resolved = computed(() => resolvePluginIcon(props.action));
</script>

<style scoped>
.plugin-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  line-height: 1;
}
</style>
