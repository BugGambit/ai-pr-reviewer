/**
 * Repairs a truncated JSON document so the fields that have already arrived can
 * be read while the rest is still streaming. Walks the text tracking string and
 * bracket state, drops any half-written trailing token, then closes whatever is
 * still open.
 *
 * Never throws and never reports a value for a field that hasn't finished
 * arriving — a half-streamed string is simply absent rather than wrong.
 */
export function parsePartialJson<T = Record<string, unknown>>(text: string): Partial<T> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  const body = text.slice(start);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  /** Index just past the last structurally complete value. */
  let safeEnd = -1;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (stack[stack.length - 1] === "]") safeEnd = i + 1;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      safeEnd = i + 1;
    } else if (ch === ",") {
      safeEnd = i;
    }
  }

  const candidates = [body + closersFor(body)];
  if (safeEnd > 0) {
    const cut = body.slice(0, safeEnd).replace(/,\s*$/, "");
    candidates.push(cut + closersFor(cut));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as Partial<T>;
    } catch {
      /* try the next repair */
    }
  }
  return null;
}

/** Computes the closing sequence needed to balance an arbitrary JSON prefix. */
function closersFor(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return (inString ? '"' : "") + stack.reverse().join("");
}
