import { describe, expect, it } from 'vitest';
import { Dbc } from '../src/mpq/dbc';

/** A DBC file built by hand: records of [id, int, float, string offset]. */
function makeDbc(records: [number, number, number, string][]): Uint8Array {
	const strings = ['\0'];
	const offsets = records.map(([, , , s]) => {
		const at = strings.join('').length;
		strings.push(`${s}\0`);
		return at;
	});
	const text = new TextEncoder().encode(strings.join(''));
	const bytes = new Uint8Array(20 + records.length * 16 + text.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x43424457, true);
	view.setUint32(4, records.length, true);
	view.setUint32(8, 4, true);
	view.setUint32(12, 16, true);
	view.setUint32(16, text.length, true);
	records.forEach(([id, n, f], r) => {
		view.setUint32(20 + r * 16, id, true);
		view.setInt32(24 + r * 16, n, true);
		view.setFloat32(28 + r * 16, f, true);
		view.setUint32(32 + r * 16, offsets[r], true);
	});
	bytes.set(text, 20 + records.length * 16);
	return bytes;
}

describe('DBC', () => {
	const dbc = new Dbc(makeDbc([[0, 0, 1.5, 'Azeroth'], [1, -7, 0.25, 'Kalimdor'], [369, 42, 2, 'DeeprunTram']]));

	it('reads the header and every ID', () => {
		expect(dbc.recordCount).toBe(3);
		expect(dbc.fieldCount).toBe(4);
		expect(dbc.ids()).toEqual([0, 1, 369]);
	});

	it('reads ints, floats and strings by ID and field', () => {
		expect(dbc.getInt(1, 1)).toBe(-7);
		expect(dbc.getFloat(1, 2)).toBeCloseTo(0.25);
		expect(dbc.getString(369, 3)).toBe('DeeprunTram');
		expect(dbc.getString(0, 3)).toBe('Azeroth');
	});

	it('gives null for a missing record or field', () => {
		expect(dbc.getInt(2, 1)).toBeNull();
		expect(dbc.getInt(1, 9)).toBeNull();
	});

	it('rejects what is not a DBC', () => {
		expect(() => new Dbc(new Uint8Array(20))).toThrow('Not a DBC file');
	});
});
