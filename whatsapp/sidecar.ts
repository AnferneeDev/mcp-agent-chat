import express from "express";
import type { Request, Response } from "express";
import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = whatsapp;
import type { Message as WAMessage } from "whatsapp-web.js";
import QRCode from "qrcode";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import {
  getActiveNegotiation,
  addNegotiation,
  updateNegotiation,
  incrementNegotiationRounds,
  getAllNegotiations,
  type Negotiation,
} from "../store/json-store.js";
import {
  generateResponse,
  type ConversationMessage,
  type NegotiationContext,
  type AutoResponderResult,
} from "./auto-responder.js";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const PORT = parseInt(process.env.SIDECAR_PORT || "3001", 10);
const MESSAGES_PATH = resolve(process.cwd(), "data", "messages.json");

// --- Persistent Message Store ---

interface StoredMessage {
  body: string;
  timestamp: string;
  rawSender: string; // Original sender ID (e.g. @lid, @c.us)
  isReply: boolean;
  quotedMsg?: string; // Body of the message being replied to, if any
}

// Map<normalizedPhoneNumber@c.us, StoredMessage[]>
let incomingMessages: Record<string, StoredMessage[]> = {};

function ensureDataDir(): void {
  const dir = dirname(MESSAGES_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadMessages(): void {
  ensureDataDir();
  if (existsSync(MESSAGES_PATH)) {
    try {
      const raw = readFileSync(MESSAGES_PATH, "utf-8");
      incomingMessages = JSON.parse(raw);
      console.error(`[Store] Loaded ${Object.keys(incomingMessages).length} contacts from disk.`);
    } catch {
      console.error("[Store] Failed to parse messages.json, starting fresh.");
      incomingMessages = {};
    }
  }
}

function persistMessages(): void {
  ensureDataDir();
  writeFileSync(MESSAGES_PATH, JSON.stringify(incomingMessages, null, 2));
}

function storeMessage(resolvedKey: string, msg: StoredMessage): void {
  if (!incomingMessages[resolvedKey]) {
    incomingMessages[resolvedKey] = [];
  }
  incomingMessages[resolvedKey].push(msg);
  // Keep last 50 messages per contact
  if (incomingMessages[resolvedKey].length > 50) {
    incomingMessages[resolvedKey] = incomingMessages[resolvedKey].slice(-50);
  }
  persistMessages();
}

// --- LID Resolution Cache ---
// Maps @lid IDs to resolved @c.us phone numbers so we don't re-resolve every message
const lidCache = new Map<string, string>();

// Reverse LID cache: resolvedKey (@c.us) → rawSender (@lid)
// When replying, use this to send to the exact LID the message came from,
// NOT whatever getNumberId() returns, which may be a different LID.
const reverseLidCache = new Map<string, string>();

// --- WhatsApp Client Setup ---

let isConnected = false;
let currentQR: string | null = null;
let qrDataUrl: string | null = null;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
});

client.on("qr", async (qr: string) => {
  currentQR = qr;
  qrDataUrl = await QRCode.toDataURL(qr);
  console.error(`[WhatsApp] QR code received. Scan at http://localhost:${PORT}/qr`);
});

client.on("ready", () => {
  isConnected = true;
  currentQR = null;
  qrDataUrl = null;
  console.error("[WhatsApp] Client is ready and connected!");
});

client.on("authenticated", () => {
  console.error("[WhatsApp] Authenticated successfully.");
});

client.on("auth_failure", (msg: string) => {
  console.error("[WhatsApp] Auth failure:", msg);
});

client.on("disconnected", (reason: string) => {
  isConnected = false;
  console.error("[WhatsApp] Disconnected:", reason);
});

// --- Message Handler: Resolve @lid → phone number, then store ---

