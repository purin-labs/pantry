/** JSON.parse accepts repeated keys; provider answers must have one interpretation. */
export function parseSystemOneJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const containers: Array<Set<string> | null> = [];
  const tokens = text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]/g);
  for (const token of tokens) {
    switch (token[0]) {
      case "{":
        containers.push(new Set());
        break;
      case "[":
        containers.push(null);
        break;
      case "}":
      case "]":
        containers.pop();
        break;
      default: {
        if (!token[0].startsWith('"')) break;
        const following = text.slice(token.index + token[0].length).trimStart();
        if (!following.startsWith(":")) break;
        const keys = containers[containers.length - 1];
        const key: unknown = JSON.parse(token[0]);
        if (keys === null || keys === undefined || typeof key !== "string") {
          throw new Error("typesafe_response_invalid");
        }
        if (keys.has(key)) throw new Error("typesafe_response_duplicate_key");
        keys.add(key);
      }
    }
  }
  return value;
}
