---
name: custom-skill-creator
description: 'Create, validate, and deploy a Totem LLM (AnythingLLM) custom agent skill from scratch. Use when the user asks to build a new agent tool/plugin/skill for AnythingLLM or Totem LLM, mentions "custom skill", "plugin.json", "handler.js", or wants to extend @agent with a NodeJS-based capability. Produces: folder skeleton + plugin.json + handler.js + README.md placed in the correct storage location.'
license: MIT
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Totem LLM — Custom Agent Skill Creator Workflow

Create custom agent skills for AnythingLLM / Totem LLM. Skills are NodeJS modules that extend `@agent` invocations with new capabilities (API calls, OS operations, scripts, anything expressible in JS).

> **Sources**: AnythingLLM docs — Custom Skills → Introduction, Developer Guide, plugin.json reference, handler.js reference.

---

## Hard Rules (violate any of these and the skill breaks)

1. **All functions MUST return a `string`.** Any other return type may break agent invocation or loop indefinitely.
2. Skill folder name **MUST equal `hubId`** in `plugin.json`.
3. Entry point is always a file called **`handler.js`** at the skill root, exporting `{ runtime: { handler } }`.
4. `imported` field in `plugin.json` **must be `true`**.
5. Wrap all logic in **try/catch** and return error messages as strings (never throw out of `handler`).
6. Use `require()` for Node modules — prefer **function-scoped requires** over top-level, to avoid module load/unload issues across hot-reloads.
7. **Bundle any third-party packages inside the skill folder.** Do not rely on external node_modules outside the plugin directory.
8. `handler` accepts a single object argument whose keys match `entrypoint.params` in `plugin.json`.
9. Use `await` for all async calls (fetch, fs.promises, child_process.exec, etc.).

---

## Environment & Availability

| Requirement | Detail |
|---|---|
| NodeJS | 18+ (Totem LLM pins v18.18.0) |
| Build tooling | Yarn (only needed if bundling deps) |
| Totem LLM version | Desktop ≥ 1.6.5, Docker commit `d1103e` / release ≥ v1.2.2 |
| Not available on | AnythingLLM Cloud |

---

## Workflow Steps

### Step 1 — Clarify the Skill's Purpose

Before writing any code, confirm with the user:

- **What does it do?** (one sentence)
- **Human-readable name** → `name` field
- **hubId / slug** → kebab-case identifier, also the folder name
- **Input parameters** (the LLM-facing interface): name, type (`string` | `number` | `boolean`), description for each
- **Setup args** (user-configured secrets/config): key, type, required?, default, hint
- **Examples**: 1–3 realistic prompt → call pairs (few-shot)

### Step 2 — Locate the Storage Directory

Skills live in `<STORAGE_DIR>/plugins/agent-skills/<hubId>/`.

```bash
# Default for Totem LLM:
ls -la ~/totem-llm/plugins/agent-skills/

# Or override via env var:
echo $TOTEM_STORAGE_DIR   # or STORAGE_DIR in Docker
```

Create the parent path if it doesn't exist yet:

```bash
mkdir -p "$STORAGE/plugins/agent-skills/<hubId>"
```

**Folder name MUST be exactly equal to `hubId`.**

### Step 3 — Generate `plugin.json`

Template (adapt as needed):

```json
{
  "$schema": "https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/refs/heads/master/server/utils/agents/imported-manifest.schema.json",
  "active": true,
  "hubId": "<kebab-case-slug>",
  "name": "Human Readable Name",
  "schema": "skill-1.0.0",
  "version": "1.0.0",
  "description": "One-line description of what the skill does and when to use it.",
  "author": "@<author>",
  "author_url": "https://github.com/<author>",
  "license": "MIT",

  "setup_args": {
    "MY_API_KEY": {
      "type": "string",
      "required": false,
      "input": {
        "type": "text",
        "default": "",
        "placeholder": "sk-...",
        "hint": "The API key for the service"
      },
      "value": ""
    }
  },

  "examples": [
    { "prompt": "Example user prompt #1", "call": "{\"param1\": \"value1\"}" },
    { "prompt": "Example user prompt #2", "call": "{\"param1\": \"value2\", \"param2\": 42}" }
  ],

  "entrypoint": {
    "file": "handler.js",
    "params": {
      "param1": { "description": "Description of param1 purpose.", "type": "string" },
      "param2": { "description": "Description of param2 purpose.", "type": "number" }
    }
  },

  "imported": true
}
```

