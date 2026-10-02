/**
 * The original client's (1.12, version 256) model animation, rebuilt in the layout of later
 * models, so the posing code (m2Pose.ts) reads both. Only what posing reads is rebuilt: global
 * loops, sequences, bones and their tracks, and attachment points; the rest of the header is 0.
 *
 * What differs in 1.12: sequences (68 bytes) give a start and end time on one shared timeline
 * rather than a duration; a track (28 bytes) keeps all its keys in one list, with ranges per
 * sequence, rather than a list per sequence; rotations are four floats rather than four packed
 * int16s; bones are 108 bytes and attachments 48, their tracks being larger.
 */

const VANILLA_SEQUENCE = 68;
const VANILLA_BONE = 108;
const VANILLA_TRACK = 28;
const VANILLA_ATTACHMENT = 48;
/** The later layout (see m2Pose.ts). */
const SEQUENCE = 64;
const BONE = 88;
const TRACK = 20;
const ATTACHMENT = 40;
const HEADER = 0x130;
/** Sequence flag: its keys are in the model (no .anim file). */
const SEQ_EMBEDDED = 0x20;

/** Packs a quaternion component as the later models do (the inverse of m2Pose's compQuat). */
const packQuat = (q: number) => Math.round(q <= 0 ? q * 32767 + 32767 : q * 32767 - 32768);

class Writer {
	private bytes = new Uint8Array(1 << 16);
	view = new DataView(this.bytes.buffer);
	length = 0;

	/** Reserves size bytes (4-aligned), returning where they start. */
	alloc(size: number): number {
		const at = (this.length + 3) & ~3;
		if (at + size > this.bytes.length) {
			let capacity = this.bytes.length * 2;
			while (capacity < at + size) capacity *= 2;
			const grown = new Uint8Array(capacity);
			grown.set(this.bytes);
			this.bytes = grown;
			this.view = new DataView(grown.buffer);
		}
		this.length = at + size;
		return at;
	}

	result(): Uint8Array {
		return this.bytes.slice(0, this.length);
	}
}

