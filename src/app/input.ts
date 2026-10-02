import { signal } from '@preact/signals';
import { isTyping } from '../viewer/typing';

/** The explorer (flying, looking, filming) or the world editor. */
export type Workspace = 'explore' | 'edit';

/** Which workspace has the screen. */
export const workspace = signal<Workspace>('explore');

/** Handles a key; true when it used it (then nothing else sees it). */
export type KeyHandler = (e: KeyboardEvent) => boolean | void;

interface Binding {
	scope: Workspace | 'both';
	handler: KeyHandler;
	/** Whether it also hears keys typed into text boxes. */
	typing: boolean;
}

const bindings: Binding[] = [];

/**
 * Registers keys for a workspace, or for both. The active workspace's handlers go first (in the
 * order they were added), then those for both. A handler that uses a key stops it there, so the
 * camera's own key tracking never sees it either. Returns a function that removes the binding.
 */
export function bindKeys(scope: Workspace | 'both', handler: KeyHandler, options: { typing?: boolean } = {}): () => void {
	const binding: Binding = { scope, handler, typing: options.typing ?? false };
	bindings.push(binding);
	return () => {
		const i = bindings.indexOf(binding);
		if (i >= 0) bindings.splice(i, 1);
	};
}

// One listener, ahead of everything else on the page.
window.addEventListener('keydown', (e) => {
	// A dialog (a question, a name to type) keeps its keys to itself.
	if ((e.target as Element | null)?.closest?.('[aria-modal="true"]')) return;
	const typing = isTyping(e);
	const active = workspace.value;
	for (const scope of [active, 'both'] as const) {
		for (const b of bindings) {
			if (b.scope !== scope || (typing && !b.typing)) continue;
			if (b.handler(e) === true) {
				e.preventDefault();
				e.stopImmediatePropagation();
				return;
			}
		}
	}
}, { capture: true });
