import { getStatus, getQRData } from "../whatsapp/client.js";

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

export interface ConnectResult {
  status: "connected" | "awaiting_scan" | "initializing" | "error";
  message: string;
  qrUrl?: string | null;
  qrBase64?: string;
  instructions?: string;
  provider?: string;
  providerInfo?: string;
  error?: string;
}

export async function connectWhatsapp(): Promise<ConnectResult> {
  try {
    const status = await getStatus();

    if (status.connected) {
      return {
        status: "connected",
        message: "WhatsApp is connected and ready to send/receive messages.",
        provider: (status as any).provider,
        providerInfo: (status as any).providerInfo,
      };
    }

    if (status.hasQR && status.qrUrl) {
      // Fetch raw QR data for inline image rendering in MCP clients
      let qrBase64: string | undefined;
      try {
        const qrData = await getQRData();
        qrBase64 = qrData.base64;
      } catch {
        // Fallback: QR data fetch failed, still return URL
      }

      return {
        status: "awaiting_scan",
        message: "WhatsApp is not connected yet. Scan the QR code below with your phone.",
        qrUrl: status.qrUrl,
        qrBase64,
        provider: (status as any).provider,
        providerInfo: (status as any).providerInfo,
        instructions:
          "Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → Scan the QR code.",
      };
    }

    return {
      status: "initializing",
      message:
        "WhatsApp client is initializing. Please wait a few seconds and try again.",
    };
  } catch (err) {
    return {
      status: "error",
      message: `Could not reach the WhatsApp sidecar. Make sure it is running with: npm run sidecar`,
      error: String(err),
    };
  }
}
