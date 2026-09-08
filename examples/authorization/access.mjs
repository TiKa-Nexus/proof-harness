// This tiny application's rule belongs to the consumer, not the harness.
export function canReadDocument(actor, document) {
  return actor.workspaceId === document.workspaceId;
}
