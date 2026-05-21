<!--
  NodeTestDialog — run a single canvas node in isolation.

  Props:
    modelValue  boolean  — open/close
    node        object   — the VueFlow node ({ data: { action, name, inputs, … } })

  The dialog sends { action, inputs, context } to POST /plugins/test.
  `context` is user-supplied test data available to FEEL as data.*.
  The backend resolves ${…} expressions, invokes the plugin directly
  (no queue, no DB write), and returns { ok, output, resolvedInputs }.
-->
<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)"
            max-width="680px" @hide="reset">
    <q-card style="min-width:600px;max-width:680px">

      <!-- Header -->
      <q-card-section class="row items-center q-pb-none">
        <div class="col">
          <div class="text-subtitle1">
            Test node
            <code class="node-name q-ml-xs">{{ node?.data?.name }}</code>
          </div>
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ node?.data?.action }}
            · runs directly, no queue, no DB write
          </div>
        </div>
        <q-btn flat round dense icon="close" @click="$emit('update:modelValue', false)" />
      </q-card-section>

      <q-separator class="q-mt-sm" />

      <q-card-section class="q-gutter-y-md" style="max-height:72vh;overflow-y:auto">

        <!-- Configured inputs (read-only reference) -->
        <div v-if="configuredInputsText">
          <div class="section-label">Configured inputs</div>
          <div class="text-caption text-grey-6 q-mb-xs">
            FEEL expressions like <code>${data.x}</code> will be resolved against your test data below.
          </div>
          <pre class="code-block">{{ configuredInputsText }}</pre>
        </div>

        <!-- Test data (context.data) -->
        <div>
          <div class="section-label">Test data <span class="text-grey-6">(available as <code>data.*</code>)</span></div>
          <div class="text-caption text-grey-6 q-mb-xs">
            Provide values for any <code>${data.…}</code> placeholders in the inputs above.
          </div>
          <q-input
            v-model="contextText"
            type="textarea"
            outlined dense
            :rows="6"
            :error="!!contextError"
            :error-message="contextError"
            placeholder="{}"
            @update:model-value="contextError = ''"
            class="code-input"
          />
        </div>

        <!-- Result -->
        <div v-if="result !== null">
          <div class="section-label">
            <q-icon
              :name="result.ok ? 'check_circle' : 'error'"
              :color="result.ok ? 'positive' : 'negative'"
              size="16px"
              class="q-mr-xs"
            />
            {{ result.ok ? 'Output' : 'Error' }}
          </div>

          <!-- Resolved inputs (collapsed by default) -->
          <q-expansion-item
            v-if="result.ok && result.resolvedInputs"
            dense
            label="Resolved inputs"
            caption="What the plugin actually received after FEEL evaluation"
            class="q-mb-sm"
          >
            <pre class="code-block">{{ JSON.stringify(result.resolvedInputs, null, 2) }}</pre>
          </q-expansion-item>

          <pre :class="['code-block', result.ok ? '' : 'code-block--error']">{{ resultText }}</pre>
        </div>

      </q-card-section>

      <q-separator />

      <q-card-actions align="right" class="q-pa-sm">
        <q-btn flat label="Close" @click="$emit('update:modelValue', false)" />
        <q-btn
          unelevated color="primary"
          icon="play_arrow"
          label="Run"
          :loading="running"
          no-caps
          @click="onRun"
        />
      </q-card-actions>

    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { Plugins } from "../../api/client.js";

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  node:       { type: Object, default: null },
});
const emit = defineEmits(["update:modelValue"]);

const contextText  = ref("{}");
const contextError = ref("");
const running      = ref(false);
const result       = ref(null);

const configuredInputsText = computed(() => {
  const inputs = props.node?.data?.inputs;
  if (!inputs || !Object.keys(inputs).length) return "";
  return JSON.stringify(inputs, null, 2);
});

const resultText = computed(() => {
  if (!result.value) return "";
  if (result.value.ok) return JSON.stringify(result.value.output, null, 2);
  return result.value.error || "unknown error";
});

// Reset result whenever the dialog opens or the node changes.
watch(() => [props.modelValue, props.node], () => {
  if (props.modelValue) result.value = null;
});

function reset() {
  result.value   = null;
  contextError.value = "";
}

async function onRun() {
  // Parse test context.
  let context = {};
  const raw = (contextText.value || "").trim() || "{}";
  try { context = JSON.parse(raw); }
  catch (e) {
    contextError.value = `Invalid JSON: ${e.message}`;
    return;
  }
  if (typeof context !== "object" || Array.isArray(context)) {
    contextError.value = "Must be a JSON object, e.g. { \"key\": \"value\" }";
    return;
  }

  running.value = true;
  result.value  = null;
  try {
    const r = await Plugins.test({
      action:  props.node.data.action,
      inputs:  props.node.data.inputs || {},
      context,
    });
    result.value = { ok: true, output: r.output, resolvedInputs: r.resolvedInputs };
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || "unknown error";
    result.value = { ok: false, error: msg };
  } finally {
    running.value = false;
  }
}
</script>

<style scoped>
.node-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  background: rgba(0,0,0,0.06);
  padding: 1px 6px;
  border-radius: 3px;
}
.section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 4px;
}
.code-block {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.04);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 260px;
  overflow-y: auto;
}
.code-block--error {
  background: rgba(220, 38, 38, 0.06);
  border-color: rgba(220, 38, 38, 0.2);
  color: #b91c1c;
}
.code-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
