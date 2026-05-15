import { formatToWhatsApp } from "../utils/phone-formatter.js";
import { getReplies } from "../whatsapp/client.js";
import { getActiveNegotiation, getAllNegotiations } from "../store/json-store.js";

export const summarizeNegotiationDefinition = {
  name: "summarize_negotiation",
  description:
    "Get a human-readable summary of a negotiation's progress including conversation history, current round, and key discussion points. Provide a phone number to summarize a specific negotiation, or omit to list all negotiations with brief summaries.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone_number: {
        type: "string",
        description: "Phone number of the negotiation to summarize. Omit to list all negotiations with status.",
      },
    },
    required: [] as string[],
  },
};

export async function summarizeNegotiation(phoneNumber?: string): Promise<string> {
  try {
    // If no phone number, list all
    if (!phoneNumber) {
      const allNegs = getAllNegotiations();
      if (allNegs.length === 0) {
        return JSON.stringify({
          message: "No negotiations found.",
          negotiations: [],
        });
      }

      const summaries = allNegs.map((n) => ({
        phone: n.phone,
        businessName: n.businessName || "Unknown",
        status: n.status,
        rounds: `${n.rounds}/${n.maxRounds}`,
        objective: n.objective.substring(0, 120) + (n.objective.length > 120 ? "..." : ""),
        startedAt: n.startedAt,
        completedAt: n.completedAt || null,
        reason: n.reason || null,
      }));

      return JSON.stringify({
        message: `Found ${allNegs.length} negotiation(s).`,
        negotiations: summaries,
      });
    }

    const rawNumber = formatToWhatsApp(phoneNumber).replace("@c.us", "");
    const key = `${rawNumber}@c.us`;

    const negotiation = getActiveNegotiation(rawNumber) || getActiveNegotiation(key);
    if (!negotiation) {
      // Check if it exists but is not active
      for (const n of getAllNegotiations()) {
        if (n.phone === rawNumber || n.phoneFormatted === key) {
          return JSON.stringify({
            message: `Negotiation with ${rawNumber} is ${n.status} (${n.reason || "no reason given"}).`,
            negotiation: {
              phone: n.phone,
              businessName: n.businessName,
              status: n.status,
              rounds: `${n.rounds}/${n.maxRounds}`,
              objective: n.objective,
              startedAt: n.startedAt,
              completedAt: n.completedAt,
              reason: n.reason,
            },
          });
        }
      }
      return JSON.stringify({
        message: `No negotiation found for ${rawNumber}.`,
        hint: "Use the stop_negotiation tool to list all negotiations.",
      });
    }

    // Get conversation history
    const repliesResult = await getReplies([rawNumber]);

    const conversation: { role: string; content: string; timestamp: string }[] = [];
    const messages = repliesResult.replies[key] || [];

    for (const msg of messages) {
      const isFromUs = msg.body.startsWith("[OUT]");
      conversation.push({
        role: isFromUs ? "assistant" : "user",
        content: msg.body,
        timestamp: msg.timestamp,
      });
    }

    return JSON.stringify({
      businessName: negotiation.businessName || "Unknown",
      phone: negotiation.phone,
      status: negotiation.status,
      rounds: `${negotiation.rounds}/${negotiation.maxRounds}`,
      startedAt: negotiation.startedAt,
      context: negotiation.context,
      objective: negotiation.objective,
      messageCount: conversation.length,
      recentConversation: conversation.slice(-10),
      brief: negotiation.brief,
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Failed to summarize negotiation: ${String(err)}`,
    });
  }
}
