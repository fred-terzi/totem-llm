const { veniceImageManager } = require("./lib.js");
const pricing = require("./pricing.js");
const { Credits } = require("../../../../../models/credits");
const { User } = require("../../../../../models/user");
const { ROLES } = require("../../../../../utils/middleware/multiUserProtected");
// NOTE on require depths from plugins/venice-image/ (5 levels up = server/):
//   ../../../../../models/*  → server/models/*
//   ../../../../../utils/*   → server/utils/*

const SKILL_NAME = "venice-image-generate";

// Tool-description refine-and-confirm mandate (F11). This conversational contract
// applies to EVERY user — including users who opted into auto-generation via the
// approval card's "Always allow" checkbox: that option removes the approval CARD,
// never the conversation.
const REFINE_AND_CONFIRM_MANDATE =
  "IMPORTANT — refine and confirm before generating: Before calling this tool you MUST " +
  "(1) refine the user's idea into a detailed image prompt covering subject, style, " +
  "composition, lighting, and aspect ratio; (2) present that refined prompt to the user " +
  "along with the exact credit cost of the generation (state the number of credits; ask " +
  "the tool handler for nothing — the cost is " +
  pricing.COST_PER_IMAGE +
  " credits per image); and (3) wait for the user's explicit confirmation. NEVER call this tool in " +
  "the same turn the idea is first proposed. ONE IMAGE PER TURN: always generate exactly " +
  "one image per call, and never call this tool more than once in a single turn. If the " +
  "user asks for multiple variations, generate one image and offer to iterate on it — do " +
  "not batch or fan out generations. This refine-and-confirm contract applies to " +
  "EVERY user, including users who have enabled auto-generation via the approval card's " +
  "'Always allow' option — that option removes the approval card, not this conversation. " +
  "Pass the user-confirmed refined prompt as the `prompt` parameter.";

