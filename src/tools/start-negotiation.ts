import { startNegotiation as startNeg, sendMessage } from "../whatsapp/client.js";
import { formatToWhatsApp } from "../utils/phone-formatter.js";
import { addMessage } from "../store/json-store.js";
import { generateBrief } from "../whatsapp/auto-responder.js";

export const startNegotiationDefinition = {
  name: "start_negotiation",
  description:
    "Start a fully autonomous negotiation with a business via WhatsApp. The AI will send an initial message and then automatically respond to all replies from the business using DeepSeek AI, negotiating toward the specified objective. The negotiation runs autonomously until a deal is reached, rejected, or the max rounds (default 15) are hit. Use find_local_business first to discover businesses, then start negotiations with them.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone_number: {
        type: "string",
        description: "Phone number in international format (e.g. '+58 416 9198603')",
      },
      business_name: {
        type: "string",
        description: "Name of the business (optional, helps the AI be more personal)",
      },
      context: {
        type: "string",
        description:
          "What you need — describe the event/order in detail. E.g. 'Catering for 80 person corporate launch party in Caracas, May 24. Need pasapalos, drinks, and desserts.'",
      },
      objective: {
        type: "string",
        description:
          "Your negotiation goal. E.g. 'Get best price under $8000, must include setup and 2 waiters, prefer all-inclusive deal'",
      },
      initial_message: {
        type: "string",
        description:
          "The first message to send to the business. If not provided, a default procurement inquiry will be sent.",
      },
      max_rounds: {
        type: "number",
        description: "Maximum back-and-forth exchanges before auto-stopping (default 15)",
      },
    },
    required: ["phone_number", "context", "objective"],
  },
};

export async function startNegotiation(
  phoneNumber: string,
  context: string,
  objective: string,
  businessName?: string,
  initialMessage?: string,
  maxRounds = 15
): Promise<string> {
  const formatted = formatToWhatsApp(phoneNumber);
  const rawNumber = formatted.replace("@c.us", "");

  // Default initial message if none provided
  const firstMessage =
    initialMessage ||
    `Hola! Estamos buscando un proveedor para lo siguiente: ${context}. ¿Trabajan con este tipo de pedidos? ¿Cuál sería su cotización?`;

  try {
    // 0. Generate the negotiation brief (immutable rules for the AI)
    const brief = await generateBrief(context, objective);

    // 1. Register the negotiation with the sidecar
    const negResult = await startNeg({
      phone: rawNumber,
      phoneFormatted: formatted,
      businessName,
      context,
      objective,
      brief,
      maxRounds,
    });

    // 2. Send the initial message
    await sendMessage(formatted, firstMessage);

    // 3. Log to store
    addMessage(formatted, {
      direction: "outbound",
      body: firstMessage,
      timestamp: new Date().toISOString(),
    });

    return JSON.stringify({
      success: true,
      message: `Autonomous negotiation started with ${businessName || rawNumber}. The AI will now handle all responses automatically.`,
      negotiation: {
        phone: rawNumber,
        businessName,
        context,
        objective,
        maxRounds,
        status: "active",
      },
      initialMessageSent: firstMessage,
      note: "The sidecar will auto-respond to all incoming messages from this number using DeepSeek AI until the deal is closed, rejected, or max rounds are reached.",
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Failed to start negotiation: ${String(err)}`,
      hint: "Make sure the WhatsApp sidecar is running and connected, and DEEPSEEK_API_KEY is set.",
    });
  }
}
