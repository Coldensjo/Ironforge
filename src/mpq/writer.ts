import { encrypt, HASH_FILE_KEY, HASH_NAME_A, HASH_NAME_B, HASH_OFFSET, hashString } from './crypto';

/**
 * Writes MPQ archives as the 1.12 client reads them (format 1): each file stored whole and
 * uncompressed, found through the encrypted hash and block tables, with a (listfile) naming them
 * and a marker saying Ironforge made the archive (see IRONFORGE_MARKER).
 */

const HEADER_SIZE = 32;
/** 512 << 3: the sector size the game's own archives use. */
const SECTOR_SHIFT = 3;
const FILE_EXISTS = 0x80000000;
const HASH_EMPTY = 0xffffffff;

/**
 * A file in every archive Ironforge writes, so it can tell its own patches from the game's: it
 * leaves them out when reading the game (its edits are applied on top of the original world), and
 * only overwrites an archive that has it. Stored uncompressed, its text can be found in the file.
 */
export const IRONFORGE_MARKER = '(ironforge)';
export const IRONFORGE_MARKER_TEXT = 'Ironforge map export: this patch was written by Ironforge and is replaced by its next export.';

export function writeMpq(files: { name: string; data: Uint8Array }[]): Uint8Array {
	const encoder = new TextEncoder();
	const all = [...files.filter((f) => f.name !== '(listfile)' && f.name !== IRONFORGE_MARKER), { name: IRONFORGE_MARKER, data: encoder.encode(IRONFORGE_MARKER_TEXT) }];
	all.push({ name: '(listfile)', data: encoder.encode(all.map((f) => f.name.replace(/\//g, '\\')).join('\r\n') + '\r\n') });

	// Room for twice the files, a power of two as the lookup needs.
	let hashCount = 16;
	while (hashCount < all.length * 2) hashCount *= 2;
	const dataSize = all.reduce((n, f) => n + f.data.length, 0);
	const hashPos = HEADER_SIZE + dataSize;
	const blockPos = hashPos + hashCount * 16;
	const size = blockPos + all.length * 16;
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);

	view.setUint32(0, 0x1a51504d, true); // 'MPQ\x1a'
	view.setUint32(4, HEADER_SIZE, true);
	view.setUint32(8, size, true);
	view.setUint16(12, 0, true);
	view.setUint16(14, SECTOR_SHIFT, true);
	view.setUint32(16, hashPos, true);
	view.setUint32(20, blockPos, true);
	view.setUint32(24, hashCount, true);
	view.setUint32(28, all.length, true);

	const hashes = new Uint8Array(hashCount * 16);
	const hashView = new DataView(hashes.buffer);
	for (let i = 0; i < hashCount; i++) hashView.setUint32(i * 16 + 12, HASH_EMPTY, true);
	const used = new Uint8Array(hashCount);
	const blocks = new Uint8Array(all.length * 16);
	const blockView = new DataView(blocks.buffer);

	let at = HEADER_SIZE;
	all.forEach((file, index) => {
		out.set(file.data, at);
		blockView.setUint32(index * 16, at, true);
		blockView.setUint32(index * 16 + 4, file.data.length, true);
		blockView.setUint32(index * 16 + 8, file.data.length, true);
		blockView.setUint32(index * 16 + 12, FILE_EXISTS, true);
		at += file.data.length;
		// Its slot: where the name hashes to, or the next free one after it.
		let slot = hashString(file.name, HASH_OFFSET) & (hashCount - 1);
		while (used[slot]) slot = (slot + 1) & (hashCount - 1);
		used[slot] = 1;
		hashView.setUint32(slot * 16, hashString(file.name, HASH_NAME_A), true);
		hashView.setUint32(slot * 16 + 4, hashString(file.name, HASH_NAME_B), true);
		// Neutral locale, any platform.
		hashView.setUint32(slot * 16 + 8, 0, true);
		hashView.setUint32(slot * 16 + 12, index, true);
	});
	// Empty slots: name hashes of all ones too, as the game's tools leave them.
	for (let i = 0; i < hashCount; i++) {
		if (used[i]) continue;
		hashView.setUint32(i * 16, HASH_EMPTY, true);
		hashView.setUint32(i * 16 + 4, HASH_EMPTY, true);
		hashView.setUint32(i * 16 + 8, HASH_EMPTY, true);
	}
	encrypt(hashes, hashString('(hash table)', HASH_FILE_KEY));
	encrypt(blocks, hashString('(block table)', HASH_FILE_KEY));
	out.set(hashes, hashPos);
	out.set(blocks, blockPos);
	return out;
}

/** Whether archive bytes are one Ironforge wrote (its marker's text is stored as is). */
export function isIronforgeArchive(bytes: Uint8Array): boolean {
	const needle = new TextEncoder().encode(IRONFORGE_MARKER_TEXT);
	outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
		for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
		return true;
	}
	return false;
}
