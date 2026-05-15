/**
 * Formats a phone number to WhatsApp's required format: XXXXXXXXXXX@c.us
 * Strips +, spaces, dashes, parentheses and ensures international format.
 */
export function formatToWhatsApp(phone: string, defaultCountryCode = "54"): string {
  // Strip all non-numeric characters
  let cleaned = phone.replace(/\D/g, "");

  // If it starts with 0, assume local number — prepend country code
  if (cleaned.startsWith("0")) {
    cleaned = defaultCountryCode + cleaned.slice(1);
  }

  // If it's too short to be international, prepend country code
  if (cleaned.length <= 10) {
    cleaned = defaultCountryCode + cleaned;
  }

  return `${cleaned}@c.us`;
}

/**
 * Extracts the raw number from a WhatsApp ID (removes @c.us)
 */
export function extractNumber(whatsappId: string): string {
  return whatsappId.replace("@c.us", "");
}
