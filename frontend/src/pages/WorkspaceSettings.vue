<!--
  Workspace settings — admin can rename the active workspace and view
  member roster. The roster is read-only here; user-level changes
  (role, status, password) live on /users.
-->

<template>
  <div class="page q-pa-md">
    <div class="page-header q-mb-md">
      <div class="text-h6">Workspace</div>
      <div class="text-caption text-grey-7">Settings and member roster.</div>
    </div>

    <q-card flat bordered class="q-pa-md q-mb-md">
      <div class="row items-end q-gutter-md">
        <q-input
          v-model="form.name"
          label="Workspace name"
          outlined
          dense
          class="col"
        />
        <q-btn
          color="primary"
          unelevated
          label="Save"
          :disable="!isAdmin || !form.name?.trim() || form.name === ws?.name"
          :loading="saving"
          @click="onSave"
        />
      </div>
      <div v-if="ws" class="text-caption text-grey-7 q-mt-sm">
        slug: <code>{{ ws.slug }}</code> · created
        {{ ws.created_at ? new Date(ws.created_at).toLocaleDateString() : "—" }}
      </div>
    </q-card>

    <!-- AI Provider status -->
    <q-card flat bordered class="q-pa-md q-mb-md">
      <div class="row items-center q-mb-sm">
        <q-icon name="auto_awesome" class="q-mr-sm" color="primary" />
        <div class="text-subtitle2">AI Provider</div>
        <q-space />
        <q-chip v-if="aiStatus.configured" dense color="positive" text-color="white" icon="check">
          configured · {{ aiStatus.provider }} · {{ aiStatus.model }}
        </q-chip>
        <q-chip v-else dense color="grey-5" text-color="white" icon="warning">not configured</q-chip>
      </div>

      <!-- Key entry form (admin only) -->
      <template v-if="isAdmin">
        <div class="text-body2 text-grey-8 q-mb-md">
          Enter your API key below — it is stored encrypted and takes effect immediately
          (no backend restart needed).
        </div>

        <div class="row q-col-gutter-sm q-mb-sm">
          <div class="col-12 col-sm-3">
            <q-select
              v-model="aiForm.provider"
              :options="providerOptions"
              label="Provider"
              outlined dense emit-value map-options
            />
          </div>
          <div class="col-12 col-sm-9">
            <q-input
              v-model="aiForm.apiKey"
              label="API key"
              outlined dense
              :type="showKey ? 'text' : 'password'"
              :placeholder="aiStatus.configured ? '••••••••  (leave blank to keep current)' : 'sk-ant-api03-… or sk-…'"
            >
              <template #append>
                <q-btn flat round dense
                  :icon="showKey ? 'visibility_off' : 'visibility'"
                  @click="showKey = !showKey"
                />
              </template>
            </q-input>
          </div>
        </div>

        <q-expansion-item dense label="Advanced overrides (model, base URL)" class="q-mb-sm">
          <div class="row q-col-gutter-sm q-mt-xs">
            <div class="col-12 col-sm-6">
              <q-input
                v-model="aiForm.model"
                label="Model override"
                outlined dense
                placeholder="e.g. claude-haiku-4-5-20251001"
                hint="Leave blank to use provider default"
              />
            </div>
            <div class="col-12 col-sm-6">
              <q-input
                v-model="aiForm.baseUrl"
                label="Base URL override"
                outlined dense
                placeholder="e.g. https://api.anthropic.com/v1"
                hint="For Azure OpenAI / Ollama / Groq"
              />
            </div>
          </div>
        </q-expansion-item>

        <div class="row q-gutter-sm items-center">
          <q-btn
            unelevated color="primary" no-caps
            label="Save AI settings"
            :loading="aiSaving"
            @click="onSaveAi"
          />
          <q-btn
            v-if="aiStatus.configured && aiStatus.source === 'db'"
            flat color="negative" no-caps
            label="Remove saved key"
            :loading="aiClearing"
            @click="onClearAi"
          />
          <div v-if="aiStatus.configured" class="text-caption text-grey-6">
            Source: <strong>{{ aiStatus.source }}</strong>
            <span v-if="aiStatus.keyPreview"> · {{ aiStatus.keyPreview }}</span>
          </div>
        </div>

        <q-separator class="q-my-md" />
        <div class="text-caption text-grey-7 q-mb-xs">
          Alternatively, set env vars before starting the backend (env vars are overridden by a saved key above):
        </div>
      </template>
      <template v-else>
        <div class="text-body2 text-grey-8 q-mb-sm">
          AI features require an API key configured by an admin.
        </div>
      </template>

      <q-markup-table flat bordered dense class="ai-env-table">
        <thead>
          <tr><th class="text-left">Variable</th><th class="text-left">Value / Example</th><th class="text-left">Notes</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>ANTHROPIC_API_KEY</code></td>
            <td><code>sk-ant-api03-…</code></td>
            <td>Enables Anthropic (Claude). Takes priority when set.</td>
          </tr>
          <tr>
            <td><code>OPENAI_API_KEY</code></td>
            <td><code>sk-…</code></td>
            <td>Enables OpenAI or any compatible endpoint.</td>
          </tr>
          <tr>
            <td><code>AI_MODEL</code></td>
            <td><code>claude-haiku-4-5-20251001</code></td>
            <td>Override the default model. Optional.</td>
          </tr>
          <tr>
            <td><code>AI_BASE_URL</code></td>
            <td><code>https://api.anthropic.com/v1</code></td>
            <td>Override for Azure OpenAI / Ollama / Groq. Optional.</td>
          </tr>
        </tbody>
      </q-markup-table>
    </q-card>

    <q-card flat bordered>
      <q-card-section>
        <div class="text-subtitle2">Members</div>
      </q-card-section>
      <q-table
        :rows="members"
        :columns="memberColumns"
        row-key="id"
        flat
        :pagination="{ rowsPerPage: 0 }"
        hide-bottom
        :loading="loading"
      >
        <template #body-cell-status="props">
          <q-td :props="props">
            <q-badge
              :color="props.row.status === 'active' ? 'positive' : 'grey-6'"
              :label="props.row.status"
            />
          </q-td>
        </template>
        <template #body-cell-primary="props">
          <q-td :props="props">
            <q-icon v-if="props.row.primary" name="star" color="amber-7" size="18px">
              <q-tooltip>Primary workspace for this user</q-tooltip>
            </q-icon>
          </q-td>
        </template>
      </q-table>
    </q-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { Workspaces, AI } from "../api/client.js";
