# Release a plugin (npm + Docker)

A Daisy workflow that takes a git repo URL, clones it, and pushes the package
to both **npm** (`@daisy-workflow/<name>`) and **Docker Hub**
(`vivek13186/daisy-<name>`, multi-arch). The Daisy-native equivalent of the
per-plugin GitHub Actions `release.yml`.

## When to use this vs GitHub Actions

|                | GitHub Actions (`release.yml`)              | This workflow                                  |
| -------------- | ------------------------------------------- | ---------------------------------------------- |
| Trigger        | Tag push (`v*.*.*`)                         | Manual, webhook, or chained from another flow  |
| Secrets live   | Per-repo GitHub secrets                     | Daisy workspace configs (centralised)          |
| Provenance     | Yes (npm `--provenance` via OIDC)           | No (provenance needs GitHub OIDC)              |
| Releases page  | Auto-cuts a GitHub Release                  | Skipped                                        |
| Best for       | Project maintainers doing per-repo tags     | Coordinating releases across many plugins      |

Use the GitHub Actions flow as the **default**; reach for this workflow when
you want to:

- Re-release several plugins in lockstep without tagging each one
- Trigger releases from outside GitHub (e.g. an internal admin UI hitting a
  webhook on Daisy)
- Republish after fixing a half-broken release without bumping the tag
- Run a release from a fork that doesn't have GH Actions enabled

## Prerequisites (one-time setup)

The worker container that executes this workflow needs:

1. **`docker` CLI + buildx** installed in the image. The default backend
   `Dockerfile` doesn't include them — add this to the runtime layer:

   ```dockerfile
   # Install docker-cli + buildx (multi-arch builds)
   RUN apk add --no-cache docker-cli docker-cli-buildx
   ```

2. **A Docker daemon the worker can talk to.** Two common patterns:

   - **Host socket mount** (simplest, dev-only):

     ```yaml
     # docker-compose.yml — under the worker service
     volumes:
       - /var/run/docker.sock:/var/run/docker.sock
     ```

     ⚠️ The worker can do anything Docker can — only do this on trusted hosts.

   - **DinD sidecar** (production):

     ```yaml
     services:
       dind:
         image: docker:dind
         privileged: true
         environment:
           - DOCKER_TLS_CERTDIR=
       worker:
         environment:
           - DOCKER_HOST=tcp://dind:2375
     ```

3. **QEMU registered for multi-arch** (only needed if your worker isn't already
   amd64+arm64). Once-per-host:

   ```sh
   docker run --privileged --rm tonistiigi/binfmt --install all
   ```

## Workspace configs to create

In **Configurations → New**, add two `generic` configs:

| Name         | Type      | Fields                                    |
| ------------ | --------- | ----------------------------------------- |
| `npm`        | `generic` | `token` — npm automation token (publish access to `@daisy-workflow`) |
| `dockerhub`  | `generic` | `username` (`vivek13186`), `token` (Docker Hub PAT) |

The workflow references them as `${config.npm.token}`, `${config.dockerhub.username}`,
`${config.dockerhub.token}`. Both are encrypted at rest via the workspace KMS
provider.

## Running it

### Option A — Run from the editor

1. Open the workflow in the Daisy editor
2. Edit the **Inputs** panel and set:
   - `gitUrl` — e.g. `https://github.com/daisy-workflow/plugin-jira.git`
   - `gitRef` — branch or tag (defaults to `main`)
3. Hit **Run**

### Option B — Webhook trigger

Add a webhook trigger on this workflow, then POST:

```sh
curl -X POST https://<daisy-host>/webhooks/<trigger-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "gitUrl": "https://github.com/daisy-workflow/plugin-jira.git",
    "gitRef": "v0.1.0"
  }'
```

### Option C — Chain from another workflow

Use `workflow.fire` with `inputs: { gitUrl, gitRef }` to release as a step
of a larger pipeline (e.g. "release all six plugins" parent workflow).

## What it does, node by node

```
cleanWorkdir → clone → readPackageJson → parseMetaRaw → meta
                                                         │
                                  ┌──────────────────────┴──────────┐
                                  ▼                                 ▼
                            installDeps                        dockerLogin
                                  │                                 │
                                  ▼                                 ▼
                            npmPublish                       ensureBuilder
                                  │                                 │
                                  │                                 ▼
                                  │                        dockerBuildPush
                                  │                                 │
                                  └─────────────► cleanup ◄─────────┘
```

1. **`cleanWorkdir`** — `rm -rf /tmp/daisy-release`. Idempotent so reruns
   don't drag stale state.
2. **`clone`** — `git clone --depth=1` the target repo into the workdir.
   Public repos work without auth; for private ones add a `git` workspace
   config with a `token` field and pass `config: "git"` on this node.
3. **`readPackageJson`** — File-read `package.json` off the cloned tree.
4. **`parseMetaRaw`** — Run a one-liner Node script to derive
   `{ name, version, shortName, image }`. Kept in node-land instead of FEEL
   so the `@daisy-workflow/` prefix is unambiguous to strip.
5. **`meta`** — `transform` step that `parseJson(trim(...))` the script's
   stdout into a structured variable.
6. **`installDeps`** — `npm install --omit=dev` so the published tarball
   matches what consumers `npm install` will get.
7. **`npmPublish`** — `npm publish --access public`. Auth via `NPM_TOKEN`
   env (read from the `npm` workspace config).
8. **`dockerLogin`** — `docker login --password-stdin` (token piped on stdin
   so it never appears in `ps` output).
9. **`ensureBuilder`** — Create or reuse a `docker-container`-driven
   buildx builder named `daisy-release-builder`. Required for `--platform`
   support — the default builder only builds for the host arch.
10. **`dockerBuildPush`** — `docker buildx build --platform linux/amd64,linux/arm64`
    with `:VERSION` AND `:latest` tags, plus OCI labels so the image
    self-describes on Docker Hub. `--push` pushes during build.
11. **`cleanup`** — Best-effort `rm -rf` of the workdir. `onError: continue`
    so a stray glitch doesn't fail an otherwise successful release.

## Notes & gotchas

- **`meta.version` doesn't need a tag check** — unlike the GitHub Actions
  flow, here the trigger explicitly passes `gitRef`, so the version baked
  into `package.json` at that ref is what gets published. Bump
  `package.json`, commit, tag if you like, then pass the tag as `gitRef`.

- **Multi-arch builds are slow on amd64-only hosts** because arm64 is
  emulated via QEMU. Expect 2–5 minutes per plugin. The `timeoutMs` on
  `dockerBuildPush` is 15 minutes to leave headroom.

- **Sequential vs parallel** — the npm and Docker branches fan out from
  `meta` and join at `cleanup`. The engine runs them in parallel, so the
  Docker push isn't blocked on the npm publish (or vice-versa).

- **Republishing the same version fails fast** — `npm publish` will return
  `EPUBLISHCONFLICT` if the version is already on the registry, and the
  workflow will mark `npmPublish` failed. The Docker branch can still
  succeed in parallel since they share no edge; if you want the whole
  release to atomic-fail, wire a `dockerBuildPush ← npmPublish` edge.
