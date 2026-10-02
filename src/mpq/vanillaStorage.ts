import type { BlteResult } from '../casc/blte';
import type { FileStatus, GameStorage } from '../casc/storage';
import type { MpqStorage } from './storage';

/**
 * Numbers for the original client's files start here, far above any FileDataID, so the two can
 * never be mistaken for each other.
 */
export const VANILLA_ID_BASE = 2_000_000_000;

/**
 * The original client's files as the engine reads game files: by number. Each path is given a
 * number the first time it's asked for (case and slashes don't matter), and reads go to the MPQs.
 */
export class VanillaStorage implements GameStorage {
	private readonly ids = new Map<string, number>();
	private readonly paths: string[] = [];

	constructor(readonly mpq: MpqStorage) {}

	/** A path's number (made the first time it's asked for, whether or not the file exists). */
	idOf(path: string): number {
		const key = path.replace(/\//g, '\\').toLowerCase();
		let id = this.ids.get(key);
		if (id === undefined) {
			id = VANILLA_ID_BASE + this.paths.length;
			this.paths.push(path.replace(/\//g, '\\'));
			this.ids.set(key, id);
		}
		return id;
	}

	/** The path a number stands for, if it's one of these. */
	pathOf(id: number): string | undefined {
		return id >= VANILLA_ID_BASE ? this.paths[id - VANILLA_ID_BASE] : undefined;
	}

	lookupPath(path: string): number | null {
		return this.mpq.has(path) ? this.idOf(path) : null;
	}

	status(id: number): FileStatus {
		const path = this.pathOf(id);
		return path && this.mpq.has(path) ? 'ok' : 'unknown';
	}

	async readFile(id: number): Promise<Uint8Array> {
		const path = this.pathOf(id);
		const data = path ? await this.mpq.read(path) : null;
		if (!data) throw new Error(`File ${path ?? id} is not in the client's archives`);
		return data;
	}

	async readFileWithStatus(id: number): Promise<BlteResult> {
		return { data: await this.readFile(id), encryptedKeys: [] };
	}
}
