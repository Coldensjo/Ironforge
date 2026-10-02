// Finds the World of Warcraft install on this computer, and says what of it may be served: for
// the dev server (tools/wowFiles.ts) and the desktop app (electron/main.ts), which both hand it
// to the page under __wow/. WOW_DIR=<folder> picks the install; otherwise it's looked up in the
// registry and the usual folders on Windows, and in the Wine prefixes of Lutris, Bottles, Steam
// (Proton) and Heroic on Linux.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const UNINSTALL_KEYS = [
	'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
	'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
const BLIZZARD_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft';
const USUAL_FOLDERS = ['Program Files (x86)\\World of Warcraft', 'Program Files\\World of Warcraft', 'World of Warcraft', 'Games\\World of Warcraft'];

/** The install root at or up to two folders above a path (InstallPath names _classic_\ and the like). */
export function installRoot(path: string): string | null {
	let dir = resolve(path);
	for (let up = 0; up < 3; up++) {
		if (existsSync(join(dir, '.build.info')) && existsSync(join(dir, 'Data', 'data'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** A registry value under every subkey of a key whose name contains "World of Warcraft" (or the key itself). */
function registryValues(key: string, value: string): string[] {
	let output: string;
	try {
		output = execFileSync('reg', ['query', key, '/s', '/v', value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return [];
	}
	const found: string[] = [];
	let current = '';
	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith('HKEY_')) current = line;
		const match = line.match(new RegExp(`^\\s+${value}\\s+REG_SZ\\s+(.+)$`));
		if (match && current.includes('World of Warcraft')) found.push(match[1].trim());
	}
	return found;
}

/** Folders in a folder, or none if it can't be read. */
function subfolders(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

/** Wine prefixes on Linux: WINEPREFIX, ~/.wine, and those Lutris, Bottles, Steam (Proton) and Heroic make. */
function winePrefixes(): string[] {
	const home = homedir();
	const data = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
	const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
	const prefixes = [process.env.WINEPREFIX ?? '', join(home, '.wine'), ...subfolders(join(home, 'Games')), ...subfolders(join(home, 'Games', 'Heroic', 'Prefixes'))];
	// Lutris keeps each game's prefix in its game file.
	for (const dir of [join(config, 'lutris', 'games'), join(data, 'lutris', 'games'), join(home, '.var', 'app', 'net.lutris.Lutris', 'config', 'lutris', 'games'), join(home, '.var', 'app', 'net.lutris.Lutris', 'data', 'lutris', 'games')]) {
		try {
			for (const name of readdirSync(dir).filter((name) => name.endsWith('.yml'))) {
				const match = readFileSync(join(dir, name), 'utf8').match(/^\s*prefix:\s*['"]?(.+?)['"]?\s*$/m);
				if (match) prefixes.push(match[1].replace(/^~(?=\/)/, home));
			}
		} catch {
			// No Lutris here, or a game file that can't be read.
		}
	}
	for (const bottles of [join(data, 'bottles', 'bottles'), join(home, '.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'bottles')]) {
		prefixes.push(...subfolders(bottles));
	}
	for (const steam of [join(home, '.steam', 'steam'), join(data, 'Steam'), join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')]) {
		prefixes.push(...subfolders(join(steam, 'steamapps', 'compatdata')).map((dir) => join(dir, 'pfx')));
	}
	return [...new Set(prefixes.filter((prefix) => prefix && existsSync(join(prefix, 'drive_c'))).map((prefix) => resolve(prefix)))];
}

/** Where a prefix's registry (system.reg) says World of Warcraft is, as Linux paths through its drive letters. */
function wineRegistryPaths(prefix: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(prefix, 'system.reg'), 'utf8');
	} catch {
		return [];
	}
	const found: string[] = [];
	let section = '';
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('[')) section = line;
		const match = line.match(/^"(?:InstallPath|InstallLocation)"="(.+)"$/);
		if (!match || !section.includes('World of Warcraft')) continue;
		const windowsPath = match[1].replace(/\\\\/g, '\\');
		const drive = windowsPath.match(/^([A-Za-z]):\\(.*)$/);
		if (drive) found.push(join(prefix, 'dosdevices', `${drive[1].toLowerCase()}:`, ...drive[2].split('\\').filter(Boolean)));
	}
	return found;
}

function linuxCandidates(): string[] {
	return winePrefixes().flatMap((prefix) => [
		...wineRegistryPaths(prefix),
		...USUAL_FOLDERS.map((folder) => join(prefix, 'drive_c', ...folder.split('\\'))),
	]);
}

export function findWow(): string | null {
	if (process.env.WOW_DIR) return installRoot(process.env.WOW_DIR);
	let candidates: string[];
	if (process.platform === 'win32') {
		candidates = [
			...UNINSTALL_KEYS.flatMap((key) => registryValues(key, 'InstallLocation')),
			...registryValues(BLIZZARD_KEY, 'InstallPath'),
			...'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').flatMap((drive) => USUAL_FOLDERS.map((folder) => `${drive}:\\${folder}`)),
		];
	} else if (process.platform === 'linux') {
		candidates = linuxCandidates();
	} else {
		return null;
	}
	for (const candidate of candidates) {
		const root = installRoot(candidate);
		if (root) return root;
	}
	return null;
}

/**
 * What a request under __wow/ asks for (relative to the install): a folder's listing (paths ending
 * in /), a file and its size, or null for anything else. Only what the storage reader needs, and
 * nothing outside the install.
 */
export function wowRequest(root: string, relative: string): { kind: 'list'; names: string[] } | { kind: 'file'; path: string; size: number } | null {
	const allowed = relative === '.build.info' || /^data\//i.test(relative);
	if (!allowed || relative.includes('..') || relative.includes('\\')) return null;
	const path = join(root, relative);
	if (!existsSync(path)) return null;
	const stat = statSync(path);
	if (relative.endsWith('/')) return stat.isDirectory() ? { kind: 'list', names: readdirSync(path) } : null;
	return stat.isFile() ? { kind: 'file', path, size: stat.size } : null;
}

/** A Range header's bytes (inclusive) for a file of a size; null for the whole file, 'bad' if it can't be met. */
export function byteRange(header: string | null | undefined, size: number): [number, number] | null | 'bad' {
	const range = header?.match(/^bytes=(\d+)-(\d*)$/);
	if (!range) return null;
	const start = Number(range[1]);
	const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
	return start >= size || start > end ? 'bad' : [start, end];
}
