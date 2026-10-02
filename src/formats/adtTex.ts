import { chunks } from './chunks';

export const ALPHA_SIZE = 64;
const ALPHA_TEXELS = ALPHA_SIZE * ALPHA_SIZE;

const LAYER_USE_ALPHA = 0x100;
const LAYER_ALPHA_COMPRESSED = 0x200;

export interface TextureParams {
	/** Texture repeats per chunk. */
	repeats: number;
	heightScale: number;
	heightOffset: number;
}

export interface TexLayer {
	/** Index into the tile's texture lists. */
	texture: number;
	flags: number;
	/** GroundEffectTexture ID: the grass, flowers or pebbles that grow on this texture (0 for none). */
	effect: number;
}

export interface TexChunk {
	layers: TexLayer[];
	/** 64x64 alpha per layer after the first (up to 3), row-major. */
	alpha: Uint8Array[];
}

export interface AdtTex {
	/** Diffuse texture file IDs (MDID). */
	diffuse: number[];
	/** Height texture file IDs (MHID); 0 where a texture has none. */
	height: number[];
	params: TextureParams[];
	chunks: TexChunk[];
}

/**
 * Parses a split _tex0.adt: texture lists, per-chunk layers and decoded alpha maps.
 * bigAlpha comes from the WDT (8-bit alpha rather than 4-bit); fixAlpha, per chunk, says
 * whether 4-bit maps need their last row and column duplicated (MCNK flag 0x8000 unset).
 */
export function parseAdtTex(bytes: Uint8Array, bigAlpha: boolean, fixAlpha: (chunk: number) => boolean = () => true): AdtTex {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32s = (offset: number, size: number) => Array.from({ length: size / 4 }, (_, i) => view.getUint32(offset + i * 4, true));
	const result: AdtTex = { diffuse: [], height: [], params: [], chunks: [] };
	let flags: number[] = [];
	let mtxp: { heightScale: number; heightOffset: number }[] = [];

	for (const c of chunks(bytes)) {
		switch (c.id) {
			case 'MDID':
				result.diffuse = u32s(c.offset, c.size);
				break;
			case 'MHID':
				result.height = u32s(c.offset, c.size);
				break;
			case 'MTXF':
				flags = u32s(c.offset, c.size);
				break;
			case 'MTXP':
				mtxp = Array.from({ length: c.size / 16 }, (_, i) => ({
					heightScale: view.getFloat32(c.offset + i * 16 + 4, true),
					heightOffset: view.getFloat32(c.offset + i * 16 + 8, true),
				}));
				break;
			case 'MCNK':
				result.chunks.push(parseChunk(bytes, view, c.offset, c.offset + c.size, bigAlpha, fixAlpha(result.chunks.length)));
				break;
		}
	}

	result.params = result.diffuse.map((_, i) => ({
		// MTXF bits 4-7: texture scale, each step halving the repeat size.
		repeats: 8 / 2 ** ((flags[i] ?? 0) >> 4 & 0xf),
		heightScale: mtxp[i]?.heightScale ?? 0,
		heightOffset: mtxp[i]?.heightOffset ?? 1,
	}));
	return result;
}

function parseChunk(bytes: Uint8Array, view: DataView, start: number, end: number, bigAlpha: boolean, fix: boolean): TexChunk {
	const chunk: TexChunk = { layers: [], alpha: [] };
	const alphaOffsets: number[] = [];
	let mcal: { offset: number; size: number } | null = null;
	for (const sub of chunks(bytes, start, end)) {
		if (sub.id === 'MCLY') {
			for (let l = 0; l < sub.size / 16; l++) {
				const o = sub.offset + l * 16;
				chunk.layers.push({ texture: view.getUint32(o, true), flags: view.getUint32(o + 4, true), effect: view.getUint32(o + 12, true) });
				alphaOffsets.push(view.getUint32(o + 8, true));
			}
		} else if (sub.id === 'MCAL') {
			mcal = { offset: sub.offset, size: sub.size };
		}
	}
	for (let l = 1; l < chunk.layers.length; l++) {
		const layer = chunk.layers[l];
		const alpha = new Uint8Array(ALPHA_TEXELS);
		if (mcal && layer.flags & LAYER_USE_ALPHA) {
			const data = bytes.subarray(mcal.offset + alphaOffsets[l], mcal.offset + mcal.size);
			if (layer.flags & LAYER_ALPHA_COMPRESSED) decodeRle(data, alpha);
			else if (bigAlpha) alpha.set(data.subarray(0, ALPHA_TEXELS));
			else decode4Bit(data, alpha, fix);
		}
		chunk.alpha.push(alpha);
	}
	return chunk;
}

/** Run-length alpha: high bit set = repeat the next byte, clear = copy the next bytes. */
function decodeRle(data: Uint8Array, out: Uint8Array): void {
	let i = 0;
	let o = 0;
	while (o < out.length && i < data.length) {
		const header = data[i++];
		const count = header & 0x7f;
		if (header & 0x80) {
			out.fill(data[i++], o, Math.min(out.length, o + count));
		} else {
			out.set(data.subarray(i, i + Math.min(count, out.length - o)), o);
			i += count;
		}
		o += count;
	}
}

/** 4-bit alpha (two texels a byte, low first); fix: the 63x63 kind, its last row and column repeated. */
export function decode4Bit(data: Uint8Array, out: Uint8Array, fix: boolean): void {
	for (let i = 0; i < ALPHA_TEXELS / 2 && i < data.length; i++) {
		out[i * 2] = (data[i] & 0x0f) * 17;
		out[i * 2 + 1] = (data[i] >> 4) * 17;
	}
	if (!fix) return;
	// 63x63 maps: repeat the last column and row.
	for (let y = 0; y < ALPHA_SIZE; y++) out[y * ALPHA_SIZE + 63] = out[y * ALPHA_SIZE + 62];
	out.copyWithin(63 * ALPHA_SIZE, 62 * ALPHA_SIZE, 63 * ALPHA_SIZE);
}
