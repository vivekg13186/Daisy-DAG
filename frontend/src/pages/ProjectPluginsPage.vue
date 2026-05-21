<!--
  Project plugin enablement — which workspace-installed plugins this
  project's workflows are allowed to use.

  Visible to project admins + editors (anyone who can author workflows
  also chooses what tools they can pull from). Workspace admins inherit.

  Built-in (core) plugins always come back as enabled and are rendered
  read-only — they're part of the engine.
-->
<template>
  <div class="page q-pa-md pp-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">Project plugins</div>
        <div class="text-caption text-grey-7">
          Plugins are installed at the workspace level. Toggle which ones
          your project is allowed to use. Core plugins are always available.
        </div>
      </div>
      <q-space />
      <q-btn icon="refresh" flat dense @click="reload">
        <q-tooltip>Refresh</q-tooltip>
      </q-btn>
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="name"
      flat dense bordered
      :loading="loading"
      :pagination="{ rowsPerPage: 100, sortBy: 'name', descending: false }"
      :rows-per-page-options="[25, 50, 100, 0]"
    >
      <template v-slot:body-cell-name="props">
        <q-td :props="props">
          <span class="plugin-name plugin-name-link" @click="openDetail(props.row)">{{ props.row.name }}</span>
          <q-chip v-if="props.row.core" dense square size="11px" color="primary" text-color="white" class="q-ml-xs">core</q-chip>
          <q-chip v-else-if="props.row.source && props.row.source.startsWith('marketplace')"
                  dense square size="11px" color="teal" text-color="white" class="q-ml-xs">marketplace</q-chip>
          <q-chip v-else-if="props.row.source === 'local'"
                  dense square size="11px" color="grey-6" text-color="white" class="q-ml-xs">local</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-version="props">
        <q-td :props="props">
          <code class="version">{{ props.row.version }}</code>
        </q-td>
      </template>

      <template v-slot:body-cell-status="props">
        <q-td :props="props">
          <q-chip
            v-if="props.row.status === 'healthy' || props.row.core"
            dense square size="11px" color="positive" text-color="white"
          >healthy</q-chip>
          <q-chip
            v-else-if="props.row.status === 'unhealthy'"
            dense square size="11px" color="negative" text-color="white"
          >unhealthy</q-chip>
          <q-chip
            v-else
            dense square size="11px" color="grey-5" text-color="white"
          >{{ props.row.status || "unknown" }}</q-chip>
        </q-td>
      </template>

      <template v-slot:body-cell-enabled="props">
        <q-td :props="props" auto-width>
          <q-toggle
            :model-value="props.row.enabled_in_project"
            :disable="props.row.core || busyRow === props.row.name"
            color="primary"
            @update:model-value="(v) => onToggle(props.row, v)"
          >
            <q-tooltip v-if="props.row.core">Core plugins are always enabled</q-tooltip>
          </q-toggle>
        </q-td>
      </template>

      <template v-slot:body-cell-granted="props">
        <q-td :props="props">
          <template v-if="props.row.enabled_in_project && !props.row.core">
            <q-tooltip>{{ new Date(props.row.granted_at).toLocaleString() }}</q-tooltip>
            <span class="text-grey-7">{{ props.row.granted_by_email || "—" }}</span>
          </template>
          <span v-else class="text-grey-5">—</span>
        </q-td>
      </template>
    </q-table>

    <!-- ── Plugin detail dialog ───────────────────────────────────── -->
    <q-dialog v-model="detailOpen" max-width="560px">
      <q-card v-if="detailRow" style="min-width:480px;max-width:560px">
        <!-- Header -->
        <q-card-section class="row items-center q-pb-none">
          <div class="col">
            <div class="text-subtitle1 plugin-name">{{ detailRow.name }}</div>
            <div class="text-caption text-grey-6 q-mt-xs">
              v{{ detailRow.version }}
              &nbsp;·&nbsp;
              <span v-if="detailRow.core" class="text-primary">core (always on)</span>
              <span v-else-if="detailRow.source && detailRow.source.startsWith('marketplace')" class="text-teal">marketplace</span>
              <span v-else-if="detailRow.source === 'local'" class="text-grey-7">local</span>
              <span v-else class="text-grey-7">{{ detailRow.source || 'unknown' }}</span>
              &nbsp;·&nbsp;
              <span :class="detailRow.status === 'healthy' || detailRow.core ? 'text-positive' : 'text-negative'">
                {{ detailRow.core ? 'healthy' : (detailRow.status || 'unknown') }}
              </span>
            </div>
          </div>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-card-section>

        <q-separator class="q-mt-sm" />

        <q-card-section class="q-gutter-y-md" style="max-height:70vh;overflow-y:auto">

          <!-- Description -->
          <div v-if="detailRow.manifest?.description">
            <div class="detail-label">What it does</div>
            <div class="text-body2">{{ detailRow.manifest.description }}</div>
          </div>

          <!-- Category -->
          <div v-if="detailRow.manifest?.category">
            <div class="detail-label">Category</div>
            <div class="text-body2">{{ detailRow.manifest.category }}</div>
          </div>

          <!-- Enablement state -->
          <div>
            <div class="detail-label">Status in this project</div>
            <div class="text-body2">
              <template v-if="detailRow.core">
                Always enabled — core plugins are built into the engine and cannot be turned off.
              </template>
              <template v-else-if="detailRow.enabled_in_project">
                Enabled.
                <span v-if="detailRow.granted_by_email" class="text-grey-7">
                  Granted by {{ detailRow.granted_by_email }}
                  <template v-if="detailRow.granted_at">
                    on {{ new Date(detailRow.granted_at).toLocaleString() }}
                  </template>.
                </span>
                Use the toggle in the table to disable it.
              </template>
              <template v-else>
                Disabled for this project. Use the toggle in the table to enable it.
              </template>
            </div>
          </div>

          <!-- Inputs -->
          <div v-if="detailInputs.length">
            <div class="detail-label">Inputs</div>
            <q-list dense bordered class="rounded-borders">
              <q-item v-for="inp in detailInputs" :key="inp.name" dense>
                <q-item-section>
                  <q-item-label>
                    <code class="param-name">{{ inp.name }}</code>
                    <q-badge v-if="inp.required" color="orange-7" class="q-ml-xs" label="required" />
                    <span class="q-ml-xs text-grey-6 text-caption">{{ inp.type }}</span>
                  </q-item-label>
                  <q-item-label v-if="inp.description" caption>{{ inp.description }}</q-item-label>
                  <q-item-label v-if="inp.default !== undefined" caption class="text-grey-6">
                    default: <code>{{ JSON.stringify(inp.default) }}</code>
                  </q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </div>

          <!-- Outputs -->
          <div v-if="detailOutputs.length">
            <div class="detail-label">Outputs</div>
            <q-list dense bordered class="rounded-borders">
              <q-item v-for="out in detailOutputs" :key="out.name" dense>
                <q-item-section>
                  <q-item-label>
                    <code class="param-name">{{ out.name }}</code>
                    <span class="q-ml-xs text-grey-6 text-caption">{{ out.type }}</span>
                  </q-item-label>
                  <q-item-label v-if="out.description" caption>{{ out.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </div>

          <!-- Setup note for external / marketplace plugins -->
          <div v-if="!detailRow.core && detailRow.source !== 'core'">
            <div class="detail-label">How to set up</div>
            <div class="text-body2">
              <ol class="q-pl-md q-mt-xs q-mb-none" style="line-height:1.8">
                <li>Workspace admin installs the plugin under <strong>Admin → Plugins</strong>.</li>
                <li>Toggle the plugin on using the switch in this table to enable it for your project.</li>
                <li v-if="detailRow.source && detailRow.source.startsWith('marketplace')">
                  Marketplace plugins run as containers. Make sure the container is healthy (green status above) before using it in a workflow.
                </li>
                <li>Add a node in the Flow Designer and pick <strong>{{ detailRow.name }}</strong> from the plugin list.</li>
                <li>Configure the required inputs shown above directly on the node.</li>
              </ol>
            </div>
          </div>

        </q-card-section>

        <q-separator />
        <q-card-actions align="right">
          <q-btn flat label="Close" color="primary" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { ProjectPlugins } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const rows      = ref([]);
const loading   = ref(false);
const loadError = ref("");
const busyRow   = ref(null);

// ── Plugin detail dialog ──────────────────────────────────────────
const detailOpen = ref(false);
const detailRow  = ref(null);

function openDetail(row) {
  detailRow.value  = row;
  detailOpen.value = true;
}

const detailInputs = computed(() => {
  const props = detailRow.value?.manifest?.inputSchema?.properties;
  if (!props) return [];
  const required = detailRow.value?.manifest?.inputSchema?.required || [];
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type:        Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type || "any"),
    description: schema.description || "",
    required:    required.includes(name),
    default:     schema.default,
  }));
});