client.on("message", async (msg: WAMessage) => {
  const rawSender = msg.from;

  // Skip empty messages, status broadcasts, and own sent messages
  if (!msg.body || msg.body.trim().length === 0) return;
  if (rawSender === "status@broadcast") return;
  if (msg.fromMe) return; // Don't auto-respond to our own outgoing messages

  let resolvedKey = rawSender;

  // If sender is a @lid (Linked Device ID), resolve to actual phone number
  if (rawSender.includes("@lid")) {
    // Check cache first
    const cached = lidCache.get(rawSender);
    if (cached) {
      resolvedKey = cached;
    } else {
      try {
        const contact = await msg.getContact();
        // Log all useful contact fields for debugging
        console.error(`[WhatsApp] Contact for LID ${rawSender}: id=${JSON.stringify(contact?.id)}, number=${contact?.number}, pushname=${contact?.pushname}`);

        // contact.number holds the LID numeric ID for linked-device contacts, NOT the phone.
        // contact.id._serialized is the @c.us address with the real phone number when available.
        // Priority: contact.id (when @c.us) > contact.number (as fallback for legacy contacts)
        const phoneFromId = contact?.id?._serialized?.endsWith("@c.us") ? contact.id.user : null;
        const phoneFromNumber = contact?.number && contact.number.length >= 7 ? contact.number : null;
        const phone = phoneFromId || phoneFromNumber;

        if (phone) {
          resolvedKey = `${phone}@c.us`;
          lidCache.set(rawSender, resolvedKey);
          // Store reverse mapping so replies go to the same LID the message came from
          reverseLidCache.set(resolvedKey, rawSender);
          console.error(`[WhatsApp] Resolved LID ${rawSender} → ${resolvedKey} (via ${phoneFromId ? "contact.id" : "contact.number"})`);
        } else {
          // Fallback: try to get the chat and resolve from there
          try {
            const chat = await msg.getChat();
            const chatIdUser = (chat as any).id?.user as string | undefined;
            const chatIdSerialized = (chat as any).id?._serialized as string | undefined;
            console.error(`[WhatsApp] LID chat fallback: id.user=${JSON.stringify(chatIdUser)}, id._serialized=${JSON.stringify(chatIdSerialized)}`);
            // Only use if it's a proper @c.us address, not another @lid
            if (chatIdSerialized?.endsWith("@c.us") && chatIdUser && chatIdUser.length >= 7) {
              resolvedKey = `${chatIdUser}@c.us`;
              lidCache.set(rawSender, resolvedKey);
              reverseLidCache.set(resolvedKey, rawSender);
              console.error(`[WhatsApp] Resolved LID via chat ${rawSender} → ${resolvedKey}`);
            } else {
              console.error(`[WhatsApp] Could not resolve LID ${rawSender}, storing under raw key. Chat ID: ${JSON.stringify((chat as any).id)}`);
            }
          } catch (chatErr) {
            console.error(`[WhatsApp] Chat fallback failed for ${rawSender}: ${chatErr}`);
          }
        }
      } catch (err) {
        console.error(`[WhatsApp] Failed to resolve LID ${rawSender}: ${err}`);
        // Store under raw key as fallback — better than losing the message
      }
    }
  }

  // Check if this message is a reply to a previous message
  let isReply = false;
  let quotedMsg: string | undefined;
  if ((msg as any).hasQuotedMsg) {
    isReply = true;
    try {
      const quoted = await msg.getQuotedMessage().catch(() => null);
      quotedMsg = (quoted as any)?.body || undefined;
    } catch {
      // getQuotedMessage may fail, but we still know it's a reply
    }
  }

  const storedMsg: StoredMessage = {
    body: msg.body,
    timestamp: new Date().toISOString(),
    rawSender,
    isReply,
    quotedMsg,
  };

  storeMessage(resolvedKey, storedMsg);
  console.error(`[WhatsApp] Message from ${resolvedKey}: ${msg.body.substring(0, 100)}`);

  // --- Auto-Respond if there's an active negotiation ---
  const phoneNumber = resolvedKey.replace("@c.us", "");
  const negotiation = getActiveNegotiation(phoneNumber) || getActiveNegotiation(resolvedKey);

  if (negotiation && negotiation.status === "active") {
    console.error(`[AutoRespond] Active negotiation found for ${resolvedKey}, generating response...`);

    // Check round limit
    const currentRound = incrementNegotiationRounds(phoneNumber);
    if (currentRound > negotiation.maxRounds) {
      console.error(`[AutoRespond] Max rounds (${negotiation.maxRounds}) reached for ${resolvedKey}. Stopping.`);
      updateNegotiation(phoneNumber, {
        status: "stopped",
        reason: "max_rounds",
        completedAt: new Date().toISOString(),
      });

      // Notify self
      await sendDealSummary(negotiation, {
        reply: "Negotiation stopped after reaching max rounds.",
        shouldClose: true,
        reason: "max_rounds",
        detectedLanguage: "en",
      }, resolvedKey);
      return;
    }

    // Build conversation history from stored messages
    const allMessages = incomingMessages[resolvedKey] || [];
    const history: ConversationMessage[] = [];

    // We need to interleave outbound (assistant) and inbound (user) messages
    // Outbound messages are tracked in the store but not in incomingMessages
    // For simplicity, use incomingMessages as "user" turns and reconstruct
    // For now, we'll pass all prior inbound messages as context
    // The auto-responder will see the full thread

    // Get all messages for this contact from messages.json (inbound)
    // and reconstruct what we sent (from sidecar send logs)
    const sentMessages = sentMessageLog[resolvedKey] || [];
    
    // Interleave sent (assistant) and received (user) messages by timestamp
    const allTurns: { role: "assistant" | "user"; content: string; ts: string }[] = [];
    
    for (const sm of sentMessages) {
      allTurns.push({ role: "assistant", content: sm.body, ts: sm.timestamp });
    }
    for (const im of allMessages) {
      // Skip the current message — it's passed separately as newReply
      if (im.timestamp === storedMsg.timestamp && im.body === storedMsg.body) continue;
      allTurns.push({ role: "user", content: im.body, ts: im.timestamp });
    }

    // Sort by timestamp
    allTurns.sort((a, b) => a.ts.localeCompare(b.ts));

    const conversationHistory: ConversationMessage[] = allTurns.map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const negContext: NegotiationContext = {
      businessName: negotiation.businessName,
      phone: phoneNumber,
      context: negotiation.context,
      objective: negotiation.objective,
      brief: negotiation.brief || `BRIEF: ${negotiation.context}\nOBJECTIVE: ${negotiation.objective}`,
    };

    try {
      const result = await generateResponse(negContext, conversationHistory, msg.body);
      console.error(`[AutoRespond] AI response: ${result.reply.substring(0, 100)}${result.shouldClose ? ` [CLOSING: ${result.reason}]` : ""}`);

      // Use reverse LID cache to reply via the same LID contact messaged us from.
      // This ensures replies stay in the same conversation thread.
      // Fall back to getNumberId() only if no cached LID exists.
      const cachedLid = reverseLidCache.get(resolvedKey);
      let sendTo: string;

      if (cachedLid) {
        sendTo = cachedLid;
        console.error(`[AutoRespond] Using cached LID for ${resolvedKey}: ${sendTo}`);
      } else {
        const cleanPhone = resolvedKey.replace("@c.us", "");
        const resolvedReplyId = await (client as any).getNumberId(cleanPhone).catch(() => null);
        sendTo = resolvedReplyId
          ? (resolvedReplyId._serialized as string)
          : resolvedKey; // fallback to @c.us
      }
      await client.sendMessage(sendTo, result.reply);

      // Track sent message under resolved key for conversation history consistency
      trackSentMessage(resolvedKey, result.reply);
      console.error(`[AutoRespond] Sent response to ${sendTo} (resolvedKey=${resolvedKey})`);
      // If negotiation is done, update status and notify self
      if (result.shouldClose) {
        updateNegotiation(phoneNumber, {
          status: result.reason === "deal_accepted" ? "completed" : "rejected",
          reason: result.reason,
          completedAt: new Date().toISOString(),
        });
        console.error(`[AutoRespond] Negotiation ${result.reason} for ${resolvedKey}`);
        // Send deal summary to own WhatsApp
        const refreshedNeg = getActiveNegotiation(phoneNumber) || negotiation;
        refreshedNeg.status = result.reason === "deal_accepted" ? "completed" : "rejected";
        await sendDealSummary(refreshedNeg, result, resolvedKey);
      }
    } catch (err) {
      console.error(`[AutoRespond] Error generating/sending response: ${err}`);
    }
  }
});

