const fs = require("fs/promises");
const path = require("path");
const { getFilesystemFor } = require("../filesystem/lib.js");
const { STANDARD_MODEL } = require("./pricing.js");

/**
 * Venice Image Generation manager (spec: totem_docs/venice-image-generate/).
 *
 * Handles the Venice-native `POST /api/v1/image/generate` endpoint (F13 — the
 * ONLY endpoint this plugin uses), base64 → Buffer decoding, sanitized filename
 * construction (N5), and binary saves into the invoking user's per-user sandbox
 * (F2) via `getFilesystemFor(userId)` + `validatePath` (N1).
 */
class VeniceImageManager {
  constructor() {
    this.endpoint = "https://api.venice.ai/api/v1/image/generate";
    this.stylesEndpoint = "https://api.venice.ai/api/v1/image/styles";
  }

  /**
   * F5 — the tool is available only when the deployment's Venice API key is set.
   * @returns {boolean}
   */
  isToolAvailable() {
    return !!process.env.VENICE_API_KEY;
  }

  /**
   * Build the Venice request body from caller-supplied tool parameters.
   *
   * Rules enforced here (F1, F9, F13):
   *  - `model` is ALWAYS the standardized constant and can never be overridden.
   *  - `return_binary: false` always (JSON + base64 so the image payload works).
   *  - Only supplied optional parameters are included.
   *  - Sizing-idiom exclusivity: if `aspect_ratio` is present, `width`/`height`
   *    are dropped; if `width`/`height` are present, `aspect_ratio`/`resolution`
   *    are dropped. Never send both idioms.
   *  - The deprecated `inpaint` field is never sent.
 *  - One-image-per-turn lock (F15): the `variants` parameter is stripped from every
 *    request body unconditionally. Multi-image generation is not reachable through
 *    this plugin, even if a caller (or a hallucinating model) passes `variants`.
   * @param {{prompt: string, negative_prompt?: string, width?: number, height?: number,
   *          aspect_ratio?: string, resolution?: string, cfg_scale?: number, steps?: number,
   *          seed?: number, style_preset?: string,
   *          format?: "png"|"jpeg"|"webp", safe_mode?: boolean}} params
   * @returns {object} request body
   */
  buildRequestBody(params = {}) {
    const body = {
      model: STANDARD_MODEL,
      prompt: params.prompt,
      return_binary: false,
      format: params.format || "png",
    };

    if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
    if (params.cfg_scale != null) body.cfg_scale = params.cfg_scale;
    if (params.steps != null) body.steps = params.steps;
    if (params.seed != null) body.seed = params.seed;
    if (params.style_preset) body.style_preset = params.style_preset;

    // Aspect-driven sizing wins over width/height (never both idioms in one body).
    if (params.aspect_ratio) {
      body.aspect_ratio = params.aspect_ratio;
      if (params.resolution) body.resolution = params.resolution;
    } else {
      if (params.width != null) body.width = params.width;
      if (params.height != null) body.height = params.height;
    }

    // One-image-per-turn lock (F15): never send `variants`, regardless of what
    // the caller passed. Every request generates exactly one image.

    if (params.safe_mode != null) body.safe_mode = !!params.safe_mode;

    return body;
  }

  /**
   * Call the Venice image generation endpoint.
   * @param {object} params - tool call parameters
   * @returns {Promise<{images: Buffer[], requestId: string|null}>}
   * @throws {Error} with a human-readable message per F6 error mapping
   */
  async generate(params = {}) {
    const body = this.buildRequestBody(params);

    let response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (networkError) {
      throw new Error(
        `Could not reach the Venice image API: ${networkError.message}`
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(this.mapApiError(response.status, errorText));
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "Venice returned a malformed response (could not decode JSON payload)."
      );
    }

    if (!Array.isArray(data.images) || data.images.length === 0) {
      throw new Error("Venice returned no images for this request.");
    }

    const images = data.images.map((b64) => Buffer.from(b64, "base64"));
    return { images, requestId: data.id || null };
  }

