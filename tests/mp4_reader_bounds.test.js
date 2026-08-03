import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadFile } = require('../js/file_reader');

let tmpDir;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdpe-mp4-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- minimal MP4 builders -------------------------------------------------

function box(type, payload, declaredSize = null) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(declaredSize === null ? payload.length + 8 : declaredSize, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, payload]);
}

function box64(type, payload, declaredBig) {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(1, 0);            // marker: 64-bit size follows
    head.write(type, 4, 'ascii');
    head.writeBigUInt64BE(declaredBig, 8);
    return Buffer.concat([head, payload]);
}

function keysBox(names) {
    const entries = names.map((n) => {
        const b = Buffer.alloc(8 + Buffer.byteLength(n));
        b.writeUInt32BE(b.length, 0);
        b.write('mdta', 4, 'ascii');
        b.write(n, 8, 'utf8');
        return b;
    });
    const head = Buffer.alloc(8);        // version/flags + entry count
    head.writeUInt32BE(names.length, 4);
    return box('keys', Buffer.concat([head, ...entries]));
}

function ilstBox(index, value) {
    const data = box('data', Buffer.concat([Buffer.alloc(8), Buffer.from(value, 'utf8')]));
    const item = Buffer.alloc(8 + data.length);
    item.writeUInt32BE(item.length, 0);
    item.writeUInt32BE(index, 4);        // key index instead of a fourcc
    data.copy(item, 8);
    return box('ilst', item);
}

function udtaWith(json) {
    return box('udta', box('meta', Buffer.concat([
        Buffer.alloc(4),                 // version/flags
        keysBox(['com.apple.quicktime.comment']),
        ilstBox(1, json),
    ])));
}

const PROMPT = JSON.stringify({ prompt: { 1: { class_type: 'KSampler' } } });
const FTYP = box('ftyp', Buffer.from('isom'));

function write(name, buf) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, buf);
    return p;
}

// Writes only the given pieces at the given offsets and leaves the gaps as a
// hole. Lets a fixture declare a 20 MB box without writing 20 MB, since the
// parser only ever reads headers in those regions.
function writeSparse(name, totalSize, pieces) {
    const p = path.join(tmpDir, name);
    const fd = fs.openSync(p, 'w');
    try {
        for (const { at, buf } of pieces) fs.writeSync(fd, buf, 0, buf.length, at);
        fs.ftruncateSync(fd, totalSize);
    } finally {
        fs.closeSync(fd);
    }
    return p;
}

// Header of a box whose payload is left unwritten.
function boxHeader(type, declaredSize) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(declaredSize, 0);
    head.write(type, 4, 'ascii');
    return head;
}

// --- tests ----------------------------------------------------------------

