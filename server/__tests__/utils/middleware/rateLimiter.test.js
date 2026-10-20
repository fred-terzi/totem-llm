const {
  rateLimiter,
  resetRateLimiter,
  clientIp,
} = require("../../../utils/middleware/rateLimiter");

/**
 * Tests for the per-IP in-memory rate limiter middleware.
 *
 * The limiter keeps state in a module-level Map; `resetRateLimiter()` clears
 * it between tests. Middleware is invoked directly with mock request/response
 * objects (same pattern as the other endpoint tests) — no real Express app.
 */
describe("rateLimiter middleware", () => {
  let middleware;
  let nextCalls;
  let rejection;

  function mockRequest(ip = "10.0.0.1", headers = {}) {
    return { ip, headers, socket: { remoteAddress: ip } };
  }

  function mockResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  beforeEach(() => {
    resetRateLimiter();
    middleware = rateLimiter();
    nextCalls = 0;
    rejection = null;
  });

  afterEach(() => {
    resetRateLimiter();
  });

  it("allows requests under the limit", async () => {
    for (let i = 0; i < 5; i++) {
      const next = jest.fn(() => nextCalls++);
      await middleware(mockRequest(), mockResponse(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(nextCalls).toBe(5);
  });

  it("blocks requests over the limit with a 429 and a friendly message", async () => {
    const next = jest.fn();
    for (let i = 0; i < 5; i++) {
      await middleware(mockRequest(), mockResponse(), next);
    }
    expect(next).toHaveBeenCalledTimes(5);

    const response = mockResponse();
    await middleware(mockRequest(), response, next);
    expect(response.statusCode).toBe(429);
    expect(response.body).toEqual({
      error: "Too many attempts. Please try again later.",
    });
    expect(next).toHaveBeenCalledTimes(5); // not called on the rejected request
  });

  it("windows expire so a fresh window resets the count", async () => {
    // Tiny window: 50ms
    middleware = rateLimiter({ max: 2, windowMs: 50 });
    const next = jest.fn();

    for (let i = 0; i < 2; i++) {
      await middleware(mockRequest(), mockResponse(), next);
    }
    const response = mockResponse();
    await middleware(mockRequest(), response, next);
    expect(response.statusCode).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const responseAfterExpiry = mockResponse();
    await middleware(mockRequest(), responseAfterExpiry, next);
    expect(responseAfterExpiry.statusCode).toBeNull(); // not rejected
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("tracks IPs independently", async () => {
    const next = jest.fn();
    for (let i = 0; i < 5; i++) {
      await middleware(mockRequest("10.0.0.1"), mockResponse(), next);
    }
    const blocked = mockResponse();
    await middleware(mockRequest("10.0.0.1"), blocked, next);
    expect(blocked.statusCode).toBe(429);

    // A different IP is unaffected.
    const other = mockResponse();
    await middleware(mockRequest("10.0.0.2"), other, next);
    expect(other.statusCode).toBeNull();
    expect(next).toHaveBeenCalledTimes(6);
  });

  it("prefers the first X-Forwarded-For hop when present", async () => {
    expect(
      clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })
    ).toBe("1.2.3.4");
    expect(clientIp({ headers: {}, ip: "9.9.9.9" })).toBe("9.9.9.9");
    expect(clientIp({ headers: {} })).toBe("unknown");
  });

  it("respects a custom message", async () => {
    middleware = rateLimiter({ max: 1, message: "Custom limit message." });
    const next = jest.fn();
    await middleware(mockRequest(), mockResponse(), next);

    const response = mockResponse();
    await middleware(mockRequest(), response, next);
    expect(response.statusCode).toBe(429);
    expect(response.body).toEqual({ error: "Custom limit message." });
  });

  it("env vars configure the defaults (limit)", async () => {
    jest.resetModules();
    process.env.PUBLIC_SIGNUP_RATE_LIMIT = "1";
    delete process.env.PUBLIC_SIGNUP_RATE_WINDOW_MS;
    jest.isolateModules(() => {
      const mod = require("../../../utils/middleware/rateLimiter");
      const next = jest.fn();
      const mw = mod.rateLimiter();
      mw({ ip: "10.1.1.1", headers: {} }, mockResponse(), next);
      const response = mockResponse();
      mw({ ip: "10.1.1.1", headers: {} }, response, next);
      expect(response.statusCode).toBe(429);
    });
    delete process.env.PUBLIC_SIGNUP_RATE_LIMIT;
  });
});
