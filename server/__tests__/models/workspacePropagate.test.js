const { Workspace } = require("../../models/workspace");
const { SystemSettings } = require("../../models/systemSettings");

// Unit tests for Workspace.propagateDefaultSystemPrompt — no DB required.
// The Prisma client and EventLogs are mocked; these pin the filter logic so
// regressions that clobber customized workspaces are caught.

jest.mock("../../utils/prisma", () => ({
  workspaces: {
    updateMany: jest.fn(),
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: jest.fn().mockResolvedValue(true),
  },
}));

const prisma = require("../../utils/prisma");
const { EventLogs } = require("../../models/eventLogs");

describe("Workspace.propagateDefaultSystemPrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.workspaces.updateMany.mockResolvedValue({ count: 3 });
  });

  it("targets only blank/null workspaces and those on the previous default", async () => {
    const previousDefault = "You are a helpful assistant.";
    await Workspace.propagateDefaultSystemPrompt(
      "New default prompt",
      { id: 1 },
      previousDefault
    );

    expect(prisma.workspaces.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.workspaces.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      OR: [
        { openAiPrompt: null },
        { openAiPrompt: "" },
        { openAiPrompt: previousDefault },
      ],
    });
    expect(call.data.openAiPrompt).toBe("New default prompt");
    expect(call.data.lastUpdatedAt).toBeInstanceOf(Date);
  });

  it("never matches an unfiltered where clause (custom workspaces are safe)", async () => {
    await Workspace.propagateDefaultSystemPrompt("New", { id: 1 }, "Old");
    const call = prisma.workspaces.updateMany.mock.calls[0][0];
    expect(call.where).toBeDefined();
    // A customized prompt must not appear anywhere in the match set.
    const matched = JSON.stringify(call.where);
    expect(matched).not.toContain("A totally custom workspace prompt");
  });

  it("falls back to the sane default when the new prompt is empty/whitespace", async () => {
    for (const empty of [null, undefined, "", "   "]) {
      jest.clearAllMocks();
      prisma.workspaces.updateMany.mockResolvedValue({ count: 0 });
      await Workspace.propagateDefaultSystemPrompt(empty, { id: 1 }, "Old");
      const call = prisma.workspaces.updateMany.mock.calls[0][0];
      expect(call.data.openAiPrompt).toBe(SystemSettings.saneDefaultSystemPrompt);
    }
  });

  it("treats a null/empty previousPrompt as the sane default when filtering", async () => {
    for (const emptyPrevious of [null, undefined, ""]) {
      jest.clearAllMocks();
      prisma.workspaces.updateMany.mockResolvedValue({ count: 0 });
      await Workspace.propagateDefaultSystemPrompt("New", { id: 1 }, emptyPrevious);
      const call = prisma.workspaces.updateMany.mock.calls[0][0];
      expect(call.where.OR).toEqual(
        expect.arrayContaining([
          { openAiPrompt: SystemSettings.saneDefaultSystemPrompt },
        ])
      );
    }
  });

  it("trims the new prompt before storing it", async () => {
    await Workspace.propagateDefaultSystemPrompt("  Padded prompt  ", { id: 1 }, "Old");
    const call = prisma.workspaces.updateMany.mock.calls[0][0];
    expect(call.data.openAiPrompt).toBe("Padded prompt");
  });

  it("returns the updated count with no error on success", async () => {
    const result = await Workspace.propagateDefaultSystemPrompt("New", { id: 1 }, "Old");
    expect(result).toEqual({ updatedWorkspaces: 3, error: null });
  });

  it("logs the event with promptLength only (no full prompt text in audit log)", async () => {
    const prompt = "A".repeat(500);
    await Workspace.propagateDefaultSystemPrompt(prompt, { id: 7 }, "Old");

    expect(EventLogs.logEvent).toHaveBeenCalledTimes(1);
    const [eventType, metadata, userId] = EventLogs.logEvent.mock.calls[0];
    expect(eventType).toBe("default_system_prompt_propagated");
    expect(metadata).toEqual({ updatedWorkspaces: 3, promptLength: 500 });
    expect(JSON.stringify(metadata)).not.toContain(prompt);
    expect(userId).toBe(7);
  });

  it("logs with a null user id when no admin is resolvable", async () => {
    await Workspace.propagateDefaultSystemPrompt("New", null, "Old");
    const [, , userId] = EventLogs.logEvent.mock.calls[0];
    expect(userId).toBeNull();
  });

  it("returns an error (and count 0) when the DB write fails, without throwing", async () => {
    prisma.workspaces.updateMany.mockRejectedValue(new Error("db down"));
    const result = await Workspace.propagateDefaultSystemPrompt("New", { id: 1 }, "Old");
    expect(result).toEqual({ updatedWorkspaces: 0, error: "db down" });
  });

  it("still returns a count if the event log write itself fails", async () => {
    EventLogs.logEvent.mockRejectedValue(new Error("log write failed"));
    const result = await Workspace.propagateDefaultSystemPrompt("New", { id: 1 }, "Old");
    expect(result).toEqual({ updatedWorkspaces: 3, error: null });
  });
});
