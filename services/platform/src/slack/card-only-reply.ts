/**
 * The reply of an agent that has nothing to add to the decision card that its
 * turn posted. The thread then shows the card alone, because a note under a
 * card can go stale when a person decides. If the text reaches a thread in any
 * other way, it stays true.
 */
export const CARD_ONLY_REPLY = "See the card above.";

/** The tool's words for the reply after a card. */
export const CARD_ONLY_REPLY_INSTRUCTION = `The card shows the decision and what happens next, so do not describe them. If the person asked for something else, give only that. Otherwise reply with exactly this text: ${CARD_ONLY_REPLY}`;