/** A 1.12 model's animation in the later layout, as a model file of its own (header at 0). */
export function vanillaAnimationLayout(bytes: Uint8Array): Uint8Array {
	const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => src.getUint32(o, true);
	const out = new Writer();
	out.alloc(HEADER);
	const w = () => out.view;
	w().setUint32(0, 0x3032444d, true); // 'MD20'
	w().setUint32(4, 256, true);

	// Global loops: the same list.
	const loopCount = u32(0x14);
	const loops = out.alloc(loopCount * 4);
	for (let i = 0; i < loopCount; i++) w().setUint32(loops + i * 4, u32(u32(0x18) + i * 4), true);
	w().setUint32(0x14, loopCount, true);
	w().setUint32(0x18, loops, true);

	// Sequences: a duration, embedded, no aliases.
	const seqCount = u32(0x1c);
	const seqStart: number[] = [];
	const seqEnd: number[] = [];
	const seqs = out.alloc(seqCount * SEQUENCE);
	for (let i = 0; i < seqCount; i++) {
		const o = u32(0x20) + i * VANILLA_SEQUENCE;
		const s = seqs + i * SEQUENCE;
		seqStart.push(u32(o + 4));
		seqEnd.push(u32(o + 8));
		w().setUint16(s, src.getUint16(o, true), true);
		w().setUint16(s + 2, src.getUint16(o + 2, true), true);
		w().setUint32(s + 4, Math.max(0, u32(o + 8) - u32(o + 4)), true);
		w().setFloat32(s + 8, src.getFloat32(o + 12, true), true);
		w().setUint32(s + 12, SEQ_EMBEDDED, true);
		w().setUint16(s + 0x3e, i, true);
	}
	w().setUint32(0x1c, seqCount, true);
	w().setUint32(0x20, seqs, true);

	/**
	 * One track: its keys per sequence (those within the sequence's time span, made relative to
	 * its start), or for a global loop's track all of them once. size: bytes per value read;
	 * write: copies one value, converting it.
	 */
	const track = (from: number, to: number, size: number, outSize: number, write: (src: number, dst: number) => void) => {
		const globalSeq = src.getInt16(from + 2, true);
		w().setUint16(to, src.getUint16(from, true), true);
		w().setInt16(to + 2, globalSeq, true);
		const timeCount = u32(from + 12), times = u32(from + 16);
		const valueCount = u32(from + 20), values = u32(from + 24);
		const count = Math.min(timeCount, valueCount);
		if (!count) return;
		const spans: [number, number][] = globalSeq >= 0 ? [[0, Infinity]] : seqStart.map((start, i) => [start, seqEnd[i]]);
		const lists = out.alloc(spans.length * 16);
		// The time lists, then the value lists, each (count, offset).
		w().setUint32(to + 4, spans.length, true);
		w().setUint32(to + 8, lists, true);
		w().setUint32(to + 12, spans.length, true);
		w().setUint32(to + 16, lists + spans.length * 8, true);
		spans.forEach(([start, end], i) => {
			const keys: number[] = [];
			for (let k = 0; k < count; k++) {
				const t = u32(times + k * 4);
				if (t >= start && t <= end) keys.push(k);
			}
			if (!keys.length) return;
			const t = out.alloc(keys.length * 4);
			const v = out.alloc(keys.length * outSize);
			keys.forEach((k, n) => {
				w().setUint32(t + n * 4, u32(times + k * 4) - start, true);
				write(values + k * size, v + n * outSize);
			});
			w().setUint32(lists + i * 8, keys.length, true);
			w().setUint32(lists + i * 8 + 4, t, true);
			w().setUint32(lists + spans.length * 8 + i * 8, keys.length, true);
			w().setUint32(lists + spans.length * 8 + i * 8 + 4, v, true);
		});
	};
	const copyVec = (s: number, d: number) => {
		for (let k = 0; k < 3; k++) w().setFloat32(d + k * 4, src.getFloat32(s + k * 4, true), true);
	};
	const packRotation = (s: number, d: number) => {
		for (let k = 0; k < 4; k++) w().setInt16(d + k * 2, packQuat(Math.max(-1, Math.min(1, src.getFloat32(s + k * 4, true)))), true);
	};

	// Bones (in 1.12 after a list of playable animations): their tracks rebuilt, the rest copied.
	const boneCount = u32(0x34);
	const bones = out.alloc(boneCount * BONE);
	w().setUint32(0x2c, boneCount, true);
	w().setUint32(0x30, bones, true);
	for (let b = 0; b < boneCount; b++) {
		const o = u32(0x38) + b * VANILLA_BONE;
		const d = bones + b * BONE;
		w().setInt32(d, src.getInt32(o, true), true);
		w().setUint32(d + 4, u32(o + 4), true);
		w().setInt16(d + 8, src.getInt16(o + 8, true), true);
		w().setUint16(d + 10, src.getUint16(o + 10, true), true);
		track(o + 12, d + 16, 12, 12, copyVec);
		track(o + 12 + VANILLA_TRACK, d + 16 + TRACK, 16, 8, packRotation);
		track(o + 12 + VANILLA_TRACK * 2, d + 16 + TRACK * 2, 12, 12, copyVec);
		copyVec(o + 96, d + 76);
	}

	// Attachment points: id, bone and position.
	const attachCount = u32(0x104);
	const attachments = out.alloc(attachCount * ATTACHMENT);
	w().setUint32(0xf0, attachCount, true);
	w().setUint32(0xf4, attachments, true);
	for (let i = 0; i < attachCount; i++) {
		const o = u32(0x108) + i * VANILLA_ATTACHMENT;
		const d = attachments + i * ATTACHMENT;
		w().setUint32(d, u32(o), true);
		w().setUint16(d + 4, src.getUint16(o + 4, true), true);
		copyVec(o + 8, d + 8);
	}
	return out.result();
}
