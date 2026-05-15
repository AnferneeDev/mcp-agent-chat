import { getStatus } from "../whatsapp/client.js";

export const connectWhatsappDefinition = {
  name: "connect_whatsapp",
  description:
    "Check WhatsApp connection status and get the QR code URL if not connected. The user must scan the QR code with their phone to link WhatsApp. Once connected, all other WhatsApp tools will work.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
};

export async function connectWhatsapp(): Promise<string> {
  try {
    const status = await getStatus();

    if (status.connected) {
      return JSON.stringify({
        status: "connected",
        message: "WhatsApp is connected and ready to send/receive messages.",
      });
    }

    if (status.hasQR && status.qrUrl) {
      return JSON.stringify({
        status: "awaiting_scan",
        message: `WhatsApp is not connected yet. Please scan the QR code to link your WhatsApp session.`,
        qrUrl: status.qrUrl,
        instructions:
          "Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → Scan the QR code at the URL above.",
      });
    }

    return JSON.stringify({
      status: "initializing",
      message:
        "WhatsApp client is initializing. Please wait a few seconds and try again.",
    });
  } catch (err) {
    return JSON.stringify({
      status: "error",
      message: `Could not reach the WhatsApp sidecar. Make sure it is running with: npm run sidecar`,
      error: String(err),
    });
  }
}
