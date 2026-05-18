<!--
  Plugins admin page (admin-only).

  Two tabs:
    • Installed      — every plugin currently registered with the engine.
                       Core / local / HTTP transport. Shows version +
                       source + transport + status. Admin actions:
                       enable / disable, uninstall (version-aware),
                       promote a version to default.
    • Browse marketplace — fetches the marketplace catalog (see
                       backend/src/plugins/catalog.js), shows category +
                       keyword filters, renders rows as cards. Each card
                       has a "Show install snippet" dialog (Compose YAML
                       for the container image) and an "Install" action
                       that prompts for the running endpoint URL and
                       calls installFromCatalog (manifest is
                       SHA-256-verified on the server).

  Core plugins ship with the worker; they can be disabled but never
  uninstalled (the next worker boot upserts them back). Local + HTTP
  plugins can be fully removed, per version.
-->

<template>
  <div class="page q-pa-md">
    <div class="page-header row items-center q-mb-md">
      <div class="col">
        <div class="text-h6">Plugins</div>
        <div class="text-caption text-grey-7">
          Core, local, and external HTTP-transport plugins. The
          FlowDesigner palette pulls from the Installed list.
        </div>
      </div>
      <div class="col-auto q-gutter-sm">
        <q-btn flat dense icon="refresh" no-caps label="Refresh"
               :loading="refreshing" @click="onRefresh">
          <q-tooltip>Reload the engine's in-memory registry from DB</q-tooltip>
        </q-btn>
        <q-btn
          v-if="tab === 'installed'"
          flat dense icon="auto_awesome" no-caps
          color="primary" label="Ask agent"
          @click="openAgent"
        >
          <q-tooltip>Have an AI agent draft a brand-new plugin for you</q-tooltip>
        </q-btn>
        <q-btn
          v-if="tab === 'installed'"
          color="primary" unelevated icon="add" no-caps
          label="Install from URL" @click="openInstall"
        />
      </div>
    </div>

    <q-tabs v-model="tab" align="left" no-caps inline-label class="q-mb-md">
      <q-tab name="installed"   icon="extension"     label="Installed" />
      <q-tab name="marketplace" icon="storefront"    label="Browse marketplace" />
    </q-tabs>

    <q-tab-panels v-model="tab" animated keep-alive class="bg-transparent">

      <!-- ====================================================== -->
      <!-- Installed                                              -->
      <!-- ====================================================== -->
      <q-tab-panel name="installed" class="q-pa-none">
        <q-table
          :rows="installedGrouped"
          :columns="columns"
          row-key="rowKey"
          flat bordered
          :loading="loading"
          :pagination="{ rowsPerPage: 0 }"
          hide-bottom
        >
          <template #body-cell-name="props">
            <q-td :props="props">
              <div class="row items-center no-wrap">
                <PluginIcon :action="props.row.name" size="18px" class="q-mr-sm" />
                <span class="ellipsis">{{ props.row.name }}</span>
              </div>
            </q-td>
          </template>

          <template #body-cell-version="props">
            <q-td :props="props">
              <span>{{ props.row.version }}</span>
              <q-badge
                v-if="props.row.is_default && props.row.hasMultipleVersions"
                color="primary"
                outline
                label="default"
                class="q-ml-xs"
              />
            </q-td>
          </template>

          <template #body-cell-status="props">
            <q-td :props="props">
              <q-badge :color="statusColor(props.row.status)" :label="props.row.status || 'unknown'" />
              <div
                v-if="props.row.last_error"
                class="text-caption text-grey-7"
                :title="props.row.last_error"
              >
                {{ truncate(props.row.last_error, 60) }}
              </div>
              <div
                v-if="props.row.last_health_at"
                class="text-caption text-grey-6"
              >
                {{ formatLastHealth(props.row.last_health_at) }}
              </div>
            </q-td>
          </template>

          <template #body-cell-source="props">
            <q-td :props="props">
              <q-chip
                dense outline
                :color="props.row.source === 'core' ? 'primary' : 'grey-7'"
                :label="props.row.source"
              />
            </q-td>
          </template>

          <template #body-cell-transport="props">
            <q-td :props="props">
              <q-icon
                :name="props.row.transport === 'http' ? 'cloud' : 'memory'"
                :title="props.row.transport"
                size="18px"
                class="q-mr-xs"
              />
              {{ props.row.transport }}
              <div
                v-if="props.row.transport === 'http' && props.row.endpoint"
                class="text-caption text-grey-7"
              >
                {{ props.row.endpoint }}
              </div>
            </q-td>
          </template>

          <template #body-cell-enabled="props">
            <q-td :props="props">
              <q-toggle
                :model-value="props.row.enabled !== false"
                color="positive"
                @update:model-value="(v) => onToggle(props.row, v)"
                :disable="busyRow === props.row.rowKey"
              />
            </q-td>
          </template>

          <template #body-cell-actions="props">
            <q-td :props="props" class="text-right">
              <q-btn
                v-if="props.row.hasMultipleVersions && !props.row.is_default"
                flat dense icon="star_outline" color="primary"
                :loading="busyRow === props.row.rowKey"
                @click="onSetDefault(props.row)"
              >
                <q-tooltip>Promote this version to default</q-tooltip>
              </q-btn>
              <q-btn
                v-if="props.row.source !== 'core'"
                flat dense icon="delete" color="negative"
                :loading="busyRow === props.row.rowKey"
                @click="onUninstall(props.row)"
              >
                <q-tooltip>Uninstall this version</q-tooltip>
              </q-btn>
              <q-btn v-else flat dense icon="lock" disable>
                <q-tooltip>Core plugins can be disabled but not uninstalled</q-tooltip>
              </q-btn>
            </q-td>
          </template>
        </q-table>
      </q-tab-panel>

      <!-- ====================================================== -->
      <!-- Browse marketplace                                     -->
      <!-- ====================================================== -->
      <q-tab-panel name="marketplace" class="q-pa-none">
        <div class="row items-center q-gutter-sm q-mb-md">
          <q-input
            v-model="catalogSearch"
            outlined dense clearable
            placeholder="Search by name, tag, summary"
            class="col"
            debounce="200"
          >
            <template #prepend><q-icon name="search" /></template>
          </q-input>
          <q-select
            v-model="catalogCategory"
            :options="categoryOptions"
            outlined dense
            label="Category"
            emit-value map-options
            style="min-width: 180px"
          />
          <q-btn flat dense no-caps icon="refresh" label="Reload catalog"
                 :loading="catalogLoading" @click="loadCatalog(true)" />
        </div>

        <q-banner v-if="catalogError" class="bg-red-1 text-red-9 q-mb-md" rounded>
          {{ catalogError }}
        </q-banner>

        <div v-if="catalogLoading && filteredCatalog.length === 0"
             class="row justify-center q-pa-xl">
          <q-spinner size="32px" color="primary" />
        </div>

        <div v-else-if="filteredCatalog.length === 0 && !catalogError"
             class="text-grey-6 q-pa-xl text-center">
          No catalog entries match the current filter.
        </div>

        <div class="row q-col-gutter-md">
          <div
            v-for="p in filteredCatalog"
            :key="`${p.name}@${p.version}`"
            class="col-12 col-md-6 col-lg-4"
          >
            <q-card flat bordered class="catalog-card">
              <q-card-section>
                <div class="row items-center no-wrap q-gutter-sm">
                  <PluginIcon :action="p.name" size="28px" />
                  <div class="col">
                    <div class="text-subtitle1 ellipsis">{{ p.name }}</div>
                    <div class="text-caption text-grey-7">v{{ p.version }}</div>
                  </div>
                  <q-chip
                    v-if="p.installed"
                    dense color="positive" text-color="white"
                    icon="check" label="installed"
                  />
                  <q-chip
                    v-else-if="p.category" dense outline
                    :label="p.category"
                  />
                </div>
                <div v-if="p.summary" class="text-body2 q-mt-sm">{{ p.summary }}</div>
                <div v-if="p.tags && p.tags.length" class="q-mt-sm">
                  <q-chip
                    v-for="t in p.tags" :key="t"
                    dense size="sm" outline color="grey-7" :label="t"
                  />
                </div>
              </q-card-section>

              <q-card-actions align="right">
                <q-btn
                  v-if="p.homepage" flat dense icon="open_in_new" no-caps
                  label="Homepage" type="a" :href="p.homepage" target="_blank"
                />
                <q-btn
                  flat dense icon="terminal" no-caps label="Install snippet"
                  @click="openSnippet(p)"
                />
                <q-btn
                  unelevated dense color="primary" no-caps
                  :disable="p.installed"
                  :label="p.installed ? 'Installed' : 'Install'"
                  @click="openCatalogInstall(p)"
                />
              </q-card-actions>
            </q-card>
          </div>
        </div>

        <div v-if="catalogMeta.source" class="text-caption text-grey-6 q-mt-md">
          Source: {{ catalogMeta.source }}
          <span v-if="catalogMeta.fetchedAt">
            · fetched {{ formatFetchedAt(catalogMeta.fetchedAt) }}
          </span>
        </div>
      </q-tab-panel>
    </q-tab-panels>

    <!-- ====================================================== -->
    <!-- Install-from-URL dialog (existing flow)                 -->
    <!-- ====================================================== -->
    <q-dialog v-model="installOpen">
      <q-card style="min-width: 460px">
        <q-card-section>
          <div class="text-subtitle1">Install external plugin</div>
          <div class="text-caption text-grey-7 q-mt-xs">
            Daisy probes the endpoint's <code>/manifest</code>, validates it,
            and persists. The container itself must already be running
            and reachable from this host.
          </div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input
            v-model="installEndpoint"
            label="Plugin endpoint URL"
            placeholder="http://reddit-plugin:8080"
            outlined
            autofocus
          />
          <q-input
            v-model="installSource"
            label="Source label (optional)"
            placeholder="local"
            outlined
            hint="Free-form provenance tag."
          />
          <q-banner v-if="installError" class="bg-red-1 text-red-9" rounded>
            {{ installError }}
          </q-banner>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn unelevated color="primary" label="Install"
                 :loading="installing" @click="onInstall" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- ====================================================== -->
    <!-- Install-from-catalog dialog                             -->
    <!-- ====================================================== -->
    <q-dialog v-model="catalogInstallOpen">
      <q-card style="min-width: 520px">
        <q-card-section>
          <div class="text-subtitle1">
            Install {{ catalogInstallTarget?.name }}
            <span class="text-caption text-grey-7">
              v{{ catalogInstallTarget?.version }}
            </span>
          </div>
          <div class="text-caption text-grey-7 q-mt-xs">
            The container should already be running. Daisy will download
            <code>{{ catalogInstallTarget?.manifestUrl }}</code>, verify the
            checksum, then probe your endpoint's <code>/readyz</code>.
          </div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input
            v-model="catalogInstallEndpoint"
            label="Plugin endpoint URL"
            placeholder="http://reddit-plugin:8080"
            outlined
            autofocus
          />
          <q-input
            v-model="catalogInstallSource"
            label="Source label (optional)"
            outlined
            hint="Free-form provenance. Defaults to 'marketplace'."
          />
          <q-banner
            v-if="catalogInstallTarget?.manifestSha256"
            class="bg-blue-1 text-blue-9" rounded dense
          >
            <q-icon name="verified_user" class="q-mr-xs" />
            Manifest checksum will be verified on download.
          </q-banner>
          <q-banner v-if="catalogInstallError" class="bg-red-1 text-red-9" rounded>
            {{ catalogInstallError }}
          </q-banner>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn unelevated color="primary" label="Install"
                 :loading="catalogInstalling" @click="onCatalogInstall" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- ====================================================== -->
    <!-- Ask agent dialog                                        -->
    <!-- ====================================================== -->
    <q-dialog v-model="agentOpen" persistent>
      <q-card style="min-width: 720px; max-width: 95vw">
        <q-card-section class="row items-center no-wrap">
          <div class="col">
            <div class="text-subtitle1">
              <q-icon name="auto_awesome" class="q-mr-xs" />
              Ask agent to draft a plugin
            </div>
            <div class="text-caption text-grey-7 q-mt-xs">
              Describe what the plugin should do. The agent emits a complete
              HTTP-transport scaffold (manifest + index.js + package.json +
              Dockerfile + README) — you review, download, and deploy.
            </div>
          </div>
          <q-btn flat dense round icon="close" v-close-popup />
        </q-card-section>

        <!-- ─── Stage 1: prompt the agent ─── -->
        <template v-if="!agentResult">
          <q-card-section class="q-gutter-md">
            <q-input
              v-model="agentPrompt"
              outlined
              type="textarea"
              autogrow
              :input-style="{ minHeight: '120px' }"
              label="What should the plugin do?"
              placeholder="e.g. Translate text from English to any target language using the DeepL Pro API. Inputs: text (string), targetLang (string, default 'DE'). Output: { translated: string }. Reads a deepl config of type deepl.apikey."
              autofocus
            />
            <div class="row items-center q-gutter-sm">
              <q-select
                v-model="agentTransport"
                :options="[{ label: 'HTTP container (recommended)', value: 'http' }]"
                outlined dense emit-value map-options
                label="Transport"
                style="min-width: 260px"
              />
              <q-banner class="bg-blue-1 text-blue-9 col" rounded dense>
                <q-icon name="info" class="q-mr-xs" />
                The agent only emits files — it never auto-installs.
              </q-banner>
            </div>
            <q-banner v-if="agentError" class="bg-red-1 text-red-9" rounded>
              {{ agentError }}
            </q-banner>
          </q-card-section>
          <q-card-actions align="right">
            <q-btn flat label="Cancel" v-close-popup :disable="agentLoading" />
            <q-btn
              unelevated color="primary" no-caps
              :loading="agentLoading"
              :disable="!agentPrompt || agentPrompt.length < 10"
              label="Generate"
              @click="onAgentGenerate"
            />
          </q-card-actions>
        </template>

        <!-- ─── Stage 2: review the result ─── -->
        <template v-else>
          <q-card-section>
            <div class="row items-center q-gutter-sm">
              <q-chip color="primary" text-color="white" icon="extension"
                      :label="agentResult.name" />
              <q-chip outline color="grey-7" :label="`v${agentResult.version}`" />
              <q-space />
              <q-btn flat dense no-caps icon="refresh" label="Regenerate"
                     @click="agentResult = null" />
            </div>
            <div v-if="agentResult.summary" class="text-body2 q-mt-sm text-grey-8">
              {{ agentResult.summary }}
            </div>
          </q-card-section>

          <q-card-section class="q-pt-none">
            <q-tabs
              v-model="agentFileTab"
              align="left" inline-label no-caps dense
              indicator-color="primary" active-color="primary"
              class="text-grey-7"
            >
              <q-tab name="__deploy__" icon="rocket_launch" label="Deploy" />
              <q-tab
                v-for="(f, i) in agentResult.files"
                :key="f.path"
                :name="`${i}`"
                :label="f.path"
              />
            </q-tabs>
            <q-separator />
            <q-tab-panels v-model="agentFileTab" animated class="agent-panels">
              <q-tab-panel name="__deploy__" class="q-pa-md">
                <div class="markdown-body" v-html="renderedDeploy"></div>
              </q-tab-panel>
              <q-tab-panel
                v-for="(f, i) in agentResult.files"
                :key="f.path"
                :name="`${i}`"
                class="q-pa-none"
              >
                <div class="row items-center q-pa-sm agent-file-header">
                  <code class="text-caption">{{ f.path }}</code>
                  <q-space />
                  <q-btn
                    flat dense no-caps icon="content_copy" size="sm"
                    label="Copy" @click="copyText(f.content)"
                  />
                </div>
                <pre class="agent-file">{{ f.content }}</pre>
              </q-tab-panel>
            </q-tab-panels>
          </q-card-section>

          <q-card-actions align="right">
            <q-btn flat label="Close" v-close-popup />
            <q-btn
              unelevated color="primary" icon="download" no-caps
              :loading="agentDownloading"
              label="Download zip"
              @click="onAgentDownload"
            />
          </q-card-actions>
        </template>
      </q-card>
    </q-dialog>

    <!-- ====================================================== -->
    <!-- Compose snippet dialog                                  -->
    <!-- ====================================================== -->
    <q-dialog v-model="snippetOpen">
      <q-card style="min-width: 560px">
        <q-card-section>
          <div class="text-subtitle1">
            Run {{ snippetTarget?.name }} v{{ snippetTarget?.version }}
          </div>
          <div class="text-caption text-grey-7 q-mt-xs">
            Drop this into a <code>docker-compose.yml</code> next to your
            Daisy stack, then come back and click "Install".
          </div>
        </q-card-section>
        <q-card-section>
          <q-input
            type="textarea"
            outlined readonly
            :model-value="snippetYaml"
            autogrow
            class="snippet"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps icon="content_copy" label="Copy"
                 @click="copySnippet" />
          <q-btn flat label="Close" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useQuasar, copyToClipboard } from "quasar";
