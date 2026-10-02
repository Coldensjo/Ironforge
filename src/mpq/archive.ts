import { unzlibSync } from 'fflate';
import type { RandomAccessFile } from '../casc/source';
import { decrypt, HASH_FILE_KEY, HASH_NAME_A, HASH_NAME_B, HASH_OFFSET, hashString } from './crypto';

const SIGNATURE = 0x1a51504d; // 'MPQ\x1a'
const USER_DATA = 0x1b51504d; // 'MPQ\x1b': a header stub pointing on to the archive
const HASH_EMPTY = 0xffffffff;
const HASH_DELETED = 0xfffffffe;

/** Block flags. */
const FILE_IMPLODE = 0x00000100;
const FILE_COMPRESS = 0x00000200;
const FILE_ENCRYPTED = 0x00010000;
const FILE_FIX_KEY = 0x00020000;
const FILE_SINGLE_UNIT = 0x01000000;
const FILE_DELETE_MARKER = 0x02000000;
const FILE_SECTOR_CRC = 0x04000000;
const FILE_EXISTS = 0x80000000;

/** The first byte of a compressed sector says how it's compressed. */
const COMPRESSION_ZLIB = 0x02;
const COMPRESSION_NAMES: Record<number, string> = {
	0x01: 'Huffman', 0x08: 'PKWARE implode', 0x10: 'bzip2', 0x12: 'LZMA', 0x20: 'sparse', 0x40: 'ADPCM mono', 0x80: 'ADPCM stereo',
};

export class MpqError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MpqError';
	}
}

interface Block {
	offset: number;
	compressedSize: number;
	fileSize: number;
	flags: number;
}

/**
 * One MPQ archive (formats 1 and 2: vanilla's, and anything after that still keeps the classic
 * hash and block tables). Files are found by name; their sectors are decrypted and inflated as
 * read. Only zlib compression is handled: what the game's data files use.
 */
export class MpqArchive {
	private constructor(
		private readonly file: RandomAccessFile,
		/** Where the archive starts in the file (after any user data before it). */
		private readonly base: number,
		private readonly sectorSize: number,
		private readonly hashes: Uint32Array,
		private readonly blocks: Block[],
	) {}

	static async open(file: RandomAccessFile): Promise<MpqArchive> {
		// The header starts at 0, or at a 512-byte boundary after other data (an installer, user data).
		let base = -1;
		for (let at = 0; at < Math.min(file.size, 1 << 20) && base < 0; at += 512) {
			const head = new DataView((await file.read(at, 16)).buffer);
			const magic = head.getUint32(0, true);
			if (magic === SIGNATURE) base = at;
			else if (magic === USER_DATA) base = at + head.getUint32(8, true);
		}
		if (base < 0) throw new MpqError('Not an MPQ archive');
		const header = new DataView((await file.read(base, 44)).buffer);
		const formatVersion = header.getUint16(12, true);
		const sectorSize = 512 << header.getUint16(14, true);
		let hashPos = header.getUint32(16, true);
		let blockPos = header.getUint32(20, true);
		const hashCount = header.getUint32(24, true);
		const blockCount = header.getUint32(28, true);
		if (formatVersion >= 1) {
			// Format 2 adds the high 16 bits of the table positions (archives past 4 GB).
			hashPos += header.getUint16(40, true) * 2 ** 32;
			blockPos += header.getUint16(42, true) * 2 ** 32;
		}

		const hashBytes = await file.read(base + hashPos, hashCount * 16);
		decrypt(hashBytes, hashString('(hash table)', HASH_FILE_KEY));
		const blockBytes = await file.read(base + blockPos, blockCount * 16);
		decrypt(blockBytes, hashString('(block table)', HASH_FILE_KEY));
		const hashes = new Uint32Array(hashBytes.buffer, hashBytes.byteOffset, hashCount * 4).slice();
		const view = new DataView(blockBytes.buffer, blockBytes.byteOffset, blockBytes.byteLength);
		const blocks: Block[] = [];
		for (let i = 0; i < blockCount; i++) {
			blocks.push({ offset: view.getUint32(i * 16, true), compressedSize: view.getUint32(i * 16 + 4, true), fileSize: view.getUint32(i * 16 + 8, true), flags: view.getUint32(i * 16 + 12, true) });
		}
		return new MpqArchive(file, base, sectorSize, hashes, blocks);
	}

