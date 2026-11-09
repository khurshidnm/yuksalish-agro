/**
 * Decisions taken from a message: "Received" on cash handed over, "Approve" on a payment. A message
 * carries only what it is about ({ kind, id }); the module that owns it registers a handler here, says
 * which buttons still apply when the message is read, and decides again when one is pressed, as the
 * person who pressed it. A stale button can never act: the owner's own checks run every time.
 */
import { badRequest, notFound } from '../../core/errors';

export interface NotificationAction {
  kind: string;
  id: string;
}

export interface ActionButton {
  key: string;
  /** "namespace:key" in i18n, so the web and Telegram both say it in the reader's language. */
  label: string;
  tone?: 'primary' | 'danger';
  /** Pressing it asks for a short reason first. */
  needsReason?: boolean;
}

export interface ActionHandler {
  /** The buttons this reader may press now. None once it is decided, or when it is not theirs to decide. */
  buttons(id: string): Promise<ActionButton[]>;
  /** Runs as the person who pressed, inside their farm. Returns what happened, as an i18n "namespace:key". */
  run(id: string, button: string, input: { reason?: string }): Promise<{ message: string; params?: Record<string, unknown> }>;
}

const handlers = new Map<string, ActionHandler>();

/** Called by the owning module when it loads. */
export function registerAction(kind: string, handler: ActionHandler): void {
  handlers.set(kind, handler);
}

export function isActionKind(kind: string): boolean {
  return handlers.has(kind);
}

export async function buttonsFor(action: NotificationAction | null | undefined): Promise<ActionButton[]> {
  if (!action) return [];
  const handler = handlers.get(action.kind);
  return handler ? handler.buttons(action.id) : [];
}

export async function runAction(action: NotificationAction, button: string, input: { reason?: string } = {}) {
  const handler = handlers.get(action.kind);
  if (!handler) throw notFound('Action');
  const allowed = await handler.buttons(action.id);
  const chosen = allowed.find((b) => b.key === button);
  // Decided already, or not this person's to decide: the same answer either way, and nothing happens.
  if (!chosen) throw badRequest('ACTION_NOT_AVAILABLE', 'This has already been decided, or it is not yours to decide');
  if (chosen.needsReason && !input.reason?.trim()) throw badRequest('REASON_REQUIRED', 'Say why in a few words');
  return handler.run(action.id, button, input);
}
