#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { connectWhatsapp } from "./tools/connect-whatsapp.js";
import { findLocalBusiness } from "./tools/find-local-business.js";
import { sendWhatsappMessage } from "./tools/send-whatsapp-message.js";
import { checkWhatsappReplies } from "./tools/check-whatsapp-replies.js";
import { startNegotiation } from "./tools/start-negotiation.js";
import { stopNegotiation } from "./tools/stop-negotiation.js";

// --- MCP Server ---

const server = new McpServer({
  name: "chat",
  version: "1.0.0",
});

// Tool 1: Connect WhatsApp
server.tool(
  "connect_whatsapp",
  "Check WhatsApp connection status and get the QR code URL if not connected. The user must scan the QR code with their phone to link WhatsApp. Always call this first before using other WhatsApp tools.",
  {},
  async () => {
    const result = await connectWhatsapp();
    return { content: [{ type: "text", text: result }] };
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
  "Start a fully autonomous negotiation with a business via WhatsApp. The AI auto-responds to all replies using DeepSeek, negotiating toward your objective until a deal is closed, rejected, or max rounds (default 15) are reached. You walk away and it handles everything.",
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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Chat server started.");
  console.error("[MCP] Tools: connect_whatsapp, find_local_business, send_whatsapp_message, check_whatsapp_replies, start_negotiation, stop_negotiation");
}

main().catch((err) => {
  console.error("[MCP] Fatal error:", err);
  process.exit(1);
});
