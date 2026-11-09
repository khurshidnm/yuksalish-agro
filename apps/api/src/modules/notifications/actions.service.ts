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

/** What became of it, for a message whose buttons are gone: "Accepted · 09.11 04:29". */
export interface ActionState {
  /** "namespace:key" in i18n, like a button label. */
  label: string;
  tone?: 'success' | 'danger' | 'neutral';
  /** When it was decided, as an ISO instant, if known. */
  at?: string | null;
}

export interface ActionHandler {
  /** The buttons this reader may press now. None once it is decided, or when it is not theirs to decide. */
  buttons(id: string): Promise<ActionButton[]>;
  /**
   * What was decided, once nothing is left to press. Without it, a message with no buttons left reads
   * "answered": so a handler whose reader may have no buttons while it is still open must say otherwise.
   */
  state?(id: string): Promise<ActionState | null>;
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

/** The fallback state of a message whose buttons are gone. */
export const ANSWERED: ActionState = { label: 'alerts:inbox.answered', tone: 'neutral' };

/**
 * The buttons a reader may press now, and, once there are none, what became of it. Without the state
 * a message keeps asking for a press ("press Received") that can no longer happen.
 */
export async function actionView(action: NotificationAction): Promise<{ buttons: ActionButton[]; state: ActionState | null }> {
  const handler = handlers.get(action.kind);
  if (!handler) return { buttons: [], state: null };
  const buttons = await handler.buttons(action.id);
  if (buttons.length > 0) return { buttons, state: null };
  return { buttons, state: handler.state ? await handler.state(action.id) : ANSWERED };
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
