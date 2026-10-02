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
});
