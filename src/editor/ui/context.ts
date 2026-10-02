import type { Signal } from '@preact/signals';
import type { AsyncStorageApi } from '../../worker/protocol';
import type { HudInfo, Viewer, ViewSettings } from '../../viewer/viewer';
import type { Projects } from '../../app/projects';
import type { EditDocument } from '../document';
import type { EditorViewport } from '../viewport';

/** Everything the editor's panels work with, handed down from the page. */
export interface EditorContext {
	viewer: Viewer;
	doc: EditDocument;
	viewport: EditorViewport;
	/** Saving and opening projects. */
	projects: Projects;
	storage: AsyncStorageApi;
	/** Where the camera is, as the explorer's HUD shows it. */
	hud: Signal<HudInfo | null>;
	/** The View settings, shared with the explorer (and remembered between visits). */
	settings: { get(): ViewSettings; set(next: Partial<ViewSettings>): void };
	/** The minimap, borrowed from the explorer while editing. */
	minimap: HTMLElement;
	notify(text: string): void;
	copyLink(): void;
	screenshot(): void;
	/** Back to the explorer. */
	exit(): void;
}