**Field reference:**

| Field | Required | Notes |
|---|---|---|
| `$schema` | optional | Editor autocomplete only; ignored at runtime. Safe to include in published skills. |
| `active` | yes | `false` disables the skill without deleting it |
| `hubId` | yes | MUST match parent folder name exactly |
| `name` | yes | Human-readable, shown in UI |
| `schema` | yes | Always `"skill-1.0.0"` — do not change |
| `version` | yes | User-defined semver string |
| `description` | yes | Short; injected into agent prompt context |
| `author`, `author_url`, `license` | optional | Metadata only |
| `setup_args` | optional | Generates UI inputs; values accessible via `this.runtimeArgs.<KEY>` in handler |
| `examples` | optional (strongly recommended) | 1–3 few-shot examples that guide LLM on when/how to call the skill. `call` value must match expected JSON input shape of `handler`. |
| `entrypoint.file` | yes | Path to entry file relative to plugin.json; conventionally `"handler.js"` |
| `entrypoint.params` | optional | Each param: `{ description, type }`; types: `string`, `number`, `boolean`. These become the destructured keys in `handler({ ... })`. |
| `imported` | yes | Always `true` |

### Step 4 — Generate `handler.js`

Template (CommonJS — server is CJS):

```js
// handler.js — <Human Readable Name>
module.exports.runtime = {
  handler: async function ({ param1, param2 }) {
    const callerId = `${this.config.name}-v${this.config.version}`;
    try {
      this.introspect(`${callerId} called with param1:${param1}, param2:${param2}...`);

      // --- main logic goes here ---
      const apiKey = this.runtimeArgs["MY_API_KEY"]; // from setup_args UI input

      // Example: external API call (use await!)
      // const res = await fetch(`https://api.example.com/v1/thing?param=${encodeURIComponent(param1)}`, {
      //   headers: { Authorization: `Bearer ${apiKey}` },
      // });
      // const data = await res.json();

      // Example: function-scoped require for bundled helper (preferred over top-level)
      // const helper = require("./helper.js");
      // const result = helper.doSomething(param1, param2);

      const output = "SUCCESS: <concise description of what happened and the result>";
      this.introspect(output);
      return output;   // ← MUST be a string
    } catch (e) {
      const errMsg = `The tool failed to run. Reason: ${e.message}`;
      this.introspect(`${callerId} error: ${errMsg}`);
      this.logger(callerId, e.stack || e.message);
      return errMsg;   // ← MUST be a string (never throw)
    }
  },

  // Optional private helpers on the runtime object:
  _myHelper(value) {
    // ...
    return value;
  },
};
```

**Runtime API available inside `handler`:**

| Property / Method | Purpose |
|---|---|
| `this.runtimeArgs.<KEY>` | Value of a setup_arg (from UI input or preset `value`) |
| `this.introspect(string)` | Log a "thought" shown to the user in real time. Must be a string. |
| `this.logger(msg, ...extra)` | Console-level debug logging. First arg must be a string. |
| `this.config.name` | Human-readable skill name |
| `this.config.hubId` | Skill hub ID (same as folder name) |
| `this.config.version` | Version from plugin.json |
| `await this.requestToolApproval({ payload, description })` | Pause agent; show Approve/Reject card for destructive actions. Returns `{ approved: boolean, message: string }`. In non-interactive contexts resolves as approved automatically. 120 s timeout → treated as rejected. Use for irreversible operations (deletes, sends, purchases). If `approved === false`, return `approval.message` and stop. |

### Step 5 — Generate `README.md`

```markdown
# <Human Readable Name>

