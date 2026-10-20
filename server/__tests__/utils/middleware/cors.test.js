/**
 * Tests for the CORS lockdown applied in server/index.js.
 *
 * The middleware config is extracted into makeCorsHandler() here (mirroring
 * server/index.js — keep in sync) so the origin-decision logic can be
 * unit-tested without booting the whole Express app.
 *
 * The handler is invoked the way Express does: (req, res, next) — asserting
 * on next(err) and the Access-Control-Allow-* headers the cors package
 * writes to the response.
 */
const cors = require("cors");

// Minimal mock response — the cors package calls setHeader/getHeader/END when
// it applies reflected headers / terminates preflights.
function makeRes() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    setHeader: (k, v) => {
      headers[k] = v;
    },
    getHeader: (k) => headers[k],
    end: () => {},
  };
}

// Mirrors server/index.js — keep in sync (extracted here for testability).
function makeCorsHandler(corsOrigins, path = "/api/ping") {
  const isEmbedRoute = path.startsWith("/api/embed/");
  const config = {
    origin: isEmbedRoute
      ? true
      : (origin, callback) => {
          if (!origin) return callback(null, true);
          if (corsOrigins.includes(origin)) return callback(null, true);
          return callback(
            new Error(`CORS: origin ${origin} not allowed`),
            false
          );
        },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  };
  return cors(config);
}

describe("CORS origin allowlist (server/index.js)", () => {
  describe("configured allowlist", () => {
    const handler = makeCorsHandler(["https://beta.totem.xyz"]);

    it("allows a listed origin (next() without error, origin reflected)", (done) => {
      const res = makeRes();
      handler(
        { headers: { origin: "https://beta.totem.xyz" }, method: "GET" },
        res,
        (err) => {
          expect(err).toBeUndefined();
          expect(res.headers["Access-Control-Allow-Origin"]).toBe(
            "https://beta.totem.xyz"
          );
          done();
        }
      );
    });

    it("rejects an unlisted origin with an error via next(err)", (done) => {
      handler(
        {
          headers: { origin: "https://evil.example.com" },
          method: "GET",
        },
        makeRes(),
        (err) => {
          expect(err).toBeInstanceOf(Error);
          expect(err.message).toContain("evil.example.com not allowed");
          done();
        }
      );
    });

    it("allows requests with no Origin header (curl / same-origin)", (done) => {
      handler({ headers: {}, method: "GET" }, makeRes(), (err) => {
        expect(err).toBeUndefined();
        done();
      });
    });

    it("supports multiple comma-separated origins", (done) => {
      const multi = makeCorsHandler([
        "https://beta.totem.xyz",
        "https://app.totem.xyz",
      ]);
      const res = makeRes();
      multi(
        { headers: { origin: "https://app.totem.xyz" }, method: "GET" },
        res,
        (err) => {
          expect(err).toBeUndefined();
          expect(res.headers["Access-Control-Allow-Origin"]).toBe(
            "https://app.totem.xyz"
          );
          done();
        }
      );
    });
  });

  describe("embed widget routes keep public CORS", () => {
    it("reflects any origin on /api/embed/* paths", (done) => {
      const handler = makeCorsHandler([], "/api/embed/abc123/stream-chat");
      const res = makeRes();
      handler(
        {
          headers: { origin: "https://any-customer-site.com" },
          method: "GET",
        },
        res,
        (err) => {
          expect(err).toBeUndefined();
          expect(res.headers["Access-Control-Allow-Origin"]).toBe(
            "https://any-customer-site.com"
          );
          done();
        }
      );
    });
  });
});
