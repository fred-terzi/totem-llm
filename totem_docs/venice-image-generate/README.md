# Venice Image Generation Skill

**Status:** 🔲 Planned (spec drafted, plan Step 0 complete, implementation not started)
**Spec:** [requirement-spec.md](requirement-spec.md) · **Plan:** [implementation-plan.md](implementation-plan.md)

## What it does

An agent skill (`venice-image-generate`) that generates images from a text prompt using the Venice AI image API and saves them where the user can actually see them:

| Mode | Image save location |
|------|--------------------|
| Multi-user | `$STORAGE_DIR/totemllm-fs/users/<userId>/images/<timestamp>-<prompt-slug>.<fmt>` |
| Single-user (`userId == null`) | `$STORAGE_DIR/totemllm-fs/images/<timestamp>-<prompt-slug>.<fmt>` |

Every generated image appears in **two places at once**: an `images/` folder inside the user's per-user sandbox (visible in the File Explorer and to all filesystem preview tools) and a download card in the chat.

| Behavior | No `VENICE_API_KEY` | Key set + skill enabled |
|----------|--------------------|-------------------------|
| `generate-image` | Standard "disabled, not set up" message; no request | Two-step flow: refined prompt + credit quote → user confirms → approval card with **"Always allow" checkbox** → generates, saves to sandbox, emits download card; multi-user: balance pre-flight + debit on success. Checking "Always allow" opts the user into auto-generation: the card is skipped from then on, while the conversational refine-and-confirm and billing still apply. |
| `list-image-styles` | Standard "disabled" message | Returns Venice style preset names as JSON |

## How it works

The conversation is a two-step contract: **refine and confirm first, generate second.**

```
Turn 1 — "generate an image of a lighthouse at dusk"
   │
   ▼
Agent refines the idea into a detailed image prompt
(subject, style, composition, lighting, aspect ratio)
and presents it WITH the exact credit cost from pricing.quote()
   │
   ▼
User confirms (or asks for changes — loop back, still no tool call)

Turn 2 — confirmed
   │
   ▼
Agent calls generate-image with the confirmed refined prompt
   │  parameters: prompt, width/height or aspect_ratio+resolution,
   │  negative_prompt, style_preset, seed, variants, format, safe_mode
   │  (no model parameter — the model is fixed in pricing.js)
   ▼
venice-image plugin (server, CJS)
   │  1. availability check  → VENICE_API_KEY must be set
   │  2. quote               → pricing.quote(params) — one number, one source
   │  3. approval gate       → requestToolApproval ("venice-image-generate"):
   │     approval card in chat shows the refined prompt, the credit cost,
   │     and Approve/Reject + an "Always allow" checkbox; 2-min timeout = reject.
   │     "Always allow" = the user's explicit opt-in to auto-generation:
   │     the skill is added to their whitelist and the card is skipped
   │     from then on — but the conversational refine-and-confirm (F11)
   │     and billing (F14) still apply. Rejection/timeout → no API call,
   │     no debit.
   │  4. multi-user pre-flight → Credits.hasCredits(userId, quote);
   │     insufficient → readable message, NO API call, NO debit
   │  5. build request body  → model: z-image-turbo (constant),
   │                          only supplied params, return_binary: false
   ▼
POST https://api.venice.ai/api/v1/image/generate   (Bearer VENICE_API_KEY)
   │
   ▼
Response { images: [base64, …], id }
   │  per image:
   │  6. decode base64 → Buffer
   │  7. getFilesystemFor(handlerProps.userId)   ← per-user sandbox identity
   │  8. validatePath("images/<file>")           ← sandbox enforcement
   │  9. fs.writeFile(validatedPath, buffer)
   │  10. multi-user: Credits.debit(userId, quote, "venice-image-generate:<id>")
   │      — once, after successful save; failures never debit
   │  11. socket.send("fileDownloadCard", …) + registerOutput("ImageDownload", …)
   ▼
User sees the image in chat (download card) AND in their sandbox images/ folder,
plus the debited credit amount in the tool result (multi-user)
```

**Two confirmation layers:** the conversational refine-and-confirm (Turn 1, instruction-level) plus the hard approval card from the tool-approval gate (Step 3 above). Both carry the same prompt and the same quote — the user sees what they are buying twice before anything is spent. **Opting into auto-generation:** the card's "Always allow" checkbox whitelists the skill for that user, after which the card is skipped and the model can auto-generate on a confirmed request. Even then, the agent still presents the refined prompt + credit quote in conversation before every generation (F11) and billing still runs (F14) — "Always allow" removes the card, never the conversation. Users can opt back out by removing the skill from their whitelist in the admin panel, which restores the card on every generation.