// Sub-plugin convention (mirrors filesystem-agent): the parent skill's `plugin`
// is an ARRAY of child plugin defs. `agentSkillsFromSystemSettings()` then emits
// `venice-image-generate#generate-image` / `venice-image-generate#list-image-styles`,
// which aibitat's #parseFunctionName resolves to the registered tool names. A bare
// `plugin: function()` makes the agent look up the skill name itself in the
// function map (`venice-image-generate`) and silently drop both tools from the LLM's
// tool list — the plugin attaches but the model never sees it.
const generateImageTool = {
  name: "generate-image",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Generate an image from a text prompt using Venice AI and save it to the user's " +
            "files. The user can view and download the image from the File Explorer and a " +
            "download card in this chat. Supports negative prompts, dimensions or aspect " +
            "ratio, style presets, and seeds. Generates exactly ONE image per call — there " +
            "is no variants or multi-image option. Images are always generated " +
            "with the Venice AI image model 'z-image-turbo'; model selection is not " +
            "available — if the user asks which image models are available, tell them this " +
            "tool uses z-image-turbo exclusively. " +
            REFINE_AND_CONFIRM_MANDATE,
          examples: [
            {
              prompt: "Generate an image of a lighthouse at dusk, 16:9", // after the user confirmed the refined prompt
              call: JSON.stringify({
                prompt:
                  "A weathered lighthouse on a rocky promontory at dusk, warm lamp glow against a deep blue sky, cinematic composition, waves crashing below, 16:9 aspect ratio",
                aspect_ratio: "16:9",
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "The final refined image prompt that was presented to and confirmed by the user (F11). Max 7500 characters.",
              },
              negative_prompt: {
                type: "string",
                description: "What NOT to show in the image.",
              },
              width: {
                type: "integer",
                description:
                  "Image width in pixels (default 1024, max 1280, divisible by 8). Ignored when aspect_ratio is set.",
              },
              height: {
                type: "integer",
                description:
                  "Image height in pixels (default 1024, max 1280, divisible by 8). Ignored when aspect_ratio is set.",
              },
              aspect_ratio: {
                type: "string",
                description:
                  'Aspect ratio instead of width/height, e.g. "1:1", "16:9", "9:16".',
              },
              resolution: {
                type: "string",
                description: 'Only with aspect_ratio: "1K", "2K", or "4K".',
              },
              cfg_scale: {
                type: "number",
                description:
                  "How strictly the model follows the prompt (0 < x <= 20).",
              },
              steps: { type: "integer", description: "Inference steps." },
              seed: {
                type: "integer",
                description: "Seed for reproducible results.",
              },
              style_preset: {
                type: "string",
                description:
                  "A style preset name. Discover valid values with the list-image-styles tool.",
              },
              format: {
                type: "string",
                enum: ["png", "jpeg", "webp"],
                description: "Output image format. Default png.",
              },
              safe_mode: {
                type: "boolean",
                description: "Blur adult content. Default true.",
              },
            },
            required: ["prompt"],
            additionalProperties: false,
          },
          handler: async function (params) {
            try {
              const userId = this.super.handlerProps?.userId ?? null;

              // F5 — availability gate.
              if (!veniceImageManager.isToolAvailable()) {
                this.super.introspect(
                  `${this.caller}: I can't generate images because VENICE_API_KEY is not configured on this deployment.`
                );
                return "Image generation is disabled and no image was created. This functionality is disabled because the user has not set it up yet.";
              }

              // One-image-per-turn lock: variants are not exposed to the model and
              // are stripped in buildRequestBody, so the quote is always flat.
              // quote → customer-facing CREDITS (tool description, approval card,
              // user messages); µ$ → internal billing for hasCredits/debit.
              const quote = pricing.quote(params);
              const quoteMicro = pricing.COST_PER_IMAGE_MICRO;

              // F10 — hard confirmation via the existing tool-approval gate.
              // Runs BEFORE pre-flight so the user sees the card (prompt + exact cost)
              // before any internal balance error. For users who clicked "Always allow"
              // (or env auto-approve) the gate resolves approved immediately and silently.
              if (this.super.requestToolApproval) {
                const approval = await this.super.requestToolApproval({
                  skillName: SKILL_NAME,
                  payload: {
                    prompt: params.prompt,
                    credit_quote: quote,
                    variants: 1,
                    width: params.width ?? null,
                    height: params.height ?? null,
                    aspect_ratio: params.aspect_ratio ?? null,
                    resolution: params.resolution ?? null,
                    style_preset: params.style_preset ?? null,
                    seed: params.seed ?? null,
                  },
                  description: `Generate an image via Venice AI — costs ${quote} credits (one image)`,
                });
                if (!approval.approved) {
                  this.super.introspect(
                    `${this.caller}: User rejected or timed out on the ${SKILL_NAME} request.`
                  );
                  return approval.message;
                }
              }

              // F14a — multi-user pre-flight balance check. No API call on failure.
              // Admins are billing-exempt, matching the chat-endpoint credit-gate convention.
              const isBillingExempt =
                userId != null &&
                (await User.get({ id: userId }))?.role === ROLES.admin;
              if (userId != null && !isBillingExempt) {
                const canAfford = await Credits.hasCredits(userId, quoteMicro);
                if (!canAfford) {
                  this.super.introspect(
                    `${this.caller}: User has insufficient credits for image generation (needs ${quote}).`
                  );
                  return `Insufficient credits: this image generation costs ${quote} credits (one image at ${pricing.COST_PER_IMAGE} credits), but your balance is too low. No credits were charged.`;
                }
              }

              this.super.introspect(
                `${this.caller}: Generating image with Venice AI (${pricing.STANDARD_MODEL})...`
              );

              // F6 — generate; failures here debit nothing (AC13).
              let result;
              try {
                result = await veniceImageManager.generate(params);
              } catch (genError) {
                this.super.handlerProps.log(
                  `venice-image-generate error: ${genError.message}`
                );
                return `Image generation failed: ${genError.message} No credits were charged.`;
              }

              // F2/F9 — decode + save each variant into the user's sandbox.
              const saved = [];
              try {
                for (let i = 0; i < result.images.length; i++) {
                  const variantIndex = result.images.length > 1 ? i + 1 : null;
                  const { relativePath, displayFilename } =
                    veniceImageManager.buildFilename({
                      prompt: params.prompt,
                      format: params.format || "png",
                      variantIndex,
                    });
                  const { absolutePath } =
                    await veniceImageManager.saveToSandbox({
                      userId,
                      buffer: result.images[i],
                      relativePath,
                    });
                  saved.push({
                    displayFilename,
                    relativePath,
                    absolutePath,
                    fileSize: result.images[i].length,
                  });
                }
              } catch (saveError) {
                this.super.handlerProps.log(
                  `venice-image-generate save error: ${saveError.message}`
                );
                return `Image was generated but could not be saved: ${saveError.message} No credits were charged.`;
              }

              // F14b — multi-user debit on success only (admins exempt).
              let debitNote = "";
              if (userId != null && !isBillingExempt) {
                const debit = await Credits.debit(
                  userId,
                  quoteMicro,
                  `venice-image-generate:${result.requestId ?? "unknown"}`
                );
                debitNote = ` ${pricing.COST_PER_IMAGE} credits were debited (remaining balance: ${debit.newBalance}).`;
              }

              // F3 — download card per saved image (sandbox file; served via the
              // File Explorer's /filesystem/read raw endpoint — see Step 2).
              for (const file of saved) {
                this.super.socket.send("fileDownloadCard", {
                  filename: file.displayFilename,
                  storageFilename: file.relativePath,
                  fileSize: file.fileSize,
                  sandboxFile: true,
                });
                this.super.registerOutput?.(
                  "ImageDownload",
                  {
                    filename: file.displayFilename,
                    storageFilename: file.relativePath,
                    fileSize: file.fileSize,
                    sandboxFile: true,
                  },
                  SKILL_NAME
                );
              }

              this.super.introspect(
                `${this.caller}: Successfully generated ${saved.length} image(s).`
              );

              const fileList = saved
                .map((f) => `"${f.displayFilename}"`)
                .join(", ");
              return `Successfully generated ${saved.length} image(s): ${fileList}. Saved to the user's images folder.${debitNote}`;
            } catch (e) {
              this.super.handlerProps.log(
                `venice-image-generate error: ${e.message}`
              );
              this.super.introspect(`Error: ${e.message}`);
              return `Error generating image: ${e.message}`;
            }
          },
        });
      },
    };
  },
};

const listImageStylesTool = {
  name: "list-image-styles",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "List the available Venice AI image style presets. Use this to discover valid " +
            "values for the style_preset parameter of the generate-image tool.",
          examples: [
            {
              prompt: "What image styles are available?",
              call: JSON.stringify({}),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          handler: async function () {
            try {
              if (!veniceImageManager.isToolAvailable()) {
                return "Image generation is disabled because VENICE_API_KEY is not set on this deployment.";
              }
              this.super.introspect(
                `${this.caller}: Fetching Venice AI image style presets...`
              );
              const styles = await veniceImageManager.listStyles();
              return JSON.stringify({ styles });
            } catch (e) {
              this.super.handlerProps.log(
                `list-image-styles error: ${e.message}`
              );
              return `Error listing image styles: ${e.message}`;
            }
          },
        });
      },
    };
  },
};

const veniceImage = {
  name: SKILL_NAME,
  startupConfig: {
    params: {},
  },
  plugin: [generateImageTool, listImageStylesTool],
};

module.exports = { veniceImage };
