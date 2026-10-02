/**
 * MPQ's hashing and encryption: a 0x500-word table made from a fixed seed, which names are hashed
 * with (to find files) and which the hash table, block table and some files are encrypted with.
 */
const TABLE = (() => {
	const table = new Uint32Array(0x500);
	let seed = 0x00100001;
	for (let i = 0; i < 0x100; i++) {
		for (let k = 0, j = i; k < 5; k++, j += 0x100) {
			seed = (seed * 125 + 3) % 0x2aaaab;
			const high = (seed & 0xffff) << 16;
			seed = (seed * 125 + 3) % 0x2aaaab;
			table[j] = (high | (seed & 0xffff)) >>> 0;
		}
	}
	return table;
})();

/** What a name is hashed for: its hash table slot, the two halves of its check, or its encryption key. */
export const HASH_OFFSET = 0;
export const HASH_NAME_A = 1;
export const HASH_NAME_B = 2;
export const HASH_FILE_KEY = 3;

/** A name's hash of a kind. Names are case-insensitive, with backslashes for folders. */
export function hashString(name: string, kind: number): number {
	let seed1 = 0x7fed7fed;
	let seed2 = 0xeeeeeeee;
	const upper = name.replace(/\//g, '\\').toUpperCase();
	for (let i = 0; i < upper.length; i++) {
		const c = upper.charCodeAt(i) & 0xff;
		seed1 = (TABLE[kind * 0x100 + c] ^ (seed1 + seed2)) >>> 0;
		seed2 = (c + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
	}
	return seed1;
}

/** Decrypts 32-bit little-endian words in place (a trailing partial word is left as is). */
export function decrypt(bytes: Uint8Array, key: number): void {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let k = key >>> 0;
	let seed = 0xeeeeeeee;
	for (let o = 0; o + 4 <= bytes.length; o += 4) {
		seed = (seed + TABLE[0x400 + (k & 0xff)]) >>> 0;
		const word = (view.getUint32(o, true) ^ ((k + seed) >>> 0)) >>> 0;
		view.setUint32(o, word, true);
		k = ((((~k << 21) >>> 0) + 0x11111111) >>> 0 | (k >>> 11)) >>> 0;
		seed = (word + seed + (seed << 5) + 3) >>> 0;
	}
}
