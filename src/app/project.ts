import { EditStore, replaceWorkingCopy, type SpawnEdit } from '../editor/document';
import type { WorldKind } from '../viewer/viewer';

export const PROJECT_FORMAT = 'ironforge-project';
/** Project files' extension, in the desktop app's dialogs. */
export const PROJECT_EXTENSION = 'ironforge';

/** A saved project: its world, where the camera was, and every edit and ground change. */
export interface ProjectFile {
	format: typeof PROJECT_FORMAT;
	version: 1;
	name: string;
	world: WorldKind;
	/** The camera, as the page's hash (#continent/tileX/tileY/height/yaw/pitch). */
	view?: string;
	/** Spawn edits by spawn, and ground height changes by tile (base64 floats), as EditDocument exports them. */
	edits: Record<string, SpawnEdit>;
	terrain: Record<string, string>;
	/** When it was saved (ISO). */
	saved: string;
}

/**
 * The project being worked on, kept across reloads: its name and world, where it's saved (a
 * file in the desktop app, or the browser's own list), and whether it has unsaved changes.
 * The edits themselves are the browser's working copy (see EditDocument).
 */
export interface Session {
	name: string;
	world: WorldKind;
	/** Desktop app: the project file. */
	path?: string;
	/** Browser: saved in its own list of projects, under this name. */
	stored?: string;
	dirty: boolean;
}

const SESSION_KEY = 'ironforge.session';
/** Set just before the page reloads into a project (or the launcher): what to do as it comes back. */
const NEXT_KEY = 'ironforge.next';

export function readSession(): Session | null {
	try {
		const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
		return s && typeof s.name === 'string' && (s.world === 'sandbox' || s.world === 'azeroth') ? s : null;
	} catch {
		return null;
	}
}

export function writeSession(session: Session | null): void {
	try {
		if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
		else localStorage.removeItem(SESSION_KEY);
	} catch {
		// Not remembered: it lasts this visit.
	}
}

/** What the page does as it reloads: carry on with the session's project, or show the launcher. */
export function setNext(next: 'continue' | 'launcher'): void {
	try {
		sessionStorage.setItem(NEXT_KEY, next);
	} catch {
		// Without it, the launcher shows, which is safe.
	}
}

export function takeNext(): 'continue' | 'launcher' | null {
	try {
		const next = sessionStorage.getItem(NEXT_KEY);
		sessionStorage.removeItem(NEXT_KEY);
		return next === 'continue' || next === 'launcher' ? next : null;
	} catch {
		return null;
	}
}

/** Reads a project file's text; throws if it isn't one. */
export function parseProject(text: string): ProjectFile {
	const file = JSON.parse(text) as Partial<ProjectFile>;
	if (file.format !== PROJECT_FORMAT || (file.world !== 'sandbox' && file.world !== 'azeroth')) throw new Error('Not an Ironforge project');
	return { format: PROJECT_FORMAT, version: 1, name: file.name || 'Untitled', world: file.world, view: file.view, edits: file.edits ?? {}, terrain: file.terrain ?? {}, saved: file.saved ?? '' };
}

/**
 * Makes a project the working one: its edits become the working copy and the session points at
 * it. The page then loads its world (or reloads into it).
 */
export async function useProject(file: ProjectFile, where: { path?: string; stored?: string }): Promise<void> {
	await replaceWorkingCopy(file.edits, file.terrain);
	writeSession({ name: file.name, world: file.world, ...where, dirty: false });
	if (file.view) history.replaceState(null, '', file.view);
}

/** Starts a new, empty project in a world. */
export async function newProject(name: string, world: WorldKind): Promise<void> {
	await replaceWorkingCopy({}, {});
	writeSession({ name, world, dirty: false });
	history.replaceState(null, '', location.pathname + location.search);
}

// --- The browser's own list of projects (the desktop app saves files instead) ---

const library = new EditStore<ProjectFile>('projects');

export async function storedProjects(): Promise<ProjectFile[]> {
	return (await library.all()).map(([, file]) => file).sort((a, b) => b.saved.localeCompare(a.saved));
}

export async function storeProject(file: ProjectFile): Promise<void> {
	await library.put(file.name, file);
}

export async function forgetStoredProject(name: string): Promise<void> {
	await library.put(name, undefined);
}
