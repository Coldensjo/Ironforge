/**
 * A DBC table, as the original clients keep them (DBFilesClient\*.dbc): a 'WDBC' header, fixed-size
 * records of 32-bit fields, and a block of strings the string fields point into. Fields are by
 * index; which index holds what differs between client versions, so the readers say.
 */
export class Dbc {
	readonly recordCount: number;
	readonly fieldCount: number;
	private readonly recordSize: number;
	private readonly view: DataView;
	private readonly strings: number;
	private readonly byId = new Map<number, number>();

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (this.view.getUint32(0, true) !== 0x43424457) throw new Error('Not a DBC file'); // 'WDBC'
		this.recordCount = this.view.getUint32(4, true);
		this.fieldCount = this.view.getUint32(8, true);
		this.recordSize = this.view.getUint32(12, true);
		this.strings = 20 + this.recordCount * this.recordSize;
		// Field 0 is the ID in every table the editor reads.
		for (let r = 0; r < this.recordCount; r++) this.byId.set(this.view.getUint32(20 + r * this.recordSize, true), r);
	}

	/** Every record's ID (field 0). */
	ids(): number[] {
		return [...this.byId.keys()];
	}

	has(id: number): boolean {
		return this.byId.has(id);
	}

	private offset(id: number, field: number): number | null {
		const record = this.byId.get(id);
		if (record === undefined || field >= this.fieldCount) return null;
		return 20 + record * this.recordSize + field * 4;
	}

	getInt(id: number, field: number): number | null {
		const o = this.offset(id, field);
		return o === null ? null : this.view.getInt32(o, true);
	}

	getFloat(id: number, field: number): number | null {
		const o = this.offset(id, field);
		return o === null ? null : this.view.getFloat32(o, true);
	}

	/** A string field: an offset into the string block, read up to its terminating zero. */
	getString(id: number, field: number): string | null {
		const o = this.offset(id, field);
		if (o === null) return null;
		const start = this.strings + this.view.getUint32(o, true);
		let end = start;
		while (end < this.bytes.length && this.bytes[end] !== 0) end++;
		return new TextDecoder().decode(this.bytes.subarray(start, end));
	}
}
