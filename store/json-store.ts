import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export interface Lead {
  id: string;
  name: string;
  address: string;
  phone: string;
  phoneFormatted: string; // WhatsApp format
  rating?: number;
  website?: string;
  placeId: string;
  messages: Message[];
  createdAt: string;
}

export interface Message {
  direction: "outbound" | "inbound";
  body: string;
  timestamp: string;
  simulated?: boolean;
}

export interface Negotiation {
  phone: string;
  phoneFormatted: string;
  businessName?: string;
  context: string;
  objective: string;
  brief: string;         // Structured negotiation brief (immutable rules)
  status: "active" | "completed" | "rejected" | "stopped";
  reason?: string;
  rounds: number;
  maxRounds: number;
  startedAt: string;
  completedAt?: string;
}

export interface StoreData {
  leads: Lead[];
  negotiations: Negotiation[];
}

const DATA_PATH = resolve(process.cwd(), "data", "leads.json");

function ensureDataDir(): void {
  const dir = dirname(DATA_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadStore(): StoreData {
  ensureDataDir();
  if (!existsSync(DATA_PATH)) {
    const initial: StoreData = { leads: [], negotiations: [] };
    writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = readFileSync(DATA_PATH, "utf-8");
  const data = JSON.parse(raw) as StoreData;
  // Ensure negotiations array exists (backward compat)
  if (!data.negotiations) {
    data.negotiations = [];
  }
  return data;
}

export function saveStore(data: StoreData): void {
  ensureDataDir();
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

export function addLeads(newLeads: Lead[]): Lead[] {
  const store = loadStore();
  for (const lead of newLeads) {
    // Avoid duplicates by placeId
    const exists = store.leads.find((l) => l.placeId === lead.placeId);
    if (!exists) {
      store.leads.push(lead);
    }
  }
  saveStore(store);
  return store.leads;
}

export function addMessage(phone: string, message: Message): Lead | null {
  const store = loadStore();
  const lead = store.leads.find(
    (l) => l.phone === phone || l.phoneFormatted === phone
  );
  if (lead) {
    lead.messages.push(message);
    saveStore(store);
    return lead;
  }
  return null;
}

export function getLeadByPhone(phone: string): Lead | null {
  const store = loadStore();
  return (
    store.leads.find(
      (l) => l.phone === phone || l.phoneFormatted === phone
    ) ?? null
  );
}

// --- Negotiation CRUD ---

export function addNegotiation(negotiation: Negotiation): Negotiation {
  const store = loadStore();
  // Remove any existing negotiation for this phone
  store.negotiations = store.negotiations.filter(
    (n) => n.phoneFormatted !== negotiation.phoneFormatted
  );
  store.negotiations.push(negotiation);
  saveStore(store);
  return negotiation;
}

export function getActiveNegotiation(phone: string): Negotiation | null {
  const store = loadStore();
  return (
    store.negotiations.find(
      (n) =>
        (n.phone === phone || n.phoneFormatted === phone) &&
        n.status === "active"
    ) ?? null
  );
}

export function updateNegotiation(
  phone: string,
  updates: Partial<Negotiation>
): Negotiation | null {
  const store = loadStore();
  const neg = store.negotiations.find(
    (n) => n.phone === phone || n.phoneFormatted === phone
  );
  if (!neg) return null;
  Object.assign(neg, updates);
  saveStore(store);
  return neg;
}

export function incrementNegotiationRounds(phone: string): number {
  const store = loadStore();
  const neg = store.negotiations.find(
    (n) => n.phone === phone || n.phoneFormatted === phone
  );
  if (!neg) return 0;
  neg.rounds += 1;
  saveStore(store);
  return neg.rounds;
}

export function getAllNegotiations(): Negotiation[] {
  const store = loadStore();
  return store.negotiations;
}
