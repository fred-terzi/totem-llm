jest.mock("../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(),
    where: jest.fn(),
  },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    new: jest.fn(),
    where: jest.fn(),
  },
}));

jest.mock("../../models/externalCommunicationConnector", () => ({
  ExternalCommunicationConnector: {
    get: jest.fn(),
    updateConfig: jest.fn(),
  },
}));

const { Workspace } = require("../../models/workspace");
const { WorkspaceThread } = require("../../models/workspaceThread");
const {
  ExternalCommunicationConnector,
} = require("../../models/externalCommunicationConnector");
const {
  handleLink,
} = require("../../utils/telegramBot/utils/commands/handlers/groupManagement");

describe("Telegram group link command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("accepts telegram mention suffix syntax /link@BotName workspace", async () => {
    Workspace.get.mockImplementation(async ({ slug, name }) => {
      if (slug === "totem") {
        return { id: 1, slug: "totem", name: "Totem" };
      }
      if (name === "totem") {
        return { id: 1, slug: "totem", name: "Totem" };
      }
      return null;
    });
    Workspace.where.mockResolvedValue([]);
    WorkspaceThread.new.mockResolvedValue({ thread: { slug: "tg-thread" } });
    ExternalCommunicationConnector.get.mockResolvedValue({
      config: { linked_groups: [] },
    });
    ExternalCommunicationConnector.updateConfig.mockResolvedValue(true);

    const ctx = {
      bot: { sendMessage: jest.fn().mockResolvedValue({}) },
      config: { linked_groups: [] },
      _chatType: new Map([[123, "supergroup"]]),
      setState: jest.fn(),
      log: jest.fn(),
    };

    await handleLink(ctx, 123, "/link@Totem_Official_bot Totem");

    expect(Workspace.get).toHaveBeenCalledWith({ slug: "totem" });
    expect(ctx.config.linked_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: "123",
          workspaceSlug: "totem",
        }),
      ])
    );
    expect(ctx.bot.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Group linked!")
    );
  });
});