import { auth } from "../stores/auth.js";

const $q = useQuasar();

const ws       = ref(null);
const members  = ref([]);
const loading  = ref(false);
const saving   = ref(false);
const form     = ref({ name: "" });
const aiStatus = ref({ configured: false, provider: "", model: "", source: "env", keyPreview: null });

// AI key form
const aiSaving  = ref(false);
const aiClearing = ref(false);
const showKey   = ref(false);
const aiForm    = ref({ provider: "anthropic", apiKey: "", model: "", baseUrl: "" });

const providerOptions = [
  { label: "Anthropic (Claude)", value: "anthropic" },
  { label: "OpenAI / compatible", value: "openai" },
];

const isAdmin = computed(() => auth.user?.role === "admin");

const memberColumns = [
  { name: "primary",     label: "",        field: "primary",      align: "center" },
  { name: "email",       label: "Email",   field: "email",        align: "left", sortable: true },
  { name: "display_name",label: "Name",    field: "display_name", align: "left" },
  { name: "role",        label: "Role",    field: "role",         align: "left" },
  { name: "status",      label: "Status",  field: "status",       align: "left" },
  { name: "last_login_at", label: "Last login",
    field: r => r.last_login_at ? new Date(r.last_login_at).toLocaleString() : "—",
    align: "left" },
];

async function load() {
  if (!auth.user?.workspaceId) return;
  loading.value = true;
  try {
    const promises = [
      Workspaces.get(auth.user.workspaceId),
      AI.status().catch(() => ({ configured: false, provider: "anthropic", model: "", source: "env" })),
    ];
    if (isAdmin.value) {
      promises.push(
        AI.getSettings().catch(() => null),
        Workspaces.members(auth.user.workspaceId),
      );
    }
    const [wsData, aiData, aiSettings, membersData] = await Promise.all(promises);

    ws.value = wsData;
    form.value.name = wsData.name;
    aiStatus.value = aiData;

    if (isAdmin.value) {
      // Pre-fill the form with any existing DB overrides
      if (aiSettings?.dbOverrides) {
        const ov = aiSettings.dbOverrides;
        aiForm.value.provider = ov.provider || aiData.provider || "anthropic";
        aiForm.value.model    = ov.model    || "";
        aiForm.value.baseUrl  = ov.baseUrl  || "";
      }
      members.value = membersData || [];
    }
  } catch (e) {
    notifyError(e, "Failed to load workspace");
  } finally {
    loading.value = false;
  }
}

async function onSaveAi() {
  if (!aiForm.value.apiKey?.trim() && !aiForm.value.model?.trim() && !aiForm.value.baseUrl?.trim()) {
    $q.notify({ type: "warning", message: "Enter an API key (or at least one override) to save." });
    return;
  }
  aiSaving.value = true;
  try {
    await AI.saveSettings({
      provider: aiForm.value.provider,
      apiKey:   aiForm.value.apiKey.trim(),
      model:    aiForm.value.model.trim(),
      baseUrl:  aiForm.value.baseUrl.trim(),
    });
    aiForm.value.apiKey = ""; // clear the field — key is now stored
    showKey.value = false;
    // Refresh status chip
    aiStatus.value = await AI.status();
    $q.notify({ type: "positive", message: "AI settings saved — active immediately." });
  } catch (e) {
    notifyError(e, "Failed to save AI settings");
  } finally {
    aiSaving.value = false;
  }
}

async function onClearAi() {
  aiClearing.value = true;
  try {
    await AI.clearSettings();
    aiStatus.value = await AI.status();
    aiForm.value = { provider: aiStatus.value.provider || "anthropic", apiKey: "", model: "", baseUrl: "" };
    $q.notify({ type: "positive", message: "Saved key removed — falling back to env vars." });
  } catch (e) {
    notifyError(e, "Failed to remove AI settings");
  } finally {
    aiClearing.value = false;
  }
}
onMounted(load);

async function onSave() {
  saving.value = true;
  try {
    await Workspaces.rename(ws.value.id, form.value.name.trim());
    ws.value.name = form.value.name.trim();
    $q.notify({ type: "positive", message: "Workspace renamed" });
  } catch (e) {
    notifyError(e, "Failed to rename");
  } finally {
    saving.value = false;
  }
}

function notifyError(e, fallback) {
  const msg = e?.response?.data?.message || e.message || fallback;
  $q.notify({ type: "negative", message: msg, timeout: 4000 });
}
</script>

<style scoped>
.page {
  max-width: 1000px;
  margin: 0 auto;
}
.ai-env-table td, .ai-env-table th {
  padding: 6px 10px;
}
.ai-env-table code {
  font-size: 0.8rem;
  background: var(--surface-alt, #f1f5f9);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