import { useRoute, useRouter } from "vue-router";
import { marked } from "marked";
import { Plugins } from "../api/client.js";
import PluginIcon from "../components/PluginIcon.vue";

const $q     = useQuasar();
const route  = useRoute();
const router = useRouter();

// -- Tab state --------------------------------------------------------
const tab = ref("installed");

// -- Installed table --------------------------------------------------
const rows       = ref([]);
const loading    = ref(false);
const refreshing = ref(false);
const busyRow    = ref("");

// -- Install-from-URL dialog ------------------------------------------
const installOpen     = ref(false);
const installEndpoint = ref("");
const installSource   = ref("local");
const installing      = ref(false);
const installError    = ref("");

// -- Marketplace catalog ----------------------------------------------
const catalogLoading = ref(false);
const catalogError   = ref("");
const catalog        = ref([]);
const catalogMeta    = ref({ source: "", fetchedAt: 0 });
const catalogSearch  = ref("");
const catalogCategory = ref("all");

// -- Install-from-catalog dialog --------------------------------------
const catalogInstallOpen     = ref(false);
const catalogInstallTarget   = ref(null);
const catalogInstallEndpoint = ref("");
const catalogInstallSource   = ref("");
const catalogInstalling      = ref(false);
const catalogInstallError    = ref("");

