/**
 * The delivery ids of one Slack card: one notice that posts the card, and
 * updates that change the same message (`chat.update`). The Connector keeps
 * one receipt for each id, so each update names what it shows, for example
 * the state of a proposal.
 */
type CardDeliveryIds = Readonly<{
  notice(subjectId: string): string;
  update(subjectId: string, shows?: string): string;
  isCard(deliveryId: string): boolean;
  /** The notice that an update changes, if this delivery is an update. */
  noticeOfUpdate(deliveryId: string): string | null;
}>;

export function cardDeliveryIds(name: string): CardDeliveryIds {
  const notice = `${name}_notice_`;
  const update = `${name}_update_`;
  return {
    notice: (subjectId) => `${notice}${subjectId}`,
    update: (subjectId, shows) =>
      shows === undefined
        ? `${update}${subjectId}`
        : `${update}${subjectId}:${shows}`,
    isCard: (deliveryId) =>
      deliveryId.startsWith(notice) || deliveryId.startsWith(update),
    noticeOfUpdate: (deliveryId) =>
      deliveryId.startsWith(update)
        ? `${notice}${deliveryId.slice(update.length).split(":")[0]}`
        : null,
  };
}
