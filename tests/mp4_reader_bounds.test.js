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

describe('metadata read limit', () => {
    it('reads only udta when moov exceeds the read limit, never allocating above it', async () => {
        const filler = box('free', Buffer.alloc(20 * 1024 * 1024));
        const file = write('bigmoov.mp4', Buffer.concat([
            FTYP, box('moov', Buffer.concat([filler, udtaWith(PROMPT)])),
        ]));

        const alloc = vi.spyOn(Buffer, 'alloc');
        await expect(loadFile(file)).resolves.toMatchObject({ prompt: expect.anything() });
        for (const call of alloc.mock.calls) {
            expect(call[0]).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
        alloc.mockRestore();
    });

    it('gives up when udta itself exceeds the read limit', async () => {
        const bigUdta = box('udta', Buffer.alloc(20 * 1024 * 1024));
        const file = write('bigudta.mp4', Buffer.concat([
            FTYP, box('moov', Buffer.concat([bigUdta, box('free', Buffer.alloc(1024))])),
        ]));
        await expect(loadFile(file)).resolves.toBeNull();
    });
});