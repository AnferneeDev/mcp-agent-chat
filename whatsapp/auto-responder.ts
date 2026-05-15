import { config } from "dotenv";

config();

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const AI_PROVIDER = process.env.AI_PROVIDER || (DEEPSEEK_API_KEY ? "deepseek" : (OPENAI_API_KEY ? "openai" : "deepseek"));
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const MODEL = process.env.MODEL || (AI_PROVIDER === "openai" ? "gpt-4o" : AI_PROVIDER === "ollama" ? OLLAMA_MODEL : "deepseek-chat");

export interface NegotiationContext {
  businessName?: string;
  phone: string;
  context: string;
  objective: string;
  brief: string;
}

export interface ConversationMessage {
  role: "assistant" | "user";
  content: string;
}

export interface AutoResponderResult {
  reply: string;
  shouldClose: boolean;
  reason?: string;
  detectedLanguage: string;
}

// --- API call wrapper ---

async function callAI(messages: { role: string; content: string }[]): Promise<string> {
  const isOpenAI = AI_PROVIDER === "openai";
  const isOllama = AI_PROVIDER === "ollama";
  const url = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : isOpenAI ? OPENAI_URL : DEEPSEEK_URL;
  const key = isOllama ? "ollama" : isOpenAI ? OPENAI_API_KEY : DEEPSEEK_API_KEY;

  if (!key) {
    throw new Error(`${AI_PROVIDER}_API_KEY is not configured.`);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 200,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${AI_PROVIDER} API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// --- Brief generation (unchanged, same language logic) ---

function detectLanguage(text: string): string {
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(text)) return "ar";
  if (/[áéíóúüñ¿¡ÁÉÍÓÚÜÑ]/.test(text)) return "es";
  const lower = text.toLowerCase();
  const spanishWords = /\b(de|que|no|es|la|el|en|los|las|por|para|con|una|un|del|se|lo|como|más|pero|sus|me|le|gracias|hola|buenos|días|tardes|noches|precio|cantidad|incluye|incluyen|favor|cotización|envío|pago|transferencia|acuerdo|trato|negocio|cliente|proveedor)\b/i;
  if (spanishWords.test(lower)) return "es";
  return "en";
}

export async function generateBrief(context: string, objective: string): Promise<string> {
  if (!DEEPSEEK_API_KEY && !OPENAI_API_KEY) {
    return `BRIEF:\n- Context: ${context}\n- Objective: ${objective}\n- DO NOT reduce core requirements.`;
  }

  const ctxLang = detectLanguage(context);
  const langNames: Record<string, string> = { ar: "Arabic", es: "Spanish", en: "English" };
  const langName = langNames[ctxLang] || "the same language as the context below";

  const systemPrompt = `You are a procurement strategist. Produce a structured negotiation brief.

CRITICAL: Write the ENTIRE brief in ${langName}. Do NOT translate. Every label and bullet must be in ${langName}.

Output ONLY the brief:

REQUIREMENTS (NON-NEGOTIABLE):
- [each requirement]

DEAL BREAKERS:
- [conditions that end the negotiation]

BUDGET CEILING:
- [absolute max budget]

MUST-HAVE:
- [required items]

NICE-TO-HAVE:
- [optional items]

STARTING APPROACH:
- [opening tone and first step to confirm]`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: `Client needs: ${context}\n\nClient objective: ${objective}` },
  ];

  try {
    return await callAI(messages);
  } catch (err) {
    console.error(`[BriefGen] Error: ${err}`);
    return `BRIEF (fallback):\n- Context: ${context}\n- Objective: ${objective}\n- DO NOT reduce core requirements.`;
  }
}

// --- Language detection for replies ---

function getLanguageInstruction(detectedLang: string): string {
  switch (detectedLang) {
    case "ar":
      return "Reply in ARABIC only. Write right-to-left. Use formal Arabic (فصحى), warm but professional.";
    case "es":
      return "Reply in SPANISH only. Use warm Latin American Spanish, professional but friendly like talking to a neighbor.";
    default:
      return "Reply in ENGLISH only. Warm, polite, professional.";
  }
}

