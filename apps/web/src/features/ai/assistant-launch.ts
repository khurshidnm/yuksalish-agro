export interface AssistantRequest {
  /** The question to put to the assistant. */
  text: string;
}

type Listener = (request: AssistantRequest) => void;

let listener: Listener | null = null;

/** Opens the assistant from anywhere and asks `text`. The launcher in the shell owns the sheet. */
export function openAssistant(request: AssistantRequest) {
  listener?.(request);
}

export function onAssistantRequest(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
