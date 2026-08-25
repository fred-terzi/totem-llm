const { getMainPath, extractText, parseConversation } = require("../../../utils/chatgptImport/parser");

// Minimal fixture: a conversation with 3 messages (user → assistant → user)
// and one "thoughts" node that should be skipped.
function makeFixture() {
  const rootId = "client-created-root";
  const userMsg1 = "uuid-user-1";
  const thoughtNode = "uuid-thought-1"; // Should be skipped
  const assistantMsg1 = "uuid-assistant-1";
  const userMsg2 = "uuid-user-2";

  return {
    conversation_id: "test-conversation-001",
    id: "test-conversation-001",
    title: "Test Conversation",
    create_time: 1723936394.287, // 2025-08-18T01:53:14Z
    current_node: userMsg2,
    mapping: {
      [rootId]: { id: rootId, parent: null, message: null },
      [userMsg1]: {
        id: userMsg1,
        parent: rootId,
        message: {
          id: userMsg1,
          create_time: 1723936394.0,
          author: { role: "user", name: null },
          content: { content_type: "text", parts: ["Hello, how are you?"] },
        },
      },
      [thoughtNode]: {
        id: thoughtNode,
        parent: userMsg1,
        message: {
          id: thoughtNode,
          create_time: 1723936395.0,
          author: { role: "assistant", name: null },
          content: { content_type: "thoughts", parts: ["Let me think about this..."] },
        },
      },
      [assistantMsg1]: {
        id: assistantMsg1,
        parent: thoughtNode,
        message: {
          id: assistantMsg1,
          create_time: 1723936396.0,
          author: { role: "assistant", name: null },
          content: { content_type: "text", parts: ["I'm doing well! How can I help you?"] },
        },
      },
      [userMsg2]: {
        id: userMsg2,
        parent: assistantMsg1,
        message: {
          id: userMsg2,
          create_time: 1723936400.0,
          author: { role: "user", name: null },
          content: {
            content_type: "multimodal_text",
            parts: [
              "Here's a photo of my laptop ",
              {
                asset_pointer: "file-service://file-abc123",
                content_type: "image_asset_pointer",
                width: 800,
                height: 600,
                size_bytes: 12345,
              },
            ],
          },
        },
      },
    },
  };
}

describe("getMainPath", () => {
  it("walks from current_node to root and returns ordered nodes", () => {
    const conv = makeFixture();
    const path = getMainPath(conv);

    // Should have 3 messages (user1, assistant1, user2) — thought is skipped
    expect(path).toHaveLength(3);

    // Verify order: oldest first
    expect(path[0].id).toBe("uuid-user-1");
    expect(path[1].id).toBe("uuid-assistant-1");
    expect(path[2].id).toBe("uuid-user-2");
  });

  it("skips 'thoughts' content type nodes", () => {
    const conv = makeFixture();
    const path = getMainPath(conv);
    const ids = path.map((n) => n.id);
    expect(ids).not.toContain("uuid-thought-1");
  });

  it("returns empty array for conversation with no current_node", () => {
    const conv = makeFixture();
    conv.current_node = null;
    const path = getMainPath(conv);
    expect(path).toHaveLength(0);
  });

  it("handles missing mapping gracefully", () => {
    const conv = { conversation_id: "x", current_node: "some-node" };
    const path = getMainPath(conv);
    expect(path).toHaveLength(0);
  });
});

describe("extractText", () => {
  it("joins string parts into a single text", () => {
    const msg = makeFixture().mapping["uuid-user-1"].message;
    const result = extractText(msg);
    expect(result.text).toBe("Hello, how are you?");
    expect(result.hasAttachments).toBe(false);
  });

  it("handles multimodal content with image pointers", () => {
    const msg = makeFixture().mapping["uuid-user-2"].message;
    const result = extractText(msg);
    // Should contain the text part and a placeholder for the image
    expect(result.text).toContain("Here's a photo of my laptop");
    expect(result.hasAttachments).toBe(true);
  });

  it("returns empty string for null content", () => {
    const result = extractText({ content: null });
    expect(result.text).toBe("");
    expect(result.hasAttachments).toBe(false);
  });

  it("handles message with no parts array", () => {
    const result = extractText({ content: { content_type: "text" } });
    expect(result.text).toBe("");
  });
});

describe("parseConversation", () => {
  it("returns conversation metadata and ordered messages", () => {
    const conv = makeFixture();
    const parsed = parseConversation(conv);

    expect(parsed.conversationId).toBe("test-conversation-001");
    expect(parsed.title).toBe("Test Conversation");
    expect(parsed.createTime).toEqual(new Date(1723936394.287 * 1000));

    // Should have 3 messages (thoughts skipped)
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].text).toBe("Hello, how are you?");
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[1].text).toBe("I'm doing well! How can I help you?");
    expect(parsed.messages[2].role).toBe("user");
  });

  it("preserves timestamps as Date objects", () => {
    const conv = makeFixture();
    const parsed = parseConversation(conv);

    expect(parsed.messages[0].timestamp).toEqual(new Date(1723936394.0 * 1000));
    expect(parsed.messages[1].timestamp).toEqual(new Date(1723936396.0 * 1000));
  });

  it("handles conversation with null title", () => {
    const conv = makeFixture();
    conv.title = null;
    const parsed = parseConversation(conv);
    expect(parsed.title).toBe(null);
  });

  it("skips non-user/assistant roles", () => {
    const conv = makeFixture();
    // Add a system message that should be skipped
    conv.mapping["uuid-system"] = {
      id: "uuid-system",
      parent: "client-created-root",
      message: {
        id: "uuid-system",
        create_time: 1723936390.0,
        author: { role: "system", name: null },
        content: { content_type: "text", parts: ["You are a helpful assistant."] },
      },
    };
    conv.mapping["uuid-user-1"].parent = "uuid-system";

    const parsed = parseConversation(conv);
    // System message should be skipped — only user and assistant remain
    expect(parsed.messages).toHaveLength(3);
  });
});
