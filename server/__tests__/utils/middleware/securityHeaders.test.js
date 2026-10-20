/**
 * Tests for the dependency-free security header middleware.
 * (server/utils/middleware/securityHeaders.js)
 */
const securityHeaders = require("../../../utils/middleware/securityHeaders");

function makeRes() {
  const headers = {};
  return {
    headers,
    setHeader: (k, v) => {
      headers[k] = v;
    },
  };
}

describe("securityHeaders middleware", () => {
  it("sets Strict-Transport-Security with includeSubDomains", () => {
    const res = makeRes();
    securityHeaders({}, res, () => {});
    expect(res.headers["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains"
    );
  });

  it("sets X-Content-Type-Options: nosniff", () => {
    const res = makeRes();
    securityHeaders({}, res, () => {});
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("sets Referrer-Policy", () => {
    const res = makeRes();
    securityHeaders({}, res, () => {});
    expect(res.headers["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin"
    );
  });

  it("sets X-Frame-Options: DENY", () => {
    const res = makeRes();
    securityHeaders({}, res, () => {});
    expect(res.headers["X-Frame-Options"]).toBe("DENY");
  });

  it("sets Permissions-Policy disabling interest-cohort", () => {
    const res = makeRes();
    securityHeaders({}, res, () => {});
    expect(res.headers["Permissions-Policy"]).toBe("interest-cohort=()");
  });

  it("calls next() so the request chain continues", () => {
    let called = false;
    securityHeaders({}, makeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
