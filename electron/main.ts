// The desktop app: Ironforge in its own window. The page and the World of Warcraft install are
// both served from app://ironforge/ (the install under __wow/, as the dev server and the portable
// launcher serve it), so the page finds the game by itself. The page asks for the few things a
// browser can't do through the preload script: choosing the game folder, saving and opening files.
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { byteRange, findWow, installRoot, wowRequest } from './wowInstall.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The built page (vite build), beside this compiled file's folder. */
const WEB_ROOT = resolve(HERE, '..', 'dist');
/** Set by npm run desktop:dev: the page comes from the Vite dev server instead, with live reloading. */
const DEV_URL = process.env.IRONFORGE_DEV_URL;
const ORIGIN = 'app://ironforge/';

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
	'.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

// app:// behaves like https: fetch, workers, IndexedDB and range requests all work on it.
protocol.registerSchemesAsPrivileged([
	{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// --- Settings (the game folder, once chosen) ---

interface Settings {
	wowDir?: string;
	/** Project files opened or saved lately, newest first. */
	recent?: string[];
}

/** Project files remembered as recent. */
const RECENT_LIMIT = 12;
const PROJECT_FILTER = { name: 'Ironforge project', extensions: ['ironforge'] };

function rememberRecent(path: string): void {
	const settings = readSettings();
	settings.recent = [path, ...(settings.recent ?? []).filter((p) => p !== path)].slice(0, RECENT_LIMIT);
	saveSettings(settings);
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

function readSettings(): Settings {
	try {
		return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings;
	} catch {
		return {};
	}
}

function saveSettings(settings: Settings): void {
	try {
		writeFileSync(settingsFile(), JSON.stringify(settings, null, '\t'));
	} catch (e) {
		console.warn('Settings not saved:', e);
	}
}

/** The install: the folder chosen before, if it's still there, else whatever can be found. */
let wowRoot: string | null = null;

function locateWow(): void {
	const chosen = readSettings().wowDir;
	wowRoot = (chosen && installRoot(chosen)) || findWow();
}

// --- Serving ---

function notFound(): Response {
	return new Response(null, { status: 404 });
}

/** A file of the install, or a folder's listing, with byte ranges as the storage reader asks for them. */
function serveWow(relative: string, request: Request): Response {
	const found = wowRoot ? wowRequest(wowRoot, relative) : null;
	if (!found) return notFound();
	if (found.kind === 'list') return new Response(found.names.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
	const range = byteRange(request.headers.get('Range'), found.size);
	if (range === 'bad') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${found.size}` } });
	const [start, end] = range ?? [0, found.size - 1];
	const headers: Record<string, string> = {
		'Content-Type': 'application/octet-stream',
		'Accept-Ranges': 'bytes',
		'Content-Length': String(end - start + 1),
		'Cache-Control': 'no-cache',
	};
	if (range) headers['Content-Range'] = `bytes ${start}-${end}/${found.size}`;
	const body = request.method === 'HEAD' || found.size === 0 ? null : (Readable.toWeb(createReadStream(found.path, { start, end })) as ReadableStream);
	return new Response(body, { status: range ? 206 : 200, headers });
}

/** The built page's files; nothing outside them. */
function serveWeb(pathname: string): Response {
	const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
	const path = resolve(WEB_ROOT, relative);
	if (!path.startsWith(WEB_ROOT + sep) || !existsSync(path) || !statSync(path).isFile()) return notFound();
	return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
		headers: { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' },
	});
}

// --- The page's requests (see preload.cts) ---

ipcMain.handle('wow:choose', async (event) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	const options: Electron.OpenDialogOptions = { title: 'Choose your World of Warcraft folder', properties: ['openDirectory'] };
	const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
	if (result.canceled || !result.filePaths[0]) return false;
	const root = installRoot(result.filePaths[0]);
	if (!root) return false;
	wowRoot = root;
	saveSettings({ ...readSettings(), wowDir: root });
	return true;
});

ipcMain.handle('file:save', async (event, name: string, text: string) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	const options: Electron.SaveDialogOptions = { title: 'Save', defaultPath: name, filters: [{ name: 'Ironforge edits', extensions: ['json'] }] };
	const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
	if (result.canceled || !result.filePath) return null;
	writeFileSync(result.filePath, text);
	return result.filePath;
});

ipcMain.handle('file:open', async (event) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	const options: Electron.OpenDialogOptions = { title: 'Open', properties: ['openFile'], filters: [{ name: 'Ironforge edits', extensions: ['json'] }] };
	const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
	const path = result.filePaths[0];
	if (result.canceled || !path) return null;
	return { name: path.split(/[\\/]/).pop() ?? path, text: readFileSync(path, 'utf8') };
});

ipcMain.handle('project:save', async (event, path: string | null, name: string, text: string) => {
	let target = path;
	if (!target) {
		const window = BrowserWindow.fromWebContents(event.sender);
		const options: Electron.SaveDialogOptions = { title: 'Save project', defaultPath: `${name}.ironforge`, filters: [PROJECT_FILTER] };
		const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) return null;
		target = result.filePath;
	}
	writeFileSync(target, text);
	rememberRecent(target);
	return target;
});

ipcMain.handle('project:open', async (event) => {
	const window = BrowserWindow.fromWebContents(event.sender);
	const options: Electron.OpenDialogOptions = { title: 'Open project', properties: ['openFile'], filters: [PROJECT_FILTER] };
	const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
	const path = result.filePaths[0];
	if (result.canceled || !path) return null;
	rememberRecent(path);
	return { path, text: readFileSync(path, 'utf8') };
});

ipcMain.handle('project:read', (_event, path: string) => {
	if (!existsSync(path)) return null;
	rememberRecent(path);
	return { path, text: readFileSync(path, 'utf8') };
});

/** Recent project files that still exist, with when each was last saved. */
ipcMain.handle('project:recent', () => (readSettings().recent ?? []).filter((p) => existsSync(p)).map((path) => ({
	path,
	name: basename(path, extname(path)),
	modified: statSync(path).mtime.toISOString(),
})));

// --- The window ---

function createWindow(): void {
	const window = new BrowserWindow({
		width: 1600,
		height: 900,
		show: false,
		title: 'Ironforge',
		backgroundColor: '#0d0f12',
		icon: join(WEB_ROOT, 'icon.png'),
		webPreferences: {
			preload: join(HERE, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	// The page has its own menus.
	window.setMenu(null);
	window.once('ready-to-show', () => {
		window.maximize();
		window.show();
	});
	// Links (Wowhead) open in the browser; the window itself never leaves the app.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) void shell.openExternal(url);
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (!url.startsWith(DEV_URL ?? ORIGIN)) {
			event.preventDefault();
			if (/^https?:/.test(url)) void shell.openExternal(url);
		}
	});
	// Closing (or reloading) with unsaved changes: the page says so (beforeunload), and this asks.
	window.webContents.on('will-prevent-unload', (event) => {
		const choice = dialog.showMessageBoxSync(window, {
			type: 'question',
			buttons: ['Leave without saving', 'Stay'],
			defaultId: 1,
			cancelId: 1,
			title: 'Unsaved changes',
			message: 'This project has changes that aren\'t saved.',
			detail: 'Leave anyway, and lose them?',
		});
		if (choice === 0) event.preventDefault();
	});
	// F12: the developer tools, F5: reload (there's no browser to do either).
	window.webContents.on('before-input-event', (_event, input) => {
		if (input.type !== 'keyDown') return;
		if (input.key === 'F12') window.webContents.toggleDevTools();
		else if (input.key === 'F5') window.webContents.reload();
	});
	void window.loadURL(DEV_URL ?? `${ORIGIN}index.html`);
}

app.whenReady().then(() => {
	locateWow();
	protocol.handle('app', (request) => {
		const url = new URL(request.url);
		const pathname = decodeURIComponent(url.pathname);
		return pathname.startsWith('/__wow/') ? serveWow(pathname.slice('/__wow/'.length), request) : serveWeb(pathname);
	});
	createWindow();
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
