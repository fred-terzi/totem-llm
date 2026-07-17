const { isDirectingToBot } = require("../../utils/telegramBot/utils/verification");

describe("Telegram group mention detection", () => {
  test("does not treat arbitrary mentions as a bot mention when the bot username is unknown", () => {
    const msg = {
      text: "@Neo10101 do you know what they are talking about in the admin group chat for a",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: 10,
        },
      ],
    };

    expect(isDirectingToBot(msg, "")).toBe(false);
  });

  test("matches the configured Telegram bot username exactly", () => {
    const msg = {
      text: "@Totem_Official_bot create a high level summary for a non-tech crowd of https://",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: 18,
        },
      ],
    };

    expect(isDirectingToBot(msg, "Totem_Official_bot")).toBe(true);
  });
});
