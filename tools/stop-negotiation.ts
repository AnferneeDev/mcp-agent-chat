import { stopNegotiation as stopNeg, listNegotiations } from "../whatsapp/client.js";
import { formatToWhatsApp } from "../utils/phone-formatter.js";

export const stopNegotiationDefinition = {
  name: "stop_negotiation",
  description:
    "Stop an active autonomous negotiation. The AI will stop auto-responding to messages from this business. Can also list all negotiations and their statuses.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone_number: {
        type: "string",
        description:
          "Phone number of the business to stop negotiating with. If not provided, lists all negotiations.",
      },
    },
    required: [] as string[],
  },
};

export async function stopNegotiation(phoneNumber?: string): Promise<string> {
  try {
    // If no phone number, list all negotiations
    if (!phoneNumber) {
      const result = await listNegotiations();
      return JSON.stringify({
        message: `Found ${result.negotiations.length} negotiation(s).`,
        negotiations: result.negotiations,
      });
    }

    const rawNumber = formatToWhatsApp(phoneNumber).replace("@c.us", "");

    const result = await stopNeg(rawNumber);

    return JSON.stringify({
      success: true,
      message: `Negotiation with ${rawNumber} has been stopped. The AI will no longer auto-respond to messages from this number.`,
      negotiation: result.negotiation,
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Failed to stop negotiation: ${String(err)}`,
    });
  }
}