describe('MP4 box size validation', () => {
    it('parses a well-formed moov/udta chain', async () => {
        const file = write('valid.mp4', Buffer.concat([
            FTYP, box('mdat', Buffer.alloc(1024)), box('moov', udtaWith(PROMPT)),
        ]));
        await expect(loadFile(file)).resolves.toMatchObject({ prompt: expect.anything() });
    });

    it('rejects a forged 32-bit box size larger than the file', async () => {
        const file = write('forged32.mp4', Buffer.concat([
            FTYP, box('moov', udtaWith(PROMPT), 400 * 1024 * 1024),
        ]));
        const alloc = vi.spyOn(Buffer, 'alloc');
        await expect(loadFile(file)).resolves.toBeNull();
        for (const call of alloc.mock.calls) {
            expect(call[0]).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
        alloc.mockRestore();
    });

    it('rejects a 64-bit box size beyond the safe-integer range', async () => {
        const file = write('forged64.mp4', Buffer.concat([
            FTYP, box64('moov', udtaWith(PROMPT), 0xFFFFFFFFFFFFFFFFn),
        ]));
        await expect(loadFile(file)).resolves.toBeNull();
    });

    it('rejects a 64-bit box size that is safe but past EOF', async () => {
        const file = write('forged64eof.mp4', Buffer.concat([
            FTYP, box64('moov', udtaWith(PROMPT), 900n * 1024n * 1024n),
        ]));
        await expect(loadFile(file)).resolves.toBeNull();
    });

    it('rejects a box size smaller than its own header', async () => {
        const file = write('tiny.mp4', Buffer.concat([
            FTYP, box('moov', udtaWith(PROMPT), 3),
        ]));
        await expect(loadFile(file)).resolves.toBeNull();
    });

    it('rejects a size that overruns EOF by a little', async () => {
        const file = write('pasteof.mp4', Buffer.concat([
            FTYP, box('moov', udtaWith(PROMPT), 5000),
        ]));
        await expect(loadFile(file)).resolves.toBeNull();
    });

    it('still handles a legal size==0 box that runs to EOF', async () => {
        const file = write('zerosize.mp4', Buffer.concat([
            FTYP, box('moov', udtaWith(PROMPT), 0),
        ]));
        await expect(loadFile(file)).resolves.toMatchObject({ prompt: expect.anything() });
    });
});

describe('file size gate', () => {
    it('skips any supported format above the 500 MB limit', async () => {
        for (const name of ['huge.mp4', 'huge.png']) {
            const p = path.join(tmpDir, name);
            fs.writeFileSync(p, Buffer.alloc(0));
            fs.truncateSync(p, 501 * 1024 * 1024);   // sparse, no real disk use
            await expect(loadFile(p)).resolves.toBeNull();
        }
    });
});

describe('box scan limit', () => {
    const pad = (n) => Array.from({ length: n }, () => box('free', Buffer.alloc(0)));

    it('stops scanning before reaching a moov placed past the limit', async () => {
        const file = write('scanlimit.mp4', Buffer.concat([
            ...pad(5000), box('moov', udtaWith(PROMPT)),
        ]));
        await expect(loadFile(file)).resolves.toBeNull();
    });

    it('still finds a moov that sits after a modest run of boxes', async () => {
        const file = write('scanok.mp4', Buffer.concat([
            ...pad(100), box('moov', udtaWith(PROMPT)),
        ]));
        await expect(loadFile(file)).resolves.toMatchObject({ prompt: expect.anything() });
    });
});

describe('PNG text chunk fallback', () => {
    it('does not allocate the whole file when the PNG exceeds the read limit', async () => {
        const chunk = (type, payload) => Buffer.concat([
            (() => { const b = Buffer.alloc(4); b.writeUInt32BE(payload.length, 0); return b; })(),
            Buffer.from(type, 'ascii'),
            payload,
            Buffer.alloc(4),                      // CRC placeholder, not verified
        ]);
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4);
        ihdr[8] = 8; ihdr[9] = 6;

        const IDAT = 24 * 1024 * 1024;
        const head = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr),
            chunk('tEXt', Buffer.from(`parameters\0${PROMPT}`, 'latin1')),
            (() => { const b = Buffer.alloc(8); b.writeUInt32BE(IDAT, 0); b.write('IDAT', 4, 'ascii'); return b; })(),
        ]);
        const tail = Buffer.concat([Buffer.alloc(4), chunk('IEND', Buffer.alloc(0))]);
        const file = writeSparse('big.png', head.length + IDAT + tail.length, [
            { at: 0, buf: head },
            { at: head.length + IDAT, buf: tail },
        ]);

        const alloc = vi.spyOn(Buffer, 'alloc');
        await loadFile(file);
        for (const call of alloc.mock.calls) {
            expect(call[0]).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
        alloc.mockRestore();
    });
});

describe('metadata read limit', () => {
    it('reads only udta when moov exceeds the read limit, never allocating above it', async () => {
        const FILLER = 20 * 1024 * 1024;
        const udta = udtaWith(PROMPT);
        const moovStart = FTYP.length;
        const freeStart = moovStart + 8;
        const udtaStart = freeStart + FILLER;
        const total = udtaStart + udta.length;

        const file = writeSparse('bigmoov.mp4', total, [
            { at: 0, buf: FTYP },
            { at: moovStart, buf: boxHeader('moov', total - moovStart) },
            { at: freeStart, buf: boxHeader('free', FILLER) },
            { at: udtaStart, buf: udta },
        ]);

        const alloc = vi.spyOn(Buffer, 'alloc');
        await expect(loadFile(file)).resolves.toMatchObject({ prompt: expect.anything() });
        for (const call of alloc.mock.calls) {
            expect(call[0]).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
        alloc.mockRestore();
    });

    it('gives up when udta itself exceeds the read limit', async () => {
        const UDTA = 20 * 1024 * 1024;
        const moovStart = FTYP.length;
        const udtaStart = moovStart + 8;
        const total = udtaStart + UDTA;

        const file = writeSparse('bigudta.mp4', total, [
            { at: 0, buf: FTYP },
            { at: moovStart, buf: boxHeader('moov', total - moovStart) },
            { at: udtaStart, buf: boxHeader('udta', UDTA) },
        ]);
        await expect(loadFile(file)).resolves.toBeNull();
    });
});