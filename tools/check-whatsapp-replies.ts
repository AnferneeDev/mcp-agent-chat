import { getReplies } from "../whatsapp/client.js";
import { loadStore, addMessage } from "../store/json-store.js";
import { formatToWhatsApp } from "../utils/phone-formatter.js";

export const checkWhatsappRepliesDefinition = {
  name: "check_whatsapp_replies",
  description:
    "Check for incoming WhatsApp replies from businesses or contacts you've messaged. Can check specific phone numbers or all contacted leads. Returns real replies if available, or a simulated response for demo purposes if no real reply has been received yet.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone_numbers: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of phone numbers to check. If empty, checks all leads that have been contacted.",
      },
      wait_seconds: {
        type: "number",
        description:
          "How many seconds to wait for a reply before returning a simulated response (default: 5, max: 15).",
      },
    },
    required: [] as string[],
  },
};

const SIMULATED_RESPONSES = [
  "Hola! Sí, tenemos disponibilidad. ¿Qué cantidad necesitas y para cuándo?",
  "Buenos días! Claro que sí, manejamos pedidos por mayor. ¿Me puede dar más detalles del pedido?",
  "Hola! Gracias por escribirnos. Sí trabajamos con pedidos grandes. El precio por unidad depende de la cantidad. ¿Cuántas unidades necesita?",
  "Buenas! Sí, hacemos envíos para eventos corporativos. ¿Para cuántas personas sería?",
  "Hola! Con gusto le ayudamos. Para pedidos de esa cantidad tenemos un precio especial. ¿Podemos agendar una llamada?",
];

function getSimulatedResponse(): string {
  return SIMULATED_RESPONSES[
    Math.floor(Math.random() * SIMULATED_RESPONSES.length)
  ];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the earliest outbound message timestamp for a contact.
 * Uses leads.json to find when we first messaged them.
 * If not in leads.json, returns null (we never messaged them).
 */
function getFirstContactTime(phone: string): string | null {
  const store = loadStore();
  const lead = store.leads.find(
    (l) => l.phone === phone || l.phoneFormatted === phone || l.phoneFormatted === `${phone}@c.us`
  );
  if (!lead) return null;

  const outbound = lead.messages.filter((m) => m.direction === "outbound");
  if (outbound.length === 0) return null;

  return outbound.reduce((earliest, m) =>
    m.timestamp < earliest ? m.timestamp : earliest,
    outbound[0].timestamp
  );
}

export async function checkWhatsappReplies(
  phoneNumbers?: string[],
  waitSeconds = 5
): Promise<string> {
  const clampedWait = Math.min(Math.max(waitSeconds, 1), 15);

  // If no numbers provided, get all contacted leads
  let numbersToCheck: string[] = phoneNumbers || [];

  if (numbersToCheck.length === 0) {
    const store = loadStore();
    numbersToCheck = store.leads
      .filter((l) => l.messages.some((m) => m.direction === "outbound"))
      .map((l) => l.phoneFormatted);
  }

  if (numbersToCheck.length === 0) {
    return JSON.stringify({
      message:
        "No contacts to check. Send a message first using send_whatsapp_message.",
      replies: [],
    });
  }

  // Format numbers for WhatsApp
  const formattedNumbers = numbersToCheck.map((n) =>
    n.includes("@c.us") ? n : formatToWhatsApp(n)
  );

  try {
    // Wait a bit for potential replies
    await sleep(clampedWait * 1000);

    // Check for real replies
    const result = await getReplies(formattedNumbers);
    const rawReplies = result.replies;

    // Filter replies: only keep messages received AFTER we first contacted them
    // This ensures we don't show old messages from before the negotiation started.
    // For numbers not in leads.json (no outbound recorded), include all messages
    // but warn that the contact isn't tracked.
    const filteredReplies: Record<string, { body: string; timestamp: string }[]> = {};
    const untrackedNumbers: string[] = [];

    for (const num of formattedNumbers) {
      const rawNumber = num.replace("@c.us", "");
      const firstContact = getFirstContactTime(rawNumber);

      if (!firstContact) {
        // Never messaged this number via send_whatsapp_message
        // But if there are real replies (manual/test scenario), still show them
        const msgs = rawReplies[num];
        if (msgs && msgs.length > 0) {
          filteredReplies[num] = msgs;
          untrackedNumbers.push(rawNumber);
        }
        continue;
      }

      const contactTimeMs = new Date(firstContact).getTime();
      const msgs = rawReplies[num];
      if (msgs && msgs.length > 0) {
        const newMsgs = msgs.filter((m) => {
          const msgTime = new Date(m.timestamp).getTime();
          return msgTime >= contactTimeMs - 5000; // 5s buffer for clock skew
        });
        if (newMsgs.length > 0) {
          filteredReplies[num] = newMsgs;
        }
      }
    }

    const hasRealReplies = Object.keys(filteredReplies).length > 0;

    if (hasRealReplies) {
      // Log real replies to store
      for (const [sender, messages] of Object.entries(filteredReplies)) {
        for (const msg of messages) {
          addMessage(sender, {
            direction: "inbound",
            body: msg.body,
            timestamp: msg.timestamp,
          });
        }
      }

      const extra = untrackedNumbers.length > 0
        ? ` (${untrackedNumbers.length} numbers are not in leads yet — replies shown anyway)`
        : "";

      return JSON.stringify({
        message: `Received real replies from ${Object.keys(filteredReplies).length} contact(s).${extra}`,
        replies: filteredReplies,
        simulated: false,
        filterNote: "Only showing replies received after the first outbound message was sent to each contact.",
      });
    }

    // No real replies — return simulated response for demo
    const simulatedReplies: Record<
      string,
      { body: string; timestamp: string; simulated: boolean }[]
    > = {};

    for (const num of formattedNumbers) {
      const simResponse = getSimulatedResponse();
      simulatedReplies[num] = [
        {
          body: simResponse,
          timestamp: new Date().toISOString(),
          simulated: true,
        },
      ];

      // Log simulated reply to store
      addMessage(num, {
        direction: "inbound",
        body: simResponse,
        timestamp: new Date().toISOString(),
        simulated: true,
      });
    }

    return JSON.stringify({
      message: `No real replies received yet after ${clampedWait}s. Returning simulated business responses for demo purposes.`,
      replies: simulatedReplies,
      simulated: true,
      note: "In production, real replies would appear here. Simulated responses are flagged with simulated: true.",
    });
  } catch (err) {
    return JSON.stringify({
      error: `Failed to check replies: ${String(err)}`,
      hint: "Make sure the WhatsApp sidecar is running.",
    });
  }
}
