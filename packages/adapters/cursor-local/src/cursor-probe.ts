/** Live CLI probe: expect 4 or 2+2=4 in the model summary. */
export const CURSOR_ADAPTER_PROBE_PROMPT = "2+2 — return result only.";

export function cursorProbeMathAnswerLooksValid(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, "");
  if (/2\+2=4/i.test(compact) || /2\+2＝4/.test(compact)) return true;
  return /(?<!\d)4(?!\d)/.test(trimmed);
}
