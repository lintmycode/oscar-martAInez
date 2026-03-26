# Source Issue

- Repo: lintmycode/oscar-martAInez
- Number: 1
- URL: https://github.com/lintmycode/oscar-martAInez/issues/1

## Title

Detach data directory from repo and support external echo.ops path

## Body

## Context

Oscar is currently cloned on the OpenClaw host at:

- `/home/nuno/.openclaw/workspace/agents/oscar-martAInez`

The actual working accounting data already lives outside the repo on the NAS-mounted path:

- `/mnt/echo-ops/tmp/data/<YYYY-MM>/`

Observed layout on `echo.ops`:

- `data/2025-10/params.yml`
- `data/2025-10/inputs/`
- `data/2025-10/out/2025-10.xlsx`
- `data/2025-10/nitida-export-2025-10/nitida-2025-10.xlsx`
- same pattern for `2025-11` and `2025-12`

Example `params.yml` shape:

```yml
year: 2025
month: 12
remain: 10847.45
```

The repo README and scripts still assume a local in-repo structure like:

- `data/YYYY-MM/inputs/...`
- `data/YYYY-MM/out/...`
- export bundle created under that same repo-local month folder

That makes the code folder carry operational state/data, which is awkward now that the source of truth already sits on NAS storage.

## Goal

Detach runtime data from the code folder and allow Oscar to read/write month data from an external base path, specifically the `echo.ops` storage.

## Requested change

Add support for a configurable data root, so the tool can operate without requiring `data/` inside the repo.

### Minimum expected behavior

- Support a configurable base path for monthly data, e.g. via CLI flag and/or env var
  - examples:
    - `--data-root /mnt/echo-ops/tmp/data`
    - `OSCAR_DATA_ROOT=/mnt/echo-ops/tmp/data`
- Resolve month folders from that base path:
  - `/mnt/echo-ops/tmp/data/2025-12/...`
- Read:
  - `params.yml`
  - `inputs/`
- Write:
  - `out/`
  - export bundle output
- Keep current repo-local behavior as fallback/default so existing usage does not break

## Nice to have

- Centralize all path resolution in one helper/module instead of scattering `data/YYYY-MM` assumptions
- Update `create-month.js`, `index.js`, `export-bundle.js`, and README examples
- Make export bundle location consistent under the selected external month directory

## Why this matters

This separates:

- **code/tooling** in the repo
- **operational month data** on shared storage (`echo.ops`)

That should make Oscar easier to run from OpenClaw/agents, easier to back up, and less brittle when the repo is updated or recloned.