	/** The block for a name (the neutral locale where there are several), or null if it isn't here. */
	private find(name: string): Block | null {
		const count = this.hashes.length / 4;
		if (!count) return null;
		const a = hashString(name, HASH_NAME_A);
		const b = hashString(name, HASH_NAME_B);
		const start = hashString(name, HASH_OFFSET) & (count - 1);
		let found: Block | null = null;
		for (let n = 0, i = start; n < count; n++, i = (i + 1) & (count - 1)) {
			const blockIndex = this.hashes[i * 4 + 3];
			if (blockIndex === HASH_EMPTY) break;
			if (blockIndex === HASH_DELETED || this.hashes[i * 4] !== a || this.hashes[i * 4 + 1] !== b) continue;
			const block = this.blocks[blockIndex];
			if (!block || !(block.flags & FILE_EXISTS) || block.flags & FILE_DELETE_MARKER) continue;
			// Locale (low half of the third word) 0 is the neutral one; take it over any other.
			const locale = this.hashes[i * 4 + 2] & 0xffff;
			if (locale === 0) return block;
			found ??= block;
		}
		return found;
	}

	/** Whether the archive has a file (a patch can also hold a marker saying a file was deleted). */
	has(name: string): boolean {
		return this.find(name) !== null;
	}

	/** A file's contents, or null if the archive doesn't have it. */
	async read(name: string): Promise<Uint8Array | null> {
		const block = this.find(name);
		if (!block) return null;
		if (block.flags & FILE_IMPLODE) throw new MpqError(`${name}: PKWARE-imploded files aren't supported yet`);
		const start = this.base + block.offset;
		// Encrypted files are keyed by their base name (and, with FIX_KEY, where they are).
		let key = 0;
		if (block.flags & FILE_ENCRYPTED) {
			key = hashString(name.split(/[\\/]/).pop()!, HASH_FILE_KEY);
			if (block.flags & FILE_FIX_KEY) key = ((key + block.offset) ^ block.fileSize) >>> 0;
		}
		const compressed = (block.flags & FILE_COMPRESS) !== 0;

		if (block.flags & FILE_SINGLE_UNIT) {
			const data = await this.file.read(start, block.compressedSize);
			if (key) decrypt(data, key);
			return compressed && block.compressedSize < block.fileSize ? inflateSector(data, block.fileSize, name) : data;
		}

		const sectors = Math.ceil(block.fileSize / this.sectorSize);
		const raw = await this.file.read(start, block.compressedSize);
		// Compressed files start with a table of sector offsets (and one more for the CRCs).
		let offsets: number[];
		if (compressed) {
			const tableWords = sectors + 1 + (block.flags & FILE_SECTOR_CRC ? 1 : 0);
			const table = raw.slice(0, tableWords * 4);
			if (key) decrypt(table, (key - 1) >>> 0);
			const view = new DataView(table.buffer);
			offsets = Array.from({ length: sectors + 1 }, (_, i) => view.getUint32(i * 4, true));
		} else {
			offsets = Array.from({ length: sectors + 1 }, (_, i) => Math.min(i * this.sectorSize, block.compressedSize));
		}
		const out = new Uint8Array(block.fileSize);
		for (let i = 0; i < sectors; i++) {
			const expected = Math.min(this.sectorSize, block.fileSize - i * this.sectorSize);
			const sector = raw.slice(offsets[i], offsets[i + 1]);
			if (key) decrypt(sector, (key + i) >>> 0);
			out.set(compressed && sector.length < expected ? inflateSector(sector, expected, name) : sector.subarray(0, expected), i * this.sectorSize);
		}
		return out;
	}

	/** The archive's own list of its files, if it carries one. */
	async listFiles(): Promise<string[]> {
		const list = await this.read('(listfile)');
		if (!list) return [];
		return new TextDecoder().decode(list).split(/[\r\n;]+/).filter(Boolean);
	}
}

/** A compressed sector: its first byte says how. Only zlib for now. */
function inflateSector(sector: Uint8Array, size: number, name: string): Uint8Array {
	const method = sector[0];
	if (method === COMPRESSION_ZLIB) {
		const out = unzlibSync(sector.subarray(1));
		return out.length === size ? out : out.subarray(0, size);
	}
	const kinds = Object.entries(COMPRESSION_NAMES).filter(([bit]) => method & Number(bit)).map(([, n]) => n);
	throw new MpqError(`${name}: ${kinds.join(' + ') || `compression 0x${method.toString(16)}`} isn't supported yet`);
}
