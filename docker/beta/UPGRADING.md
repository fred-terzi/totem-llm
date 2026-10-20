# Upgrading the Beta Docker Container

How to update the running beta (https://beta.totemai.xyz) to new `dev-totem`
commits **without losing user data**. Written for humans and agents.

## How the container works (30-second version)

The image is nearly empty: it only ships system deps + `cloudflared` + the
entrypoint script `run.sh`. On every start, `run.sh`:

1. Clones (or `git pull`s) `dev-totem` into `/app/repo` (the `totem-beta-work` volume)
2. Patches `vite.config.js` (`allowedHosts: true`), idempotently
3. Installs deps (root yarn, then npm in `server/`, `collector/`, `frontend/`)
4. Runs `yarn setup:envs` + `yarn prisma:setup` (generate + **migrate** + seed)
5. Starts the Cloudflare named tunnel → `https://beta.totemai.xyz`
6. `exec yarn dev:all` (server :28686, collector :28888, Vite :13000)

**Consequence:** upgrading the code is just a restart. The entrypoint pulls,
reinstalls, and applies Prisma migrations automatically.

## Volumes — what matters

| Volume | Mount | Contents | Verdict |
|---|---|---|---|
| `totem-beta-work` | `/app` | Git clone + node_modules | Recreatable. Deleting it only costs a slow cold start (full re-clone + reinstall). |
| `totem-beta-data` | `/app/totem-storage` | `totem-llm.db` (SQLite), `comkey/` secrets, `totemllm-fs/` per-user sandboxes, documents, vector cache, uploads | **USER DATA. NEVER DELETE.** |

> ⚠️ **Never run `docker compose down --volumes`** on this stack — it deletes
> `totem-beta-data` and every user account, chat, and sandbox with it.
> Plain `down` (no flag) is safe.

## Standard upgrade procedure

Run from the repo root (`/home/fred-terzi/totem-llm/totemllm-fs/totem-llm`)
on the host.

### 1. Back up the database (always)

```bash
docker exec totem-beta cp /app/totem-storage/totem-llm.db \
  /app/totem-storage/totem-llm.db.bak-$(date +%Y%m%d-%H%M%S)
```

The backup lands inside the `totem-beta-data` volume, so it survives container
recreation. It also travels with any volume backup.

### 2. Restart the container (code update)

```bash
docker compose -f docker/beta/docker-compose.yml down
docker compose -f docker/beta/docker-compose.yml up -d
```

Or, if only the branch code changed (most upgrades), the simpler equivalent:

```bash
docker restart totem-beta
```

Both paths trigger the same entrypoint: pull → install → prisma migrate →
tunnel → dev servers.

### 3. Watch the logs until healthy

```bash
docker logs -f totem-beta
```

Wait for the banner:

```
✅  BETA WEBSITE IS LIVE (named (permanent) tunnel)
    https://beta.totemai.xyz
```

Then confirm health and the new commit:

```bash
docker ps --filter name=totem-beta --format '{{.Status}}'   # expect "healthy"
docker exec totem-beta git -C /app/repo rev-parse --short HEAD
```

### 4. Test

Load https://beta.totemai.xyz, log in, send a chat message, and (if relevant
to the changes) exercise the affected feature. Check the log tail for errors:

```bash
docker logs --tail 100 totem-beta
```

## When to also rebuild the image

Only if `docker/beta/Dockerfile`, `run.sh`, `docker-compose.yml`, or base
system deps changed:

```bash
docker compose -f docker/beta/docker-compose.yml up -d --build
```

This rebuilds the image but **does not touch either volume** — user data and
the clone are safe. Restart via `down`/`up` is required anyway to pick up the
new image, so this replaces step 2.

## Recovery

- **Bad deploy / broken build**: keep the container from crash-looping while
  you investigate with `docker stop totem-beta` (compose `restart:
  unless-stopped` will otherwise keep retrying). Fix forward, or pin
  `REPO_BRANCH` / a commit in `docker-compose.yml` and `up -d`.
- **Bad migration**: stop the container, restore the backup from step 1:
  ```bash
  docker stop totem-beta
  docker run --rm -v totem-beta_totem-beta-data:/data alpine sh -c \
    'cd /data/totem-storage && cp totem-llm.db.bak-<TIMESTAMP> totem-llm.db'
  docker start totem-beta
  ```
- **Verify a backup exists** before a risky upgrade:
  ```bash
  docker exec totem-beta ls -lh /app/totem-storage/totem-llm.db.bak-*
  ```

## Gotchas

- **`git checkout -- .` on every start**: any locally modified tracked file in
  `/app/repo` is wiped on restart. All changes must live upstream on
  `dev-totem` — never patch code inside the container and expect it to last
  (the `vite.config.js` sed patch is re-applied automatically for this reason).
- **`yarn.lock` shows as modified in `git status`** after installs — this is
  cosmetic and discarded on the next restart. Ignore it.
- **Untracked files in `/app/repo` persist** across restarts (git checkout --
  only touches tracked files) but do NOT persist if the `totem-beta-work`
  volume is ever recreated. Treat `/app/repo` as disposable; treat
  `/app/totem-storage` as sacred.
- **Port mapping**: host 31300 → container 13000 (Vite, the public entry).
  If the site is down but the container is healthy, check the tunnel log:
  `docker exec totem-beta cat /tmp/cloudflared.log`.