**Cost model:** one standardized endpoint + model (`/image/generate`, `z-image-turbo`) means the per-image cost is a flat constant. Quote and debit both read the same `pricing.js` value — they cannot diverge. Future operations with variable cost (image editing tiers, video by length) plug into `pricing.js`'s per-operation `costFor(params)` schema without changing the tools or this confirmation flow.

Error mapping: 402 → insufficient balance, 429 → rate limit, 400 → API message verbatim (content-policy arrives here), 401 → auth, 5xx → retry suggestion. Nothing throws unhandled; every failure reaches the user as a readable tool result.

## Directory / data layout

New on-disk layout (created lazily on first generation):

```
$STORAGE_DIR/totemllm-fs/
├── images/                          # single-user mode (userId == null)
│   └── 20261020-090512-lighthouse-at-dusk.png
└── users/
    └── <userId>/
        └── images/                  # multi-user mode — one per user
            └── 20261020-090512-lighthouse-at-dusk.png
```

Filename scheme: `<YYYYMMDD>-<HHmmss>-<sanitized prompt slug>[-<variant n>].<png|jpeg|webp>`. Timestamp prefix guarantees uniqueness; the slug is sanitized (traversal, unicode, and control characters stripped); variant suffixes when `variants > 1`.

New code (planned):

```
server/utils/agents/aibitat/plugins/venice-image/
├── index.js    # plugin object: generate-image + list-image-styles tools
├── lib.js      # VeniceImageManager: request build, error map, sandbox save
└── pricing.js  # STANDARD_MODEL, COST_PER_IMAGE, quote(params), operations map
```

No schema changes (the debit writes to the existing `credit_transactions` table via `server/models/credits.js`). No new env vars. Reuses the existing `VENICE_API_KEY`.

## Migration / runbook

None needed.

| Timeline | Who can access what |
|----------|--------------------|
| Before | No image generation exists |
| After enable (admin whitelists the skill) | Whitelisted users/workspaces can generate; images land in their own sandbox `images/` folder — readable only by that user's session (sandbox isolation unchanged) |
| Single-user installs | Images land in the shared sandbox root `images/` — same access picture as all other sandbox files |

Cost note for operators:

- **Multi-user mode:** image generation is a **billed feature**. The user is quoted a flat credit cost before generation (refine-and-confirm flow), sees an approval card unless the skill is whitelisted (F10), and their Totem credit balance is debited once per successful generation (per-image cost × variants). Insufficient balance or a rejected/timed-out approval card → no API call, no charge. The operator's Venice balance is consumed 1:1 behind the scenes; margin between Totem credits and Venice USD is set by `COST_PER_IMAGE` in `pricing.js`.
- **Single-user mode:** nothing is debited — the operator's Venice balance is the meter. The quote is still shown so the operator knows the cost of each generation.
- **Future-proofing:** pricing lives in one module keyed by operation. When editing/video land, their size- and duration-dependent costs register as new operations in `pricing.js` — the quote → confirm → generate → debit flow is unchanged, only the cost function differs.

## Tests

`server/__tests__/utils/agents/aibitat/plugins/venice-image.test.js` — run with:

```bash
npx jest server/__tests__/utils/agents/aibitat/plugins/venice-image.test.js
```

Covers: request-body shape (sizing-idiom exclusivity, no deprecated fields, no model parameter), filename sanitization, per-user sandbox save + isolation, API error mapping, disabled-without-key, variants fan-out, approval gate (ordering, payload, rejection/timeout short-circuit, auto-approve path), pricing quote, billing flow (pre-flight no-fetch/no-debit, success debit with request-id reference, failure no-debit, single-user no-billing), and the refine-and-confirm tool-description contract. Manual E2E checklist lives in the plan's Step 5.

## Related workstreams

| Workstream | Status | Relationship |
|------------|--------|--------------|
| [Per-user filesystem](../per-user-filesystem/) | ✅ Done | Provides `getFilesystemFor(userId)` — the sandbox our images are saved into |
| [File Explorer & Viewer](../file-explorer/) | ✅ Done | Renders image previews for the `images/` folder; hosts the download path for sandbox files |
| [Default-user inference options](../default-user-inference-options/) | 🚧 In progress | Shares the `VENICE_API_KEY` provider plumbing; no code dependency |
| `venice-image-edit` (edit/upscale/style-references) | 🔲 Future | Natural follow-up skill using the same plugin + sandbox-save skeleton; registers size-tiered costs in `pricing.js` |
| Video generation (`venice-video`) | 🔲 Future | Same quote → confirm → debit flow; duration-dependent cost function in `pricing.js` |
| Totem-side credit metering for image generation | ✅ Included in this workstream (multi-user) | Closes the "spend abuse" residual risk from the spec's threat model |
