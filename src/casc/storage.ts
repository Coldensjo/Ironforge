import { decodeBlte, EncryptedError, type BlteResult } from './blte';
import { readBuildInfo, readConfig, type ProductInfo } from './config';
import { EncodingTable } from './encoding';
import { hashPath } from './jenkins96';
import { LocalIndex } from './localIndex';
import { fromHex, toHex } from './reader';
import { RootTable } from './root';
import type { FileSource, RandomAccessFile } from './source';

/** Size of the header in front of each file in a data.### archive. */
const ARCHIVE_ENTRY_HEADER = 0x1e;

export type FileStatus = 'ok' | 'unknown' | 'no-encoding' | 'not-local';

/**
 * Game files by number, as the engine reads them: the modern client's (CASC, by FileDataID) or the
 * original client's (MPQ, whose paths VanillaStorage numbers).
 */
export interface GameStorage {
	status(fdid: number): FileStatus;
	readFile(fdid: number): Promise<Uint8Array>;
	/** With allowPartial, encrypted parts are zero-filled instead of failing the read. */
	readFileWithStatus(fdid: number, allowPartial?: boolean): Promise<BlteResult>;
	/** A path's number, or null if there's no such file. */
	lookupPath(path: string): number | null;
}

export interface StorageStats {
	product: string;
	version: string;
	buildName: string;
	indexEntries: number;
	encodingPages: number;
	rootFiles: number;
	rootNamedFiles: number;
	timings: Record<string, number>;
}

export class NotLocalError extends Error {
	constructor(what: string) {
		super(`${what} is not in local storage`);
		this.name = 'NotLocalError';
	}
}

export { EncryptedError };

/** Reads files by encoding key from the data.### archives. */
class ArchiveReader {
	private readonly archives = new Map<number, Promise<RandomAccessFile>>();

	constructor(private readonly source: FileSource, readonly index: LocalIndex) {}

	async read(ekey: Uint8Array, what: string, allowPartial = false): Promise<BlteResult> {
		const entry = this.index.find(ekey);
		if (!entry) throw new NotLocalError(what);
		const archive = await this.archive(entry.archive);
		const bytes = await archive.read(entry.offset + ARCHIVE_ENTRY_HEADER, entry.size - ARCHIVE_ENTRY_HEADER);
		return decodeBlte(bytes, allowPartial);
	}

	private archive(n: number): Promise<RandomAccessFile> {
		let file = this.archives.get(n);
		if (!file) {
			file = this.source.openFile(['Data', 'data', `data.${n.toString().padStart(3, '0')}`]);
			this.archives.set(n, file);
		}
		return file;
	}
}

/** Read-only view of a local CASC storage for one product (e.g. wow_classic_beta). */
export class CascStorage implements GameStorage {
	private constructor(
		private readonly archives: ArchiveReader,
		private readonly encoding: EncodingTable,
		private readonly root: RootTable,
		readonly stats: StorageStats,
	) {}

	static listProducts(source: FileSource): Promise<ProductInfo[]> {
		return readBuildInfo(source);
	}

	static async open(source: FileSource, product: string, onProgress: (msg: string) => void = () => {}): Promise<CascStorage> {
		const timings: Record<string, number> = {};
		const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
			onProgress(label);
			const t = performance.now();
			const result = await fn();
			timings[label] = Math.round(performance.now() - t);
			return result;
		};

		const products = await readBuildInfo(source);
		const info = products.find((p) => p.product === product && p.active) ?? products.find((p) => p.product === product);
		if (!info) throw new Error(`Product ${product} is not installed`);
		const buildConfig = await readConfig(source, info.buildKey);

		const index = await time('Reading local indexes', () => loadLocalIndex(source));
		const archives = new ArchiveReader(source, index);

		const [, encodingEKey] = requireConfig(buildConfig, 'encoding');
		const encoding = await time('Reading encoding table', async () =>
			EncodingTable.parse((await archives.read(fromHex(encodingEKey), 'encoding table')).data));

		const [rootCKey] = requireConfig(buildConfig, 'root');
		const root = await time('Reading root table', async () => {
			const ekey = encoding.lookup(fromHex(rootCKey));
			if (!ekey) throw new Error('Root file missing from encoding table');
			return RootTable.parse((await archives.read(ekey, 'root table')).data);
		});

		return new CascStorage(archives, encoding, root, {
			product: info.product,
			version: info.version,
			buildName: buildConfig.get('build-name')?.join(' ') ?? '',
			indexEntries: index.entryCount,
			encodingPages: encoding.pageCount,
			rootFiles: root.fileCount,
			rootNamedFiles: root.namedCount,
			timings,
		});
	}

	/** Resolves a game path like "world/maps/azeroth/azeroth.wdt" via its root name hash. */
	lookupPath(path: string): number | null {
		const { hi, lo } = hashPath(path);
		return this.root.findByNameHash(hi, lo);
	}

	/**
	 * Picks the variant of a file to read: the first one stored locally, or failing that the
	 * best-known reason it can't be read.
	 */
	private resolve(fdid: number): { status: FileStatus; ekey?: Uint8Array; ckey?: Uint8Array } {
		const ckeys = this.root.getContentKeys(fdid);
		if (ckeys.length === 0) return { status: 'unknown' };
		let fallback: { status: FileStatus; ekey?: Uint8Array; ckey?: Uint8Array } = { status: 'no-encoding', ckey: ckeys[0] };
		for (const ckey of ckeys) {
			const ekey = this.encoding.lookup(ckey);
			if (!ekey) continue;
			if (this.archives.index.find(ekey)) return { status: 'ok', ekey, ckey };
			fallback = { status: 'not-local', ekey, ckey };
		}
		return fallback;
	}

	status(fdid: number): FileStatus {
		return this.resolve(fdid).status;
	}

	async readFile(fdid: number): Promise<Uint8Array> {
		return (await this.readFileWithStatus(fdid)).data;
	}

	/**
	 * With allowPartial, encrypted chunks are zero-filled instead of failing the read;
	 * encryptedKeys then lists the TACT keys that would be needed.
	 */
	async readFileWithStatus(fdid: number, allowPartial = false): Promise<BlteResult> {
		const { status, ekey, ckey } = this.resolve(fdid);
		if (status === 'unknown') throw new Error(`File ${fdid} is not in the root table`);
		if (!ekey) throw new Error(`File ${fdid} (${toHex(ckey!)}) is not in the encoding table`);
		return this.archives.read(ekey, `File ${fdid}`, allowPartial);
	}
}

function requireConfig(config: Map<string, string[]>, key: string): string[] {
	const value = config.get(key);
	if (!value) throw new Error(`Build config has no ${key} entry`);
	return value;
}

async function loadLocalIndex(source: FileSource): Promise<LocalIndex> {
	// Index files are named BBvvvvvvvv.idx (bucket, version); only the newest per bucket is live.
	const latest = new Map<number, { version: number; name: string }>();
	for (const name of await source.listDir(['Data', 'data'])) {
		const m = /^([0-9a-f]{2})([0-9a-f]{8})\.idx$/i.exec(name);
		if (!m) continue;
		const bucket = parseInt(m[1], 16);
		const version = parseInt(m[2], 16);
		if (bucket < 16 && (latest.get(bucket)?.version ?? -1) < version) latest.set(bucket, { version, name });
	}
	if (latest.size === 0) throw new Error('No local index files found in Data/data');

	const index = new LocalIndex();
	await Promise.all([...latest].map(async ([bucket, { name }]) => {
		const file = await source.openFile(['Data', 'data', name]);
		index.addBucket(bucket, await file.read(0, file.size));
	}));
	return index;
}
