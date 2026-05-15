import { config } from "dotenv";
import { addLeads, type Lead } from "../store/json-store.js";
import { formatToWhatsApp } from "../utils/phone-formatter.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

export const findLocalBusinessDefinition = {
  name: "find_local_business",
  description:
    "Search for local businesses using LocationIQ or Google Places. Returns business names, addresses, and phone numbers (when available). Results are saved to the local leads database for later use with WhatsApp messaging tools. Use queries like 'bakeries in Buenos Aires' or 'catering services near downtown Caracas'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Search query including business type and location, e.g. 'bakeries in Buenos Aires' or 'florists near Palermo, Buenos Aires'",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (1-10, default 5)",
      },
    },
    required: ["query"],
  },
};

// ─── Google Places (New API) ──────────────────────────────────────────────────

interface GooglePlaceResult {
  id: string;
  displayName: { text: string };
  formattedAddress: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  websiteUri?: string;
  primaryType?: string;
}

async function googleTextSearch(query: string, maxResults: number): Promise<GooglePlaceResult[]> {
  const url = "https://places.googleapis.com/v1/places:searchText";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.nationalPhoneNumber,places.rating,places.websiteUri,places.primaryType",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: maxResults }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Places API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { places?: GooglePlaceResult[] };
  return data.places || [];
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function findLocalBusiness(
  query: string,
  maxResults = 5
): Promise<string> {
  const clampedMax = Math.min(Math.max(maxResults, 1), 10);

  // ── Google Places (New API, phones included in single call) ──
  if (GOOGLE_KEY) {
    try {
      const places = await googleTextSearch(query, clampedMax);

      if (places.length === 0) {
        return JSON.stringify({
          message: "No businesses found for that query. Try a different search term or location.",
          query,
          businesses: [],
          provider: "google",
        });
      }

      const leads: Lead[] = [];
      const skipped: string[] = [];

      for (const p of places) {
        const phone = p.internationalPhoneNumber || p.nationalPhoneNumber || "";

        if (!phone) {
          skipped.push(`${p.displayName.text} (no phone)`);
          continue;
        }

        leads.push({
          id: p.id,
          name: p.displayName.text,
          address: p.formattedAddress,
          phone,
          phoneFormatted: formatToWhatsApp(phone),
          rating: p.rating,
          website: p.websiteUri,
          placeId: p.id,
          messages: [],
          createdAt: new Date().toISOString(),
        });
      }

      if (leads.length > 0) {
        addLeads(leads);
      }

      return JSON.stringify({
        message: `Found ${leads.length} businesses with phone numbers.${skipped.length > 0 ? ` ${skipped.length} skipped (no phone).` : ""}`,
        query,
        provider: "google",
        businesses: leads.map((l) => ({
          name: l.name,
          address: l.address,
          phone: l.phone,
          rating: l.rating,
          website: l.website,
        })),
        skipped: skipped.length > 0 ? skipped : undefined,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Google Places search failed: ${String(err)}`,
      });
    }
  }

  // ── No key at all ──
  return JSON.stringify({
    error:
      "No GOOGLE_PLACES_API_KEY configured. Ask the user for the business phone number directly, then use send_whatsapp_message or start_negotiation with that number.",
  });
}
