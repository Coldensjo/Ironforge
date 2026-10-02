/** What the desktop app (electron/preload.cts) adds to the page; undefined in a browser. */
export interface DesktopApi {
	/** Asks for the World of Warcraft folder; true once it's served under __wow/. */
	chooseWowFolder(): Promise<boolean>;
	/** Saves text to a file the user picks; its path, or null if they cancel. */
	saveText(name: string, text: string): Promise<string | null>;
	/** Opens a file the user picks; its name and text, or null if they cancel. */
	openText(): Promise<{ name: string; text: string } | null>;
	/** Saves a project to its file, or (path null) to one the user picks; the path, or null if they cancel. */
	saveProject(path: string | null, name: string, text: string): Promise<string | null>;
	/** Opens a project file the user picks. */
	openProject(): Promise<{ path: string; text: string } | null>;
	/** Reads a project file by its path (a recent one); null if it's gone. */
	readProject(path: string): Promise<{ path: string; text: string } | null>;
	/** Project files opened or saved lately, newest first. */
	recentProjects(): Promise<{ path: string; name: string; modified: string }[]>;
}

/** The desktop app's extras, when running in it. */
export const desktop: DesktopApi | undefined = (globalThis as { ironforge?: DesktopApi }).ironforge;

/** Saves text as a file: through a save dialog in the desktop app, as a download in a browser. */
export async function saveTextFile(name: string, text: string, type = 'application/json'): Promise<boolean> {
	if (desktop) return (await desktop.saveText(name, text)) !== null;
	const link = document.createElement('a');
	link.href = URL.createObjectURL(new Blob([text], { type }));
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	return true;
}

/** Where the map export goes in the game folder (served under __wow/; see electron/wowInstall.ts). */
const PATCH_URL = '__wow/Data/patch-3.MPQ';

/**
 * Puts the map export into the game's Data folder, where the page is served with the game (the
 * desktop app, the dev server); otherwise saves it as a download to put there by hand.
 */
export async function installPatch(archive: Uint8Array): Promise<{ written: true; path: string } | { written: false; reason: string | null }> {
	const body = new Blob([archive as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' });
	const response = await fetch(new URL(PATCH_URL, location.href), { method: 'PUT', body }).catch(() => null);
	if (response?.ok) return { written: true, path: await response.text() };
	// Refused (another patch is there): say why rather than download.
	if (response?.status === 409) return { written: false, reason: await response.text() };
	const link = document.createElement('a');
	link.href = URL.createObjectURL(body);
	link.download = 'patch-3.MPQ';
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	return { written: false, reason: null };
}