const detailOutputs = computed(() => {
  const props = detailRow.value?.manifest?.outputSchema?.properties;
  if (!props) return [];
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type:        Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type || "any"),
    description: schema.description || "",
  }));
});

const columns = [
  { name: "name",    label: "Plugin",        field: "name",    align: "left", sortable: true },
  { name: "version", label: "Version",       field: "version", align: "left", style: "width: 100px;" },
  { name: "status",  label: "Status",        field: "status",  align: "left", style: "width: 110px;" },
  { name: "enabled", label: "Enabled here",  align: "center",  style: "width: 130px;" },
  { name: "granted", label: "Granted by",    field: "granted_by_email", align: "left" },
];

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    rows.value = await ProjectPlugins.list();
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message || "load failed";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  // Same as the service-accounts page — fall back to auto-select
  // before bouncing. Closes the post-login / deep-link race.
  if (!auth.activeProjectId) {
    const picked = await auth.ensureActiveProject();
    if (!picked) {
      router.replace({ name: "home" });
      return;
    }
  }
  await reload();
});

async function onToggle(row, value) {
  busyRow.value = row.name;
  try {
    await ProjectPlugins.set(row.name, value);
    // Update locally so the UI doesn't flicker through a refetch.
    row.enabled_in_project = value;
    $q.notify({
      type: "positive",
      message: `"${row.name}" ${value ? "enabled" : "disabled"} in this project`,
      timeout: 1200, position: "bottom",
    });
  } catch (e) {
    $q.notify({
      type: "negative",
      message: e?.response?.data?.message || e.message || "toggle failed",
      position: "bottom",
    });
  } finally {
    busyRow.value = null;
  }
}
</script>

<style scoped>
/* Padding handled by q-pa-md on the root div — matches UsersPage. */
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.plugin-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.plugin-name-link {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}
.plugin-name-link:hover {
  color: #2f6df3;
}
.detail-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 4px;
}
.param-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
}
.version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
</style>
