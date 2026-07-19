/** Trim and ellipsis-cap free-form narrative text for display. */
export function capNarrative(text: string, max = 1800): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
