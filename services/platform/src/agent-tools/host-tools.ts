/**
 * What the tools of a host with its own registry share: the mailbox agent and
 * the WhatsApp agent (Refactor 17, step A1.5). Such a tool gets the input text
 * of the call as it is and checks it itself, so `decode` changes nothing. The
 * host's turn holds the whole authority of its tools: a call claims no
 * capability.
 */
export function hostTool(host: string) {
  return {
    decodeOnly: true,
    // The executor gives the input text of the call (`ToolHostProfile`).
    decode: (input: unknown): string => String(input),
    selection: { kind: "host", host },
    unavailable: `This tool needs the ${host} host`,
  } as const;
}

/**
 * The outcome of a repeated call is not proven, as before these tools had a
 * definition: Pi does not run one again after a lost process.
 */
export const CAPABILITY_FREE_RERUN = { kind: "none" } as const;