// --- Self-Notification: Send deal summary to own WhatsApp ---

async function generateSummaryText(negotiation: Negotiation, result: AutoResponderResult, resolvedKey: string): Promise<string> {
  const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
  const AI_PROVIDER = process.env.AI_PROVIDER || "deepseek";
  const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
  const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

  let apiUrl: string;
  let apiKey: string;
  let model: string;

  if (AI_PROVIDER === "ollama") {
    apiUrl = `${OLLAMA_URL}/v1/chat/completions`;
    apiKey = "ollama";
    model = process.env.OLLAMA_MODEL || "llama3.2";
  } else if (AI_PROVIDER === "openai") {
    apiUrl = "https://api.openai.com/v1/chat/completions";
    apiKey = OPENAI_KEY;
    model = process.env.MODEL || "gpt-4o";
  } else {
    apiUrl = "https://api.deepseek.com/chat/completions";
    apiKey = DEEPSEEK_KEY;
    model = process.env.MODEL || "deepseek-chat";
  }

  if (!apiKey) {
    return `${result.reason === "deal_accepted" ? "✅" : "❌"} ${result.reason}\n${negotiation.businessName || resolvedKey.replace("@c.us", "")}\n${negotiation.phone}\n${result.reply}\n${negotiation.rounds}/${negotiation.maxRounds} rounds`;
  }

  const statusLabel = result.reason === "deal_accepted"
    ? "ACCEPTED"
    : result.reason === "deal_rejected"
      ? "REJECTED"
      : "MAX ROUNDS";

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 250,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `You format negotiation result summaries. CRITICAL: write the ENTIRE summary in the SAME LANGUAGE as the negotiation context. Detect the context language and use it for all labels. No English unless the context is English. No explanations — output only the summary text.`,
          },
          {
            role: "user",
            content: `Generate a brief summary of this completed negotiation. Write all labels and text in the same language as the CONTEXT below.

Status: ${statusLabel} (${result.reason})
Business: ${negotiation.businessName || resolvedKey.replace("@c.us", "")} (${negotiation.phone})
Context: ${negotiation.context}
Objective: ${negotiation.objective}
Final reply: ${result.reply}
Total rounds: ${negotiation.rounds}/${negotiation.maxRounds}

Format like this example (but translated to match context language):
✅ TRATO CERRADO
Negocio: Panadería X (584141234567)
Contexto: Torta para 80 personas...
Objetivo: Precio bajo $100...
Última respuesta: Perfecto, quedamos en $80
Rondas: 3/10`,
          },
        ],
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      return data.choices?.[0]?.message?.content?.trim() || `${statusLabel}: ${negotiation.phone}`;
    }
  } catch (err) {
    console.error(`[Notify] Summary generation failed: ${err}`);
  }

  // Fallback
  return `${statusLabel}\n${negotiation.businessName || resolvedKey} (${negotiation.phone})\n${negotiation.context.substring(0, 100)}\n${result.reply}`;
}

