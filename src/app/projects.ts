import { signal } from '@preact/signals';
import type { EditDocument } from '../editor/document';
import type { Viewer } from '../viewer/viewer';
import { desktop } from './desktop';
import { ask } from './dialog';
import {
	parseProject, PROJECT_FORMAT, readSession, setNext, storeProject, useProject, writeSession, type ProjectFile, type Session,
} from './project';

/** The project's name for menus and the title: with a star while it has unsaved changes. */
export const projectTitle = signal('');

/**
 * Saving and opening projects, from the menus and keys: Save writes where the project was saved
 * (its file in the desktop app, the browser's list otherwise), Save As asks where; New, Open and
 * Close go through the launcher (the page reloads into the chosen project's world).
 */
export class Projects {
	/** Set once leaving is agreed, so the page's own reload doesn't ask again. */
	private leaving = false;

	constructor(private readonly viewer: Viewer, private readonly doc: EditDocument) {
		this.showTitle();
		window.addEventListener('beforeunload', (e) => {
			if (this.leaving || !readSession()?.dirty) return;
			e.preventDefault();
			e.returnValue = '';
		});
	}

	/** Call once the edits have loaded: every change after that is unsaved until the next save. */
	watch(): void {
		let first = true;
		this.doc.version.subscribe(() => {
			if (first) {
				first = false;
				return;
			}
			const session = readSession();
			if (!session || session.dirty) return;
			writeSession({ ...session, dirty: true });
			this.showTitle();
		});
	}

	get session(): Session | null {
		return readSession();
	}

	/** The project as a file: its world, the camera, and every edit. */
	private file(name: string, world: Session['world']): ProjectFile {
		const { edits, terrain, paint, water } = JSON.parse(this.doc.exportJson()) as Pick<ProjectFile, 'edits' | 'terrain' | 'paint' | 'water'>;
		const link = this.viewer.shareLink();
		const view = link.includes('#') ? link.slice(link.indexOf('#')) : undefined;
		return { format: PROJECT_FORMAT, version: 1, name, world, view, edits, terrain: terrain ?? {}, paint: paint ?? {}, water: water ?? {}, saved: new Date().toISOString() };
	}

	/** Saves the project where it was saved before, or (as, or never saved) where the user picks. */
	async save(as = false): Promise<boolean> {
		const session = readSession();
		if (!session) return false;
		if (desktop) {
			const path = await desktop.saveProject(as ? null : session.path ?? null, session.name, JSON.stringify(this.file(session.name, session.world)));
			if (!path) return false;
			// Saved under a new name: the project takes the file's.
			const name = as ? path.split(/[\\/]/).pop()!.replace(/\.ironforge$/i, '') : session.name;
			writeSession({ ...session, name, path, dirty: false });
		} else {
			let name = session.stored ?? session.name;
			if (as || !session.stored) {
				const answer = await ask({ title: as ? 'Save project as' : 'Save project', message: 'Saved in this browser, under a name:', input: session.name, buttons: ['Save', 'Cancel'] });
				if (answer.button !== 0 || !answer.value) return false;
				name = answer.value;
			}
			await storeProject(this.file(name, session.world));
			writeSession({ ...session, name, stored: name, dirty: false });
		}
		this.showTitle();
		return true;
	}

	/**
	 * Before leaving the project (New, Open, Close): with unsaved changes, asks whether to save
	 * them first. False if the user would rather stay.
	 */
	private async readyToLeave(): Promise<boolean> {
		const session = readSession();
		if (!session?.dirty) return true;
		const answer = await ask({ title: 'Unsaved changes', message: `Save the changes to ${session.name} first?`, buttons: ['Save', 'Don\'t save', 'Cancel'] });
		if (answer.button === 2) return false;
		if (answer.button === 0) return this.save();
		return true;
	}

	/** Back to the launcher (to start a new project, open another, or carry on). */
	async close(): Promise<void> {
		if (!(await this.readyToLeave())) return;
		this.reload('launcher');
	}

	/** Opens a project file (the desktop app's dialog, or the browser's file picker) and reloads into it. */
	async open(): Promise<void> {
		if (!(await this.readyToLeave())) return;
		let opened: { file: ProjectFile; path?: string } | null = null;
		try {
			if (desktop) {
				const result = await desktop.openProject();
				if (result) opened = { file: parseProject(result.text), path: result.path };
			} else {
				const text = await pickFile('.ironforge,.json');
				if (text !== null) opened = { file: parseProject(text) };
			}
		} catch (e) {
			await ask({ title: 'Can\'t open that', message: (e as Error).message, buttons: ['OK'] });
			return;
		}
		if (!opened) return;
		await useProject(opened.file, { path: opened.path });
		this.reload('continue');
	}

	private reload(next: 'continue' | 'launcher'): void {
		this.leaving = true;
		setNext(next);
		location.reload();
	}

	private showTitle(): void {
		const session = readSession();
		projectTitle.value = session ? `${session.name}${session.dirty ? ' *' : ''}` : '';
		document.title = session ? `${projectTitle.value} — Ironforge` : 'Ironforge';
	}
}

/** The browser's file picker for one file; its text, or null if none was chosen. */
export function pickFile(accept: string): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = accept;
		input.addEventListener('change', () => void (input.files?.[0]?.text() ?? Promise.resolve(null)).then(resolve));
		input.addEventListener('cancel', () => resolve(null));
		input.click();
	});
}
