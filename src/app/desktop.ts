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
