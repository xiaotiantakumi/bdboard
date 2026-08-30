/** Return text unchanged when length <= maxLength; otherwise keep only the first maxLength characters. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}