<One-paragraph description of what the skill does.>

## Installation

1. Copy this folder to `<STORAGE_DIR>/plugins/agent-skills/<hubId>/` (folder name must match `hubId`).
2. Open AnythingLLM → Settings → Agent Skills — the skill should appear in the list.
3. If using setup args, fill them in on that page.

## Usage

Ask your agent naturally:

> "What is <example prompt 1>?"
> "<example prompt 2>"

The agent will invoke this skill automatically when relevant.

## Parameters

| Name | Type | Description |
|---|---|---|
| `param1` | string | ... |
| `param2` | number | ... |

## Setup Args (optional)

| Key | Required | Hint |
|---|---|---|
| `MY_API_KEY` | no | API key for the service |

## Dependencies

- NodeJS 18+
- <list any bundled packages, if applicable>

## License

MIT
```

### Step 6 — Deploy & Verify

```bash
# Confirm the folder is in place:
ls -la "$STORAGE/plugins/agent-skills/<hubId>/"
# Expected contents:
#   plugin.json
#   handler.js
#   README.md
#   (any bundled deps / helper files)

# Validate JSON syntax of plugin.json:
node -e "JSON.parse(require('fs').readFileSync('$STORAGE/plugins/agent-skills/<hubId>/plugin.json','utf8')); console.log('OK')"

# Optional: quick smoke test in node (outside AnythingLLM):
cd "$STORAGE/plugins/agent-skills/<hubId>" && \
node -e "
  const mod = require('./handler.js');
  const fakeThis = { config:{name:'Test',version:'1.0.0'}, runtimeArgs:{}, introspect:console.log, logger:console.error };
  Promise.resolve(mod.runtime.handler({ param1:'hello' }, fakeThis))
    .then(r => { console.log('Return type:', typeof r); if (typeof r !== 'string') process.exit(1); console.log('Result:', r); })
    .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

Then in AnythingLLM UI: **Settings → Agent Skills** — the new skill should appear. If it doesn't show, reload the page (new skills need a page refresh; edits to existing skills hot-load but you may need `/exit` from an active agent session first).

### Step 7 — Iterate / Hot-Reload Notes

- **Editing an existing skill**: save changes → if in an active agent invocation, type `/exit` then re-invoke. Otherwise the next invocation picks up changes automatically (hot-reload supported).
- **Adding a new skill**: reload the AnythingLLM page once to register it in the UI list.
- No server restart required for either case.

---

## Quality Checklist Before Delivery

- [ ] Folder name == `hubId` value in plugin.json
- [ ] `plugin.json` parses as valid JSON (`node -e "JSON.parse(...)"`)
- [ ] `imported: true`, `schema: "skill-1.0.0"`, `active: true` present
- [ ] `entrypoint.file` points to a file that exists in the folder
- [ ] `entrypoint.params` keys match exactly what `handler({ ... })` destructures
- [ ] Every path in `handler` returns a **string** (success and error branches)
- [ ] All async calls use `await`
- [ ] try/catch wraps the entire handler body; catch returns an error string, does not throw
- [ ] 1–3 examples provided that match the actual parameter shape
- [ ] Third-party deps are bundled inside the folder (not referenced externally)
- [ ] README.md present with install steps and usage examples
- [ ] `this.requestToolApproval` used if the skill performs irreversible / high-impact side effects

---

## Directory Structure — Final Layout

```
<STORAGE_DIR>/plugins/agent-skills/<hubId>/   ← folder name === hubId
├── plugin.json      # manifest (required)
├── handler.js       # entry point exporting runtime.handler (required)
├── README.md        # documentation (recommended)
├── package.json     # optional — if bundling deps via yarn install
├── node_modules/    # optional — bundled dependencies
└── *.js             # any additional helper modules required by handler.js
```

For Totem LLM specifically, `<STORAGE_DIR>` defaults to `~/totem-llm/` (override with `TOTEM_STORAGE_DIR`). In Docker it is the volume mounted via `STORAGE_LOCATION`.