async function sendDealSummary(negotiation: Negotiation, result: AutoResponderResult, resolvedKey: string): Promise<void> {
  try {
    const ownNumber = client.info?.wid?.user;
    if (!ownNumber) {
      console.error("[Notify] Cannot get own WhatsApp number.");
      return;
    }

    const ownChatId = `${ownNumber}@c.us`;
    const summary = await generateSummaryText(negotiation, result, resolvedKey);

    await client.sendMessage(ownChatId, summary);
    console.error(`[Notify] Deal summary sent to self (${ownChatId})`);
  } catch (err) {
    console.error(`[Notify] Failed to send deal summary: ${err}`);
  }
}

// --- Sent Message Tracking (for conversation history) ---
const sentMessageLog: Record<string, { body: string; timestamp: string }[]> = {};

function trackSentMessage(resolvedKey: string, body: string): void {
  if (!sentMessageLog[resolvedKey]) {
    sentMessageLog[resolvedKey] = [];
  }
  sentMessageLog[resolvedKey].push({
    body,
    timestamp: new Date().toISOString(),
  });
}

// --- Express Server ---

const app = express();
app.use(express.json());

// Health / status
app.get("/status", (_req: Request, res: Response) => {
  res.json({
    connected: isConnected,
    hasQR: currentQR !== null,
    qrUrl: currentQR ? `http://localhost:${PORT}/qr` : null,
  });
});