// --- Response generation with warm conversational style ---

function buildMessages(
  negotiation: NegotiationContext,
  history: ConversationMessage[],
  newReply: string,
  detectedLang: string
): { role: string; content: string }[] {
  const langInstruction = getLanguageInstruction(detectedLang);

  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: `You are a friendly procurement assistant negotiating via WhatsApp on behalf of a client. You're warm, patient, and build rapport. You're not a pushy salesperson — you're helping both sides reach a fair agreement.

TONE:
- Warm and respectful. Open with a greeting if early in the conversation.
- Match the business's tone. If they are casual, be casual. If formal, be formal.
- Never list all requirements at once. Confirm ONE thing per message.
- Build agreement step by step: first confirm availability → then price → then details → then close.
- ${langInstruction}
- Keep messages SHORT — 1 to 2 sentences max. This is WhatsApp, not email.

NEGOTIATION STYLE:
- Start by confirming the most important thing (availability / can they do it).
- Once confirmed, naturally discuss price without being aggressive.
- Only introduce each requirement AFTER the previous one is settled.
- If they counter-offer within budget → accept gracefully, don't haggle unnecessarily.
- If they go above budget → politely explain the limit, ask if they can work within it.

CRITICAL — ANTI-BAN RULES. WhatsApp monitors for spam. You MUST obey these or the account gets banned:
- NEVER repeat any message you have already sent. Not even with small changes.
- Vary your greetings: "Hola", "Buenos días", "Buen día", "Saludos", "Hola de nuevo", "Gracias por responder" — never the same one twice in a row.
- Vary your closings and phrasing. Same intent, different words EVERY time.
- Vary message length. Alternate between very short (one line) and slightly longer messages.
- If you are about to write something that feels similar to a previous message, rephrase it completely.
- Do NOT send messages that look templated. Each message must sound like a human typed it fresh.
- No emoji patterns. If you use an emoji, don't use the same one twice in consecutive messages.

CLOSING RULES (CRITICAL — you MUST follow these EXACTLY):
- When the business confirms everything and a deal is reached → start your message with the EXACT prefix [DEAL_CLOSED] followed by your warm closing message. Example: "[DEAL_CLOSED] ¡Perfecto! Quedamos así entonces..."
- When the business rejects something that is a deal breaker, or you cannot reach an agreement → start your message with the EXACT prefix [DEAL_REJECTED] followed by your polite goodbye. Example: "[DEAL_REJECTED] Entiendo, gracias por su tiempo..."
- ONLY use these prefixes when the negotiation is truly over. Do NOT use them mid-conversation.
- The prefix must be the VERY FIRST characters of your message, no spaces before it.

THE BRIEF:
Below is your negotiation brief. It contains everything the client needs. Do NOT list all requirements at once. Introduce them one at a time, naturally, as the conversation progresses. Stay within the budget ceiling at ALL times. If a deal breaker is hit, close politely.

${negotiation.brief}

SUPPLIER: ${negotiation.businessName || "Unknown"} (${negotiation.phone})`,
    },
  ];

  for (const msg of history) {
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }

  messages.push({ role: "user", content: newReply });

  return messages;
}

export async function generateResponse(
  negotiation: NegotiationContext,
  history: ConversationMessage[],
  newReply: string
): Promise<AutoResponderResult> {
  const detectedLang = detectLanguage(newReply);
  const messages = buildMessages(negotiation, history, newReply, detectedLang);

  const rawReply = await callAI(messages);

  if (rawReply.startsWith("[DEAL_CLOSED]")) {
    return {
      reply: rawReply.replace("[DEAL_CLOSED]", "").trim(),
      shouldClose: true,
      reason: "deal_accepted",
      detectedLanguage: detectedLang,
    };
  }

  if (rawReply.startsWith("[DEAL_REJECTED]")) {
    return {
      reply: rawReply.replace("[DEAL_REJECTED]", "").trim(),
      shouldClose: true,
      reason: "deal_rejected",
      detectedLanguage: detectedLang,
    };
  }

  return {
    reply: rawReply,
    shouldClose: false,
    detectedLanguage: detectedLang,
  };
}
