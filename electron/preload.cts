// What the desktop app adds to the page (as window.ironforge): the few things a browser can't do.
// See src/app/desktop.ts for how the page uses it, and main.ts for the other side.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ironforge', {
	/** Asks for the World of Warcraft folder; true once it's served under __wow/. */
	chooseWowFolder: (): Promise<boolean> => ipcRenderer.invoke('wow:choose'),
	/** Saves text to a file the user picks; its path, or null if they cancel. */
	saveText: (name: string, text: string): Promise<string | null> => ipcRenderer.invoke('file:save', name, text),
	/** Opens a file the user picks; its name and text, or null if they cancel. */
	openText: (): Promise<{ name: string; text: string } | null> => ipcRenderer.invoke('file:open'),
	/** Saves a project to its file, or (path null) to one the user picks; the path, or null if they cancel. */
	saveProject: (path: string | null, name: string, text: string): Promise<string | null> => ipcRenderer.invoke('project:save', path, name, text),
	/** Opens a project file the user picks. */
	openProject: (): Promise<{ path: string; text: string } | null> => ipcRenderer.invoke('project:open'),
	/** Reads a project file by its path (a recent one); null if it's gone. */
	readProject: (path: string): Promise<{ path: string; text: string } | null> => ipcRenderer.invoke('project:read', path),
	/** Project files opened or saved lately, newest first. */
	recentProjects: (): Promise<{ path: string; name: string; modified: string }[]> => ipcRenderer.invoke('project:recent'),
});
