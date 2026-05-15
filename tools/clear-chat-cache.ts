import { clearSidecarCache } from "../whatsapp/client.js";
import { loadStore, saveStore } from "../store/json-store.js";

export const clearChatCacheDefinition = {
  name: "clear_chat_cache",
  description:
    "Clear all stored chat messages, conversation history, and LID caches. Use this if the agent seems stuck, is repeating itself, or the conversation context appears corrupted. Does NOT affect active negotiations unless explicitly requested.",
  inputSchema: {
    type: "object" as const,
    properties: {
      clear_negotiations: {
        type: "boolean",
        description: "Also clear all negotiation data (default false).",
      },
    },
    required: [] as string[],
  },
};

export async function clearChatCache(clearNegotiations = false): Promise<string> {
  try {
    const sidecarResult = await clearSidecarCache();

    // Also clear leads.json negotiation data if requested
    if (clearNegotiations) {
      const store = loadStore();
      store.negotiations = [];
      saveStore(store);
    }

    return JSON.stringify({
      success: true,
      message: clearNegotiations
        ? `Cleared ${sidecarResult.clearedContacts} contact threads, all message logs, LID caches, and all negotiation data.`
        : `Cleared ${sidecarResult.clearedContacts} contact threads, all message logs, and LID caches. Negotiations preserved.`,
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Failed to clear cache: ${String(err)}`,
    });
  }
}