// QR code page
app.get("/qr", (_req: Request, res: Response) => {
  if (isConnected) {
    res.send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:system-ui;background:#0a0a0a;color:#fff;">
          <div style="text-align:center;">
            <h1>WhatsApp Connected</h1>
            <p style="color:#22c55e;font-size:1.5rem;">Session is active. You're good to go.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  if (!qrDataUrl) {
    res.send(`
      <html>
        <head><meta http-equiv="refresh" content="3"></head>
        <body style="display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:system-ui;background:#0a0a0a;color:#fff;">
          <div style="text-align:center;">
            <h1>Waiting for QR Code...</h1>
            <p>This page will refresh automatically.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="15"></head>
      <body style="display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:system-ui;background:#0a0a0a;color:#fff;">
        <div style="text-align:center;">
          <h1>Scan QR Code with WhatsApp</h1>
          <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
          <img src="${qrDataUrl}" style="width:300px;height:300px;margin:20px auto;border-radius:12px;" />
          <p style="color:#888;">Page refreshes automatically. QR expires in ~60s.</p>
        </div>
      </body>
    </html>
  `);
});

// Send a message
app.post("/send", async (req: Request, res: Response) => {
  const { number, message } = req.body as { number: string; message: string };

  if (!isConnected) {
    res.status(503).json({ error: "WhatsApp is not connected. Scan QR first." });
    return;
  }

  if (!number || !message) {
    res.status(400).json({ error: "Missing 'number' or 'message' in body." });
    return;
  }

  try {
    // Strip any existing suffix to get a clean number
    const cleanNumber = number.replace(/@(c\.us|lid|s\.whatsapp\.net)$/, "").replace(/\D/g, "");

    // Use reverse LID cache to reply via the exact LID the contact messaged us from.
    // This ensures messages stay in the correct conversation thread.
    // getNumberId() may return a different @lid that doesn't correspond to the active chat.
    const cachedKey = `${cleanNumber}@c.us`;
    const cachedLid = reverseLidCache.get(cachedKey);
    let chatId: string;

    if (cachedLid) {
      chatId = cachedLid;
      console.error(`[WhatsApp] Using cached LID for ${cachedKey}: ${chatId}`);
    } else {
      // getNumberId resolves the correct chat ID — either @c.us or @lid for LID-only contacts
      const resolvedId = await (client as any).getNumberId(cleanNumber);
      chatId = resolvedId
        ? (resolvedId._serialized as string)
        : `${cleanNumber}@c.us`; // fallback for numbers not on WhatsApp
    }

    await client.sendMessage(chatId, message);
    // Always track under @c.us key for consistent conversation history lookups
    const trackKey = chatId.includes("@c.us") ? chatId : `${cleanNumber}@c.us`;
    trackSentMessage(trackKey, message);
    console.error(`[WhatsApp] Sent to ${chatId} (trackKey=${trackKey}): ${message.substring(0, 100)}`);
    res.json({ success: true, to: chatId, message });
  } catch (err) {
    console.error("[WhatsApp] Send error:", err);
    res.status(500).json({ error: "Failed to send message", details: String(err) });
  }
});

// Check replies — exact match by normalized @c.us key
app.get("/replies", (req: Request, res: Response) => {
  const numbersParam = (req.query.numbers as string) || "";
  const numbers = numbersParam
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (numbers.length === 0) {
    // Return all messages
    res.json({ replies: incomingMessages });
    return;
  }

  const result: Record<string, StoredMessage[]> = {};
  for (const num of numbers) {
    // Normalize to @c.us format
    const key = num.includes("@") ? num : `${num}@c.us`;
    const messages = incomingMessages[key];
    if (messages && messages.length > 0) {
      result[key] = messages;
    }
  }
  res.json({ replies: result });
});

// QR code raw data for MCP image content
app.get("/qr-data", (_req: Request, res: Response) => {
  if (qrDataUrl) {
    const base64 = qrDataUrl.includes(",") ? qrDataUrl.split(",")[1] : qrDataUrl;
    res.json({ qrDataUrl, base64 });
  } else if (isConnected) {
    res.json({ qrDataUrl: null, connected: true });
  } else {
    res.json({ qrDataUrl: null, connected: false, waiting: true });
  }
});

// --- Negotiation Management Endpoints ---

// Start a new autonomous negotiation
app.post("/negotiations", (req: Request, res: Response) => {
  const { phone, phoneFormatted, businessName, context, objective, brief, maxRounds } = req.body as {
    phone: string;
    phoneFormatted: string;
    businessName?: string;
    context: string;
    objective: string;
    brief?: string;
    maxRounds?: number;
  };

  if (!phone || !context || !objective) {
    res.status(400).json({ error: "Missing required fields: phone, context, objective" });
    return;
  }

  const negotiation: Negotiation = {
    phone,
    phoneFormatted: phoneFormatted || `${phone.replace(/\D/g, "")}@c.us`,
    businessName,
    context,
    objective,
    brief: brief || `BRIEF: ${context}\nOBJECTIVE: ${objective}`,
    status: "active",
    rounds: 0,
    maxRounds: maxRounds || 15,
    startedAt: new Date().toISOString(),
  };

  addNegotiation(negotiation);
  console.error(`[Negotiation] Started for ${phone}: ${context.substring(0, 80)}`);
  res.json({ success: true, negotiation });
});

// List all negotiations
app.get("/negotiations", (_req: Request, res: Response) => {
  const negotiations = getAllNegotiations();
  res.json({ negotiations });
});

// Stop a negotiation
app.delete("/negotiations/:phone", (req: Request, res: Response) => {
  const phone = req.params.phone as string;
  const updated = updateNegotiation(phone, {
    status: "stopped",
    reason: "manual_stop",
    completedAt: new Date().toISOString(),
  });

  if (!updated) {
    // Try with @c.us suffix
    const updated2 = updateNegotiation(`${phone}@c.us`, {
      status: "stopped",
      reason: "manual_stop",
      completedAt: new Date().toISOString(),
    });
    if (!updated2) {
      res.status(404).json({ error: "Negotiation not found" });
      return;
    }
    res.json({ success: true, negotiation: updated2 });
    return;
  }

  console.error(`[Negotiation] Stopped for ${phone}`);
  res.json({ success: true, negotiation: updated });
});

// --- Clear Cache ---

app.post("/clear-cache", (_req: Request, res: Response) => {
  const clearedCount = Object.keys(incomingMessages).length;
  incomingMessages = {};
  // Clear sent message log
  for (const key of Object.keys(sentMessageLog)) {
    delete sentMessageLog[key];
  }
  // Clear LID caches
  lidCache.clear();
  reverseLidCache.clear();
  // Clear messages.json on disk
  ensureDataDir();
  writeFileSync(MESSAGES_PATH, JSON.stringify({}, null, 2));
  console.error(`[Cache] Cleared ${clearedCount} contact threads, all message logs, and LID caches.`);
  res.json({ success: true, clearedContacts: clearedCount });
});

// --- Send Media ---

app.post("/send-media", async (req: Request, res: Response) => {
  const { number, filePath, caption, mediaData, mimeType, fileName } = req.body as {
    number: string;
    filePath?: string;
    caption?: string;
    mediaData?: string; // base64-encoded
    mimeType?: string;  // e.g. "image/png", "application/pdf"
    fileName?: string;
  };

  if (!isConnected) {
    res.status(503).json({ error: "WhatsApp is not connected. Scan QR first." });
    return;
  }

  if (!number) {
    res.status(400).json({ error: "Missing 'number' in body." });
    return;
  }

  try {
    let media: typeof MessageMedia.prototype;

    if (filePath) {
      media = MessageMedia.fromFilePath(filePath);
    } else if (mediaData && mimeType) {
      media = new MessageMedia(mimeType, mediaData, fileName || "file");
    } else {
      res.status(400).json({ error: "Provide either 'filePath' or both 'mediaData' + 'mimeType'." });
      return;
    }

    if (caption) {
      media = Object.assign(media, { caption });
    }

    const cleanNumber = number.replace(/@(c\.us|lid|s\.whatsapp\.net)$/, "").replace(/\D/g, "");
    const cachedKey = `${cleanNumber}@c.us`;
    const cachedLid = reverseLidCache.get(cachedKey);
    let chatId: string;

    if (cachedLid) {
      chatId = cachedLid;
    } else {
      const resolvedId = await (client as any).getNumberId(cleanNumber).catch(() => null);
      chatId = resolvedId ? (resolvedId._serialized as string) : `${cleanNumber}@c.us`;
    }

    await client.sendMessage(chatId, media);
    const trackKey = chatId.includes("@c.us") ? chatId : `${cleanNumber}@c.us`;
    trackSentMessage(trackKey, `[MEDIA] ${fileName || filePath || mimeType}${caption ? ` — ${caption}` : ""}`);
    console.error(`[WhatsApp] Media sent to ${chatId}: ${fileName || filePath || mimeType}`);
    res.json({ success: true, to: chatId, mediaType: mimeType || filePath, caption });
  } catch (err) {
    console.error("[WhatsApp] Send media error:", err);
    res.status(500).json({ error: "Failed to send media", details: String(err) });
  }
});

// --- Start ---

console.error(`[Sidecar] Starting WhatsApp sidecar on port ${PORT}...`);
loadMessages();
client.initialize();

app.listen(PORT, () => {
  console.error(`[Sidecar] HTTP server listening on http://localhost:${PORT}`);
  console.error(`[Sidecar] QR page: http://localhost:${PORT}/qr`);
  console.error(`[Sidecar] Status: http://localhost:${PORT}/status`);
});