  /**
   * F6 — map Venice API error codes to human-readable messages.
   * Content-policy violations arrive as 400 with an API error string — surface it verbatim.
   * @param {number} status
   * @param {string} [body]
   * @returns {string}
   */
  mapApiError(status, body = "") {
    let apiMessage = "";
    try {
      const parsed = JSON.parse(body);
      apiMessage =
        parsed?.error?.message || parsed?.error || parsed?.message || "";
      if (typeof apiMessage !== "string")
        apiMessage = JSON.stringify(apiMessage);
    } catch {
      apiMessage = body.slice(0, 300);
    }

    switch (status) {
      case 400:
        return apiMessage
          ? `Venice rejected the request: ${apiMessage}`
          : "Venice rejected the request (bad parameters or content policy).";
      case 401:
        return "Venice API authentication failed. Check the VENICE_API_KEY configuration.";
      case 402:
        return "Insufficient Venice API balance. The deployment operator needs to top up the Venice account.";
      case 415:
        return "Venice rejected the request format.";
      case 429:
        return "Venice image generation is rate limited. Please retry shortly.";
      case 500:
      case 503:
        return "Venice image generation is temporarily unavailable (capacity). Please retry shortly.";
      default:
        return `Venice image generation failed (${status}).${apiMessage ? ` ${apiMessage}` : ""}`;
    }
  }

  /**
   * F7 — fetch style preset names from GET /image/styles.
   * @returns {Promise<string[]>} style preset names
   * @throws {Error} with a human-readable message per F6
   */
  async listStyles() {
    let response;
    try {
      response = await fetch(this.stylesEndpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.VENICE_API_KEY}` },
      });
    } catch (networkError) {
      throw new Error(
        `Could not reach the Venice styles API: ${networkError.message}`
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(this.mapApiError(response.status, errorText));
    }

    const data = await response.json();
    return (data?.styles || [])
      .map((s) => s?.name)
      .filter((name) => typeof name === "string" && name.length > 0);
  }

  /**
   * N5 — sanitize a prompt into a filename-safe slug.
   * Lowercase, strips non-ASCII and unsafe characters, truncated to 48 chars.
   * @param {string} prompt
   * @returns {string}
   */
  sanitizeSlug(prompt) {
    return String(prompt || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
  }

  /**
   * Build the sandbox-relative filename: images/<timestamp>-<slug>[-<n>].<ext>
   * @param {{prompt: string, format?: string, variantIndex?: number|null}} options
   * @returns {{relativePath: string, displayFilename: string}}
   */
  buildFilename({ prompt, format = "png", variantIndex = null }) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15); // YYYYMMDD-HHMMSS
    const slug = this.sanitizeSlug(prompt) || "image";
    const suffix = variantIndex != null ? `-${variantIndex}` : "";
    const filename = `${timestamp}-${slug}${suffix}.${format}`;
    return {
      relativePath: path.posix.join("images", filename),
      displayFilename: filename,
    };
  }

  /**
   * F2 — save one image Buffer into the invoking user's sandbox under images/.
   * Every write passes the sandbox `validatePath` gate (N1, AC9); the sandbox
   * root is resolved from the session's own userId — never a caller parameter.
   * @param {{userId: number|null, buffer: Buffer, relativePath: string}} options
   * @returns {Promise<{absolutePath: string, relativePath: string}>}
   */
  async saveToSandbox({ userId, buffer, relativePath }) {
    const filesystem = getFilesystemFor(userId);

    // validatePath's ENOENT branch requires the parent directory to already
    // exist, so create images/ lazily (recursive) on first save, then validate.
    const imagesDir = await filesystem.validatePath("images");
    await fs.mkdir(imagesDir, { recursive: true });

    const validated = await filesystem.validatePath(relativePath);
    await fs.writeFile(validated, buffer);
    return { absolutePath: validated, relativePath };
  }
}

module.exports = {
  VeniceImageManager,
  veniceImageManager: new VeniceImageManager(),
};
