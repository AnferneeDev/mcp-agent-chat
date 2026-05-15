#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), ".env") });

import { connectWhatsapp } from "./tools/connect-whatsapp.js";
import { findLocalBusiness } from "./tools/find-local-business.js";
import { sendWhatsappMessage } from "./tools/send-whatsapp-message.js";
import { checkWhatsappReplies } from "./tools/check-whatsapp-replies.js";
import { startNegotiation } from "./tools/start-negotiation.js";
import { stopNegotiation } from "./tools/stop-negotiation.js";
import { clearChatCache } from "./tools/clear-chat-cache.js";
import { summarizeNegotiation } from "./tools/summarize-negotiation.js";
import { sendWhatsappMedia } from "./tools/send-whatsapp-media.js";

// --- Auto-spawn Sidecar ---

let sidecarProcess: ChildProcess | null = null;

function startSidecar(): void {
  const port = process.env.SIDECAR_PORT || "3001";
  const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === "development";
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)));

  const cmd = isDev ? "npx" : "node";
  const args = isDev
    ? ["tsx", "whatsapp/sidecar.ts"]
    : ["dist/whatsapp/sidecar.js"];

  console.error(`[MCP] Auto-starting sidecar: ${cmd} ${args.join(" ")}`);
  console.error(`[MCP] Working directory: ${cwd}`);

  sidecarProcess = spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, SIDECAR_PORT: port },
  });

  sidecarProcess.on("error", (err) => {
    console.error(`[MCP] Failed to start sidecar: ${err.message}`);
  });

  sidecarProcess.on("exit", (code, signal) => {
    console.error(`[MCP] Sidecar exited (code=${code}, signal=${signal})`);
    sidecarProcess = null;
  });

  // Graceful shutdown
  const cleanup = () => {
    if (sidecarProcess) {
      console.error("[MCP] Stopping sidecar...");
      sidecarProcess.kill("SIGTERM");
    }
    process.exit();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// --- MCP Server ---

const server = new McpServer({
  name: "chat",
  version: "1.1.0",
});

// Tool 1: Connect WhatsApp (with inline QR image)
server.tool(
  "connect_whatsapp",
  "Check WhatsApp connection status and get the QR code image if not connected. The user can scan the QR code directly in supported MCP clients without opening a browser. Always call this first before using other WhatsApp tools.",
  {},
  async () => {
    const result = await connectWhatsapp();
    const content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [
      { type: "text", text: JSON.stringify({ status: result.status, message: result.message, instructions: result.instructions, qrUrl: result.qrUrl }) },
    ];

    // If QR base64 data is available, include it as an inline image
    if (result.qrBase64) {
      content.push({
        type: "image",
        data: result.qrBase64,
        mimeType: "image/png",
      });
    }

    return { content: content as any };
  }
);

// Tool 2: Find Local Business
server.tool(
  "find_local_business",
  "Search for local businesses using Google Places API. Returns business names, addresses, phone numbers, and ratings. Results are saved locally for use with WhatsApp messaging. Use queries like 'bakeries in Buenos Aires' or 'catering near Palermo'.",
  {
    query: z.string().describe(
      "Search query with business type and location, e.g. 'bakeries in Buenos Aires'"
    ),
    max_results: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Max results to return (1-10, default 5)"),
  },
  async ({ query, max_results }) => {
    const result = await findLocalBusiness(query, max_results ?? 5);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 3: Send WhatsApp Message
server.tool(
  "send_whatsapp_message",
  "Send a WhatsApp message to a phone number in real-time. Use this to contact businesses found with find_local_business, or message any phone number directly. Compose professional messages in the appropriate language (Spanish for LATAM).",
  {
    phone_number: z.string().describe(
      "Phone number in international format (e.g. '+54 11 1234-5678')"
    ),
    message: z.string().describe(
      "Message text to send. Be professional and write in the appropriate language."
    ),
  },
  async ({ phone_number, message }) => {
    const result = await sendWhatsappMessage(phone_number, message);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 4: Check WhatsApp Replies
server.tool(
  "check_whatsapp_replies",
  "Check for incoming WhatsApp replies from businesses you've contacted. Returns real replies if available, or simulated demo responses if no reply yet. Can check specific numbers or all contacted leads.",
  {
    phone_numbers: z
      .array(z.string())
      .optional()
      .describe(
        "Phone numbers to check. If empty, checks all previously contacted leads."
      ),
    wait_seconds: z
      .number()
      .min(1)
      .max(15)
      .optional()
      .describe("Seconds to wait for replies before returning (default 5)"),
  },
  async ({ phone_numbers, wait_seconds }) => {
    const result = await checkWhatsappReplies(phone_numbers, wait_seconds ?? 5);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 5: Start Autonomous Negotiation
server.tool(
  "start_negotiation",
  "Start a fully autonomous negotiation with a business via WhatsApp. The AI auto-responds to all replies using the configured AI provider, negotiating toward your objective until a deal is closed, rejected, or max rounds (default 15) are reached. You walk away and it handles everything. When the deal closes, a summary is sent to your own WhatsApp chat automatically.",
  {
    phone_number: z.string().describe("Phone number in international format"),
    context: z.string().describe(
      "What you need — describe the event/order. E.g. 'Catering for 80 person party in Caracas, May 24'"
    ),
    objective: z.string().describe(
      "Your negotiation goal. E.g. 'Best price under $8000, must include setup and waiters'"
    ),
    business_name: z.string().optional().describe("Name of the business"),
    initial_message: z.string().optional().describe("Custom first message to send"),
    max_rounds: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max back-and-forth rounds (default 15)"),
  },
  async ({ phone_number, context, objective, business_name, initial_message, max_rounds }) => {
    const result = await startNegotiation(
      phone_number,
      context,
      objective,
      business_name,
      initial_message,
      max_rounds ?? 15
    );
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 6: Stop Negotiation / List Negotiations
server.tool(
  "stop_negotiation",
  "Stop an active autonomous negotiation, or list all negotiations and their statuses if no phone number is provided.",
  {
    phone_number: z
      .string()
      .optional()
      .describe("Phone number to stop negotiating with. Omit to list all negotiations."),
  },
  async ({ phone_number }) => {
    const result = await stopNegotiation(phone_number);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 7: Clear Chat Cache
server.tool(
  "clear_chat_cache",
  "Clear all stored chat messages, conversation history, and LID caches. Use this if the agent seems stuck, is repeating itself, or the conversation context appears corrupted. Does NOT affect active negotiations unless clear_negotiations is set to true.",
  {
    clear_negotiations: z
      .boolean()
      .optional()
      .describe("Also clear all negotiation data (default false)."),
  },
  async ({ clear_negotiations }) => {
    const result = await clearChatCache(clear_negotiations ?? false);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 8: Summarize Negotiation
server.tool(
  "summarize_negotiation",
  "Get a human-readable summary of a negotiation's progress including conversation history, current round, key discussion points, and the negotiation brief. Provide a phone number to summarize a specific negotiation, or omit to list all negotiations with brief status summaries.",
  {
    phone_number: z
      .string()
      .optional()
      .describe("Phone number of the negotiation to summarize. Omit to list all negotiations."),
  },
  async ({ phone_number }) => {
    const result = await summarizeNegotiation(phone_number);
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool 9: Send WhatsApp Media
server.tool(
  "send_whatsapp_media",
  "Send an image, PDF, or other media file via WhatsApp. Supports local file paths. Use this to share catalogs, menus, proposals, product images, or any file with businesses you're negotiating with.",
  {
    phone_number: z.string().describe("Phone number in international format (e.g. '+54 11 1234-5678')"),
    file_path: z.string().describe("Absolute path to the media file on disk."),
    caption: z.string().optional().describe("Optional caption to send with the media."),
  },
  async ({ phone_number, file_path, caption }) => {
    const result = await sendWhatsappMedia(phone_number, file_path, caption);
    return { content: [{ type: "text", text: result }] };
  }
);

// --- Start ---

async function waitForSidecarReady(): Promise<void> {
  const port = process.env.SIDECAR_PORT || "3001";
  const statusUrl = `http://localhost:${port}/status`;
  const maxAttempts = 40;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(statusUrl);
      if (res.ok) {
        console.error(`[MCP] Sidecar is ready on port ${port}.`);
        return;
      }
    } catch {
      // Sidecar not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("[MCP] Warning: Sidecar did not become ready within 20s. Tools requiring WhatsApp will fail until the sidecar starts.");
}

async function main() {
  // Start sidecar in background — do NOT block stdio connection
  startSidecar();

  // Connect to MCP transport immediately so client doesn't time out
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Chat server started.");
  console.error("[MCP] Tools: connect_whatsapp, find_local_business, send_whatsapp_message, check_whatsapp_replies, start_negotiation, stop_negotiation, clear_chat_cache, summarize_negotiation, send_whatsapp_media");

  // Kick off async sidecar readiness check (fire-and-forget, logs only)
  waitForSidecarReady().catch((err) =>
    console.error("[MCP] Sidecar readiness check failed:", err)
  );
}

main().catch((err) => {
  console.error("[MCP] Fatal error:", err);
  process.exit(1);
});
