import type { FileSource } from '../casc/source';
import { MpqArchive } from './archive';
import { IRONFORGE_MARKER } from './writer';

/**
 * A vanilla client's game files: every MPQ in its Data folder, later ones overriding earlier
 * ones as the client loads them. The base archives (dbc, model, terrain, texture, wmo...) come
 * first, then patch.MPQ, then patch-2.MPQ, patch-3.MPQ... and the letters servers use for their
 * own patches (patch-A.MPQ...), each above the last.
 */
export class MpqStorage {
	private constructor(readonly archives: { name: string; archive: MpqArchive }[]) {}

	/** Opens the client whose install folder (with Data/ in it) a source reads. */
	static async open(source: FileSource): Promise<MpqStorage> {
		const names = (await source.listDir(['Data'])).filter((n) => /\.mpq$/i.test(n));
		if (!names.length) throw new Error('No MPQ archives in Data: is this the World of Warcraft folder?');
		const archives = await Promise.all(loadOrder(names).map(async (name) => ({ name, archive: await MpqArchive.open(await source.openFile(['Data', name])) })));
		// Ironforge's own map exports are the editor's changes made into files: the editor reads
		// the world without them, and applies its changes itself.
		return new MpqStorage(archives.filter((a) => !a.archive.has(IRONFORGE_MARKER)));
	}

	/** A file by its path (case doesn't matter; / or \), from the highest archive that has it; null if none does. */
	async read(path: string): Promise<Uint8Array | null> {
		for (let i = this.archives.length - 1; i >= 0; i--) {
			const data = await this.archives[i].archive.read(path);
			if (data) return data;
		}
		return null;
	}

	has(path: string): boolean {
		return this.archives.some((a) => a.archive.has(path));
	}

	/** Every file the archives' (listfile)s name, once each (case doesn't matter). */
	async listFiles(): Promise<string[]> {
		const seen = new Map<string, string>();
		for (const { archive } of this.archives) {
			for (const name of await archive.listFiles().catch(() => [] as string[])) {
				const key = name.toLowerCase();
				if (!seen.has(key) && archive.has(name)) seen.set(key, name);
			}
		}
		return [...seen.values()];
	}
}

/** Archive names in the order the client loads them: lowest priority first. */
export function loadOrder(names: string[]): string[] {
	const rank = (name: string): [number, string] => {
		const lower = name.toLowerCase();
		if (lower === 'patch.mpq') return [1, ''];
		const patch = /^patch-(.+)\.mpq$/.exec(lower);
		// patch-2, patch-3 ... patch-10 by number, then the lettered ones (patch-A...).
		if (patch) return /^\d+$/.test(patch[1]) ? [2, patch[1].padStart(6, '0')] : [3, patch[1]];
		return [0, lower];
	};
	return [...names].sort((a, b) => {
		const [ra, ka] = rank(a);
		const [rb, kb] = rank(b);
		return ra - rb || ka.localeCompare(kb);
	});
}
