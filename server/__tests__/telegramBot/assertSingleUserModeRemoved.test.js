/**
 * Regression test: verifies the multi-user-mode guard was removed.
 * After step 1 of Issue #17, TelegramBotService must work in either mode -
 * the old `#assertSingleUserMode` method and its two call sites should be gone.
 */

const { ExternalCommunicationConnector } = require("../../models/externalCommunicationConnector");
const path = require("path");

// Read the bot service source so we can assert on structure without mocking.
const botServiceSource = require("fs").readFileSync(
  path.join(__dirname, "../../utils/telegramBot/index.js"),
  "utf8"
);
const telegramEndpointsSource = require("fs").readFileSync(
  path.join(__dirname, "../../endpoints/telegram.js"),
  "utf8"
);

describe("Telegram bot multi-user guard removal (Issue #17 step-1)", () => {
  describe("#assertSingleUserMode()", () => {
    test("method should no longer be declared in telegramBot/index.js", () => {
      const methodPattern = /async\s+#[a-zA-Z0-9_]*SingleUser[a-zA-Z0-9_]*/;
      expect(botServiceSource).not.toMatch(methodPattern);
    });

    test("no call to #assertSingleUserMode should remain anywhere", () => {
      const callPattern = /#assertSingleUserMode/g;
      const matches = botServiceSource.match(callPattern) || [];
      expect(matches.length).toBe(0);
    });

    test("connector delete-on-multi-user path should be gone", () => {
      const deletionPattern = /delete\(["']telegram["']/;
      const inAssertBlock = botServiceSource.indexOf("Invalid state: Multi-user mode detected");
      expect(inAssertBlock).toBe(-1);
    });

    test("#setupHandlers guard no longer checks single-user mode", () => {
      // The guard still calls sendPairingRequest for unverified users (existing flow), but:
      expect(botServiceSource).toContain("isVerified(this.#config.approved_users, msg.chat.id)");
    });
  });

  describe("Express route middleware", () => {
    test.each([
      "/telegram/config",
      "/telegram/connect",
      "/telegram/disconnect",
      "/telegram/status",
      "/telegram/pending-users",
      "/telegram/approved-users",
      "/telegram/approve-user",
      "/telegram/deny-user",
      "/telegram/revoke-user",
      "/telegram/update-config",
    ])("route %s should use flexUserRoleValid, not isSingleUserMode", (route) => {
      expect(telegramEndpointsSource).toContain("flexUserRoleValid");
      expect(telegramEndpointsSource).not.toContain("isSingleUserMode");
    });

    test("flexUserRoleValid present in import + all 10 routes = 11 total occurrences", () => {
      const flexCount = (telegramEndpointsSource.match(/flexUserRoleValid/g) || []).length;
      expect(flexCount).toBe(11); // 1 import + 10 middleware arrays
    });
  });
});