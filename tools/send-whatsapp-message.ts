import { sendMessage } from "../whatsapp/client.js";
import { addMessage, getLeadByPhone } from "../store/json-store.js";
import { formatToWhatsApp } from "../utils/phone-formatter.js";

export const sendWhatsappMessageDefinition = {
  name: "send_whatsapp_message",
  description:
    "Send a WhatsApp message to a phone number. The message will be delivered in real-time via WhatsApp. Use this to contact businesses found with find_local_business, or any phone number. The AI agent should compose a professional, contextual message in the appropriate language (usually Spanish for LATAM businesses).",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone_number: {
        type: "string",
        description:
          "Phone number in international format (e.g. '+54 11 1234-5678' or '5411XXXXXXXX'). Will be auto-formatted for WhatsApp.",
      },
      message: {
        type: "string",
        description:
          "The message to send. Should be professional, clear, and in the appropriate language for the recipient.",
      },
    },
    required: ["phone_number", "message"],
  },
};

export async function sendWhatsappMessage(
  phoneNumber: string,
  message: string
): Promise<string> {
  const formatted = formatToWhatsApp(phoneNumber);
  const numberOnly = formatted.replace("@c.us", "");

  try {
    const result = await sendMessage(formatted, message);

    // Log to store if this is a known lead
    addMessage(phoneNumber, {
      direction: "outbound",
      body: message,
      timestamp: new Date().toISOString(),
    });

    // Also try with formatted number
    addMessage(formatted, {
      direction: "outbound",
      body: message,
      timestamp: new Date().toISOString(),
    });

    const lead = getLeadByPhone(phoneNumber) || getLeadByPhone(formatted);

    return JSON.stringify({
      success: true,
      message: `Message sent successfully to ${numberOnly} via WhatsApp.`,
      recipient: lead
        ? { name: lead.name, phone: lead.phone }
        : { phone: numberOnly },
      messageSent: message,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Failed to send WhatsApp message: ${String(err)}`,
      hint: "Make sure the WhatsApp sidecar is running and connected. Use connect_whatsapp to check status.",
    });
  }
}
