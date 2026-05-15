import { sendMedia } from "../whatsapp/client.js";
import { formatToWhatsApp } from "../utils/phone-formatter.js";

export const sendWhatsappMediaDefinition = {
  name: "send_whatsapp_media",
  description:
    "Send an image, PDF, or other media file via WhatsApp. Supports local file paths or base64-encoded data. Use this to share catalogs, menus, proposals, or product images with businesses.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone_number: {
        type: "string",
        description: "Phone number in international format (e.g. '+54 11 1234-5678').",
      },
      file_path: {
        type: "string",
        description: "Absolute path to the media file on disk. Use this for local files.",
      },
      caption: {
        type: "string",
        description: "Optional caption text to send with the media.",
      },
    },
    required: ["phone_number", "file_path"],
  },
};

export async function sendWhatsappMedia(
  phoneNumber: string,
  filePath: string,
  caption?: string
): Promise<string> {
  const formatted = formatToWhatsApp(phoneNumber);
  const numberOnly = formatted.replace("@c.us", "");

  try {
    const result = await sendMedia({
      number: formatted,
      filePath,
      caption,
    });

    return JSON.stringify({
      success: true,
      message: `Media sent successfully to ${numberOnly} via WhatsApp.`,
      recipient: { phone: numberOnly },
      mediaType: result.mediaType,
      caption: result.caption || null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: `Failed to send WhatsApp media: ${String(err)}`,
      hint: "Make sure the WhatsApp sidecar is running and connected, and the file path is valid.",
    });
  }
}
