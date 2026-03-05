export function isValidPhrase(phrase: string): boolean {
  return /^[a-z]+-[a-z]+$/.test(phrase) && phrase.length >= 6 && phrase.length <= 40;
}

export function formatPhraseForDisplay(phrase: string): string {
  return phrase
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" \u00B7 ");
  // e.g. "Golden · Harbor"
}