// -- Compose snippet dialog -------------------------------------------
const snippetOpen   = ref(false);
const snippetTarget = ref(null);

// -- Ask-agent dialog -------------------------------------------------
const agentOpen        = ref(false);
const agentPrompt      = ref("");
const agentTransport   = ref("http");
const agentLoading     = ref(false);
const agentError       = ref("");
const agentResult      = ref(null);          // null | { name, version, summary, files, deployInstructions }
const agentFileTab     = ref("__deploy__");
const agentDownloading = ref(false);

const renderedDeploy = computed(() => {
  const md = agentResult.value?.deployInstructions || "";
  try { return marked.parse(md, { breaks: true }); }
  catch { return `<pre>${escapeHtml(md)}</pre>`; }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const columns = [
  { name: "name",       label: "Name",      field: "name",      align: "left", sortable: true },
  { name: "version",    label: "Version",   field: "version",   align: "left", style: "width: 130px" },
  { name: "source",     label: "Source",    field: "source",    align: "left", style: "width: 130px" },
  { name: "transport",  label: "Transport", field: "transport", align: "left", style: "width: 220px" },
  { name: "status",     label: "Status",    field: "status",    align: "left", style: "width: 170px" },
  { name: "enabled",    label: "Enabled",   field: "enabled",   align: "left", style: "width: 80px" },
  { name: "actions",    label: "",          field: "name",      align: "right", style: "width: 110px" },
];

// Annotate every row with a unique key (name@version) and a flag
// indicating whether another version of the same name exists. Used
// to gate the "Set default" action.
const installedGrouped = computed(() => {
  const byName = new Map();
  for (const r of rows.value) {
    if (!byName.has(r.name)) byName.set(r.name, 0);
    byName.set(r.name, byName.get(r.name) + 1);
  }
  return rows.value.map(r => ({
    ...r,
    rowKey: `${r.name}@${r.version}`,
    hasMultipleVersions: byName.get(r.name) > 1,
  }));
});

// -- Catalog derived state --------------------------------------------
const categoryOptions = computed(() => {
  const set = new Set();
  for (const p of catalog.value) if (p.category) set.add(p.category);
  const opts = [{ label: "All categories", value: "all" }];
  for (const c of [...set].sort()) opts.push({ label: c, value: c });
  return opts;
});

const filteredCatalog = computed(() => {
  const q = catalogSearch.value?.trim().toLowerCase() || "";
  const c = catalogCategory.value;
  return catalog.value.filter(p => {
    if (c !== "all" && p.category !== c) return false;
    if (!q) return true;
    const hay = [
      p.name, p.summary, p.category,
      ...(Array.isArray(p.tags) ? p.tags : []),
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
});

const snippetYaml = computed(() => {
  const p = snippetTarget.value;
  if (!p) return "";
  const port = p.containerPort || 8080;
  const image = p.containerImage || `<image-for-${p.name}>`;
  const svcName = (p.name || "plugin").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return [
    "services:",
    `  ${svcName}:`,
    `    image: ${image}`,
    `    restart: unless-stopped`,
    `    ports:`,
    `      - "${port}:${port}"`,
    `    # then in Daisy: install with endpoint http://${svcName}:${port}`,
    "",
  ].join("\n");
});

// -- Lifecycle --------------------------------------------------------
onMounted(() => {
  load();
  // Prefill from the centralised Ask Agent's hand-off card.
  // OrchestratorChat pushes us here with ?askPrompt=...&askTransport=...
  // when the user asks it to build a new plugin; rather than asking the
  // user to retype the spec, we open the Ask-Agent dialog with the
  // prompt pre-loaded so they can review + Generate immediately.
  // After consuming, strip the query so a page refresh doesn't re-open
  // the dialog.
  const ask = route.query?.askPrompt;
  if (typeof ask === "string" && ask.trim()) {
    agentPrompt.value = ask;
    const t = route.query?.askTransport;
    agentTransport.value = t === "stdio" ? "stdio" : "http";
    openAgent();
    router.replace({ path: route.path, query: {} });
  }
});

watch(tab, (t) => {
  if (t === "marketplace" && catalog.value.length === 0 && !catalogError.value) {
    loadCatalog(false);
  }
});

async function load() {
  loading.value = true;
  try {
    rows.value = await Plugins.list();
  } catch (e) {
    notifyError(e, "Failed to load plugins");
  } finally {
    loading.value = false;
  }
}

async function onRefresh() {
  refreshing.value = true;
  try {
    await Plugins.refresh();
    await load();
    if (tab.value === "marketplace") await loadCatalog(true);
    $q.notify({ type: "positive", message: "Registry reloaded", timeout: 1500 });
  } catch (e) {
    notifyError(e, "Failed to refresh");
  } finally {
    refreshing.value = false;
  }
}

// ---- Install from URL ------------------------------------------------
function openInstall() {
  installEndpoint.value = "";
  installSource.value   = "local";
  installError.value    = "";
  installOpen.value     = true;
}

async function onInstall() {
  if (!installEndpoint.value) {
    installError.value = "Endpoint URL is required";
    return;
  }
  installing.value = true;
  installError.value = "";
  try {
    await Plugins.install({
      endpoint: installEndpoint.value.trim(),
      source:   installSource.value.trim() || "local",
    });
    installOpen.value = false;
    await load();
    $q.notify({ type: "positive", message: "Plugin installed", timeout: 1800 });
  } catch (e) {
    installError.value = errMsg(e);
  } finally {
    installing.value = false;
  }
}

// ---- Toggle / uninstall / set-default --------------------------------
async function onToggle(row, enabled) {
  busyRow.value = row.rowKey;
  try {
    // enable/disable are name-scoped (they flip every version's row).
    if (enabled) await Plugins.enable(row.name);
    else         await Plugins.disable(row.name);
    await load();
    $q.notify({ type: "positive", message: `${row.name} ${enabled ? "enabled" : "disabled"}` });
  } catch (e) {
    notifyError(e, "Failed to toggle");
    await load();
  } finally {
    busyRow.value = "";
  }
}

function onUninstall(row) {
  const label = row.hasMultipleVersions
    ? `${row.name} v${row.version}`
    : `"${row.name}"`;
  $q.dialog({
    title: "Uninstall plugin",
    message: `Remove ${label}? Workflows referencing it will fail at parse time until it's re-installed.`,
    cancel: true,
    persistent: true,
    ok: { label: "Uninstall", color: "negative", unelevated: true, "no-caps": true },
  }).onOk(async () => {
    busyRow.value = row.rowKey;
    try {
      if (row.hasMultipleVersions) {
        await Plugins.uninstallVersion(row.name, row.version);
      } else {
        await Plugins.uninstall(row.name);
      }
      await load();
      $q.notify({ type: "positive", message: `${row.name} uninstalled` });
    } catch (e) {
      notifyError(e, "Failed to uninstall");
    } finally {
      busyRow.value = "";
    }
  });
}

async function onSetDefault(row) {
  busyRow.value = row.rowKey;
  try {
    await Plugins.setDefault(row.name, row.version);
    await load();
    $q.notify({ type: "positive", message: `${row.name} v${row.version} is now default` });
  } catch (e) {
    notifyError(e, "Failed to set default");
  } finally {
    busyRow.value = "";
  }
}

// ---- Catalog ---------------------------------------------------------
async function loadCatalog(force) {
  catalogLoading.value = true;
  catalogError.value   = "";
  try {
    const r = await Plugins.catalog({ force: !!force });
    catalog.value     = r.plugins || [];
    catalogMeta.value = { source: r.source, fetchedAt: r.fetchedAt };
  } catch (e) {
    catalogError.value = errMsg(e) || "Failed to load catalog";
  } finally {
    catalogLoading.value = false;
  }
}

function openCatalogInstall(p) {
  catalogInstallTarget.value   = p;
  catalogInstallEndpoint.value = "";
  catalogInstallSource.value   = "marketplace";
  catalogInstallError.value    = "";
  catalogInstallOpen.value     = true;
}

async function onCatalogInstall() {
  const p = catalogInstallTarget.value;
  if (!p) return;
  if (!catalogInstallEndpoint.value) {
    catalogInstallError.value = "Endpoint URL is required";
    return;
  }
  catalogInstalling.value = true;
  catalogInstallError.value = "";
  try {
    await Plugins.installFromCatalog({
      catalogEntryUrl: p.catalogEntryUrl || null,
      manifestUrl:     p.manifestUrl,
      manifestSha256:  p.manifestSha256 || null,
      endpoint:        catalogInstallEndpoint.value.trim(),
      source:          catalogInstallSource.value.trim() || "marketplace",
    });
    catalogInstallOpen.value = false;
    await Promise.all([load(), loadCatalog(true)]);
    $q.notify({
      type: "positive",
      message: `${p.name} v${p.version} installed`,
      timeout: 1800,
    });
  } catch (e) {
    catalogInstallError.value = errMsg(e);
  } finally {
    catalogInstalling.value = false;
  }
}

function openSnippet(p) {
  snippetTarget.value = p;
  snippetOpen.value   = true;
}

async function copySnippet() {
  try {
    await copyToClipboard(snippetYaml.value);
    $q.notify({ type: "positive", message: "Compose snippet copied", timeout: 1200 });
  } catch (e) {
    notifyError(e, "Copy failed");
  }
}

async function copyText(text) {
  try {
    await copyToClipboard(text || "");
    $q.notify({ type: "positive", message: "Copied to clipboard", timeout: 1000 });
  } catch (e) {
    notifyError(e, "Copy failed");
  }
}

// ---- Ask-agent ------------------------------------------------------
function openAgent() {
  // Don't reset prompt — common to tweak + regenerate.
  agentResult.value  = null;
  agentError.value   = "";
  agentFileTab.value = "__deploy__";
  agentOpen.value    = true;
}

async function onAgentGenerate() {
  agentLoading.value = true;
  agentError.value   = "";
  try {
    const out = await Plugins.askAgent({
      prompt:    agentPrompt.value.trim(),
      transport: agentTransport.value,
    });
    agentResult.value  = out;
    agentFileTab.value = "__deploy__";
  } catch (e) {
    agentError.value = errMsg(e) || "Agent generation failed";
  } finally {
    agentLoading.value = false;
  }
}

async function onAgentDownload() {
  if (!agentResult.value) return;
  agentDownloading.value = true;
  try {
    const blob = await Plugins.downloadAgentZip({
      name:  agentResult.value.name,
      files: agentResult.value.files,
    });
    // Browser save-as. We don't trust the server's filename header; build
    // our own from the agent's plugin name.
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = `${agentResult.value.name}-plugin.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    $q.notify({ type: "positive", message: "Plugin zip downloaded", timeout: 1500 });
  } catch (e) {
    notifyError(e, "Download failed");
  } finally {
    agentDownloading.value = false;
  }
}

// ---- helpers ---------------------------------------------------------
function statusColor(s) {
  switch (s) {
    case "healthy":  return "positive";
    case "degraded": return "warning";
    case "down":     return "negative";
    default:         return "grey-6";
  }
}

function formatLastHealth(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return `last check: ${d.toLocaleTimeString()}`;
  } catch { return ""; }
}

function formatFetchedAt(ms) {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString(); } catch { return ""; }
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : (s || ""); }
function errMsg(e)      { return e?.response?.data?.message || e.message || "unknown error"; }
function notifyError(e, fallback) {
  $q.notify({ type: "negative", message: errMsg(e) || fallback, timeout: 4000 });
}
</script>

<style scoped>
.page { max-width: 1200px; margin: 0 auto; }
.catalog-card { height: 100%; display: flex; flex-direction: column; }
.catalog-card .q-card__actions { margin-top: auto; }
.snippet :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
/* Theme-aware surfaces. We use the design-system tokens (defined in
   src/styles.css) instead of literal colours so the dialog recolours
   correctly under html[data-theme="dark"]. The previous hex values
   (#fafafa / #eef / #e6e6e6) and Quasar's bg-grey-1 / bg-grey-2
   classes were baked to the light palette and showed as bright white
   slabs inside dark-themed pages. */
.agent-panels {
  background: var(--surface-2) !important;
  color: var(--text);
}
.agent-file-header {
  background: var(--surface-2);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.agent-file {
  margin: 0;
  padding: 12px 16px;
  max-height: 50vh;
  overflow: auto;
  background: var(--surface-2);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre;
}
.markdown-body { color: var(--text); }
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) { margin-top: 1em; color: var(--text); }
.markdown-body :deep(code) {
  background: var(--primary-soft);
  color: var(--text);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.92em;
}
.markdown-body :deep(pre) {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  overflow-x: auto;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
}
</style>
