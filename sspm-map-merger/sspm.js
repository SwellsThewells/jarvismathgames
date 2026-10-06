/*
 * sspm.js - read SSPM v2 maps and merge many of them into one.
 *
 * Works in browsers and Node (UMD). No DOM / WebAudio in here: the caller supplies
 * `decodeAudio` (Blob -> PCM) and the MP3 encoder constructor, so the merge logic
 * can be tested outside a browser.
 *
 * SSPM v2 layout (little endian):
 *   0x00 "SS+m"   0x04 u16 version(2)   0x06 4 reserved   0x0A 20B sha1
 *   0x1E u32 length(ms)  0x22 u32 noteCount  0x26 u32 markerCount
 *   0x2A u8 difficulty   0x2B u16 rating     0x2D u8 hasAudio  0x2E u8 hasCover  0x2F u8 requiresMod
 *   0x30 10 x u64: customOff, customLen, audioOff, audioLen, coverOff, coverLen,
 *                  markerDefOff, markerDefLen, markerOff, markerLen
 *   0x80 strings: mapID, mapName, songName (u16-length), u16 mapperCount + mapper strings
 *   then custom data, audio, cover, marker definitions, markers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SSPM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_MAPS = 50;
  var SAMPLE_RATE = 44100;
  var DIFFICULTY_NAMES = ['N/A', 'Easy', 'Medium', 'Hard', 'Logic', 'Tasukete'];
  var U32_MAX = 0xFFFFFFFF;

  var utf8d = new TextDecoder('utf-8');
  var utf8e = new TextEncoder();

  // ---------------------------------------------------------------- reading

  function readBlob(blob, start, end) {
    return blob.slice(start, end).arrayBuffer();
  }

  function u64(dv, off) {
    var n = dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 4294967296;
    if (!Number.isSafeInteger(n)) throw new Error('offset too large');
    return n;
  }

  // Value type ids used by marker definitions (and custom data).
  function skipValue(dv, off, type) {
    switch (type) {
      case 1: return off + 1;
      case 2: return off + 2;
      case 3: return off + 4;
      case 4: return off + 8;
      case 5: return off + 4;
      case 6: return off + 8;
      case 7: return dv.getUint8(off) === 0 ? off + 3 : off + 9; // note: quantum flag + x,y
      case 8: case 9: return off + 2 + dv.getUint16(off, true);
      case 10: case 11: return off + 4 + dv.getUint32(off, true);
      default: throw new Error('unknown value type ' + type);
    }
  }

  function readString16(dv, off, limit) {
    var n = dv.getUint16(off, true);
    if (off + 2 + n > limit) throw new Error('string runs past header');
    var bytes = new Uint8Array(dv.buffer, dv.byteOffset + off + 2, n);
    return [utf8d.decode(bytes), off + 2 + n];
  }

  /**
   * Parse an SSPM v2 file (a Blob/File). Audio and cover stay as Blob slices so
   * 50 big maps don't have to sit in memory at once.
   */
  async function parseSSPM(blob, fileName) {
    if (blob.size < 0x80) throw new Error('file is too small to be an SSPM map');
    var head = new DataView(await readBlob(blob, 0, 0x80));
    var magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
    if (magic !== 'SS+m') throw new Error('not an SSPM file (bad magic)');
    var version = head.getUint16(4, true);
    if (version !== 2) {
      throw new Error('SSPM v' + version + ' is not supported (only v2). Re-save the map as v2 first.');
    }

    var map = {
      fileName: fileName || blob.name || 'map.sspm',
      version: version,
      lengthMs: head.getUint32(30, true),
      declaredNotes: head.getUint32(34, true),
      declaredMarkers: head.getUint32(38, true),
      difficulty: head.getUint8(42),
      hasAudio: head.getUint8(45) === 1,
      hasCover: head.getUint8(46) === 1
    };
    var customOff = u64(head, 48), customLen = u64(head, 56);
    var audioOff = u64(head, 64), audioLen = u64(head, 72);
    var coverOff = u64(head, 80), coverLen = u64(head, 88);
    var defOff = u64(head, 96), defLen = u64(head, 104);
    var mkOff = u64(head, 112), mkLen = u64(head, 120);

    var ends = [customOff + customLen, audioOff + audioLen, coverOff + coverLen, defOff + defLen, mkOff + mkLen];
    for (var i = 0; i < ends.length; i++) {
      if (ends[i] > blob.size) throw new Error('file is truncated (sections run past end of file)');
    }
    if (!map.hasAudio || audioLen === 0) throw new Error('map has no audio, nothing to merge');
    if (customOff < 0x80 || customOff > blob.size) throw new Error('corrupt header');

    // strings between 0x80 and the custom data
    var hdrDv = new DataView(await readBlob(blob, 0, customOff));
    var o = 0x80, s;
    s = readString16(hdrDv, o, customOff); map.mapId = s[0]; o = s[1];
    s = readString16(hdrDv, o, customOff); map.mapName = s[0]; o = s[1];
    s = readString16(hdrDv, o, customOff); map.songName = s[0]; o = s[1];
    var mapperCount = hdrDv.getUint16(o, true); o += 2;
    map.mappers = [];
    for (i = 0; i < mapperCount; i++) { s = readString16(hdrDv, o, customOff); map.mappers.push(s[0]); o = s[1]; }

    // custom data: only used for a nicer difficulty label; failure here is harmless
    map.difficultyName = '';
    try {
      var cdv = new DataView(await readBlob(blob, customOff, customOff + customLen));
      var co = 0, fields = cdv.getUint16(co, true); co += 2;
      for (i = 0; i < fields; i++) {
        var k = readString16(cdv, co, customLen); co = k[1];
        var t = cdv.getUint8(co); co += 1;
        if (k[0] === 'difficulty_name' && (t === 9 || t === 11)) {
          var n = t === 9 ? cdv.getUint16(co, true) : cdv.getUint32(co, true);
          var st = co + (t === 9 ? 2 : 4);
          map.difficultyName = utf8d.decode(new Uint8Array(cdv.buffer, st, n));
        }
        co = skipValue(cdv, co, t);
      }
    } catch (e) { /* ignore */ }

    // marker definitions -> which marker types are plain notes
    var ddv = new DataView(await readBlob(blob, defOff, defOff + defLen));
    var defs = [], d = 0, defCount = ddv.getUint8(d); d += 1;
    for (i = 0; i < defCount; i++) {
      var nm = readString16(ddv, d, defLen); d = nm[1];
      var vc = ddv.getUint8(d); d += 1;
      var types = [];
      for (var v = 0; v < vc; v++) { types.push(ddv.getUint8(d)); d += 1; }
      d += 1; // terminator
      defs.push({ name: nm[0], types: types });
    }

    // markers
    var mdv = new DataView(await readBlob(blob, mkOff, mkOff + mkLen));
    var notes = [], ignored = 0, p = 0;
    for (i = 0; i < map.declaredMarkers; i++) {
      if (p + 5 > mkLen) throw new Error('marker data is truncated');
      var ms = mdv.getUint32(p, true), ti = mdv.getUint8(p + 4); p += 5;
      var def = defs[ti];
      if (!def) throw new Error('marker references undefined type ' + ti);
      var isNote = def.name === 'ssp_note' && def.types.length === 1 && def.types[0] === 7;
      if (isNote) {
        var quantum = mdv.getUint8(p);
        if (quantum === 0) {
          notes.push({ ms: ms, q: 0, x: mdv.getUint8(p + 1), y: mdv.getUint8(p + 2) });
          p += 3;
        } else {
          notes.push({ ms: ms, q: 1, x: mdv.getFloat32(p + 1, true), y: mdv.getFloat32(p + 5, true) });
          p += 9;
        }
      } else {
        for (var j = 0; j < def.types.length; j++) p = skipValue(mdv, p, def.types[j]);
        ignored++;
      }
    }
    if (p > mkLen) throw new Error('marker data is truncated');

    notes.sort(function (a, b) { return a.ms - b.ms; }); // stable: same-ms notes keep file order
    map.notes = notes;
    map.ignoredMarkers = ignored;
    map.audioBlob = blob.slice(audioOff, audioOff + audioLen);
    map.coverBlob = map.hasCover && coverLen > 0 ? blob.slice(coverOff, coverOff + coverLen) : null;
    map.audioMime = sniffAudio(new Uint8Array(await readBlob(blob, audioOff, audioOff + Math.min(audioLen, 16))));
    map.size = blob.size;
    map.title = map.songName || map.mapName || map.mapId || map.fileName;
    return map;
  }

  function sniffAudio(b) {
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav';
    return 'mp3';
  }

  // ---------------------------------------------------------------- writing

  function str16(s) {
    var b = utf8e.encode(s);
    if (b.length > 0xFFFF) b = b.slice(0, 0xFFFF);
    var out = new Uint8Array(2 + b.length);
    new DataView(out.buffer).setUint16(0, b.length, true);
    out.set(b, 2);
    return out;
  }

  function concatBytes(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  // Marker definitions block: one definition, "ssp_note" with a single note value.
  function noteDefinitions() {
    return concatBytes([new Uint8Array([1]), str16('ssp_note'), new Uint8Array([1, 7, 0])]);
  }

  function encodeNotes(notes) {
    var size = 0, i;
    for (i = 0; i < notes.length; i++) size += notes[i].q ? 14 : 8;
    var buf = new ArrayBuffer(size), dv = new DataView(buf), p = 0;
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      dv.setUint32(p, n.ms, true); dv.setUint8(p + 4, 0); // type 0 = ssp_note
      if (n.q) {
        dv.setUint8(p + 5, 1); dv.setFloat32(p + 6, n.x, true); dv.setFloat32(p + 10, n.y, true); p += 14;
      } else {
        dv.setUint8(p + 5, 0); dv.setUint8(p + 6, n.x); dv.setUint8(p + 7, n.y); p += 8;
      }
    }
    return new Uint8Array(buf);
  }

  // Plain synchronous SHA-1 (crypto.subtle needs a secure context; this works anywhere).
  function sha1(bytes) {
    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var len = bytes.length, padded = ((len + 8) >> 6 << 6) + 64;
    var m = new Uint8Array(padded);
    m.set(bytes); m[len] = 0x80;
    var dv = new DataView(m.buffer);
    dv.setUint32(padded - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(padded - 4, (len << 3) >>> 0, false);
    var w = new Uint32Array(80);
    for (var off = 0; off < padded; off += 64) {
      var t;
      for (t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4, false);
      for (t = 16; t < 80; t++) { var x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (t = 0; t < 80; t++) {
        var f, k;
        if (t < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (t < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    var out = new Uint8Array(20), odv = new DataView(out.buffer);
    odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3); odv.setUint32(16, h4);
    return out;
  }

  /**
   * Assemble an SSPM v2 file. `audioParts` is an array of Uint8Array chunks (the MP3),
   * so the multi-hundred-MB audio is never copied into one big buffer.
   */
  function buildSSPM(o) {
    var defs = noteDefinitions();
    var markers = encodeNotes(o.notes);
    var strings = concatBytes([str16(o.mapId), str16(o.mapName), str16(o.songName), (function () {
      var c = new Uint8Array(2); new DataView(c.buffer).setUint16(0, o.mappers.length, true);
      return concatBytes([c].concat(o.mappers.map(str16)));
    })()]);
    // custom data: one string field, difficulty_name
    var nameBytes = str16(o.difficultyName || '');
    var custom = concatBytes([new Uint8Array([1, 0]), str16('difficulty_name'), new Uint8Array([9]), nameBytes]);

    var audioLen = 0, i;
    for (i = 0; i < o.audioParts.length; i++) audioLen += o.audioParts[i].length;
    var cover = o.cover; // Uint8Array or null
    var coverLen = cover ? cover.length : 0;

    var customOff = 0x80 + strings.length;
    var audioOff = customOff + custom.length;
    var coverOff = audioOff + audioLen;
    var defOff = coverOff + coverLen;
    var mkOff = defOff + defs.length;

    var header = new Uint8Array(0x80), dv = new DataView(header.buffer);
    header.set([0x53, 0x53, 0x2B, 0x6D], 0);
    dv.setUint16(4, 2, true);
    header.set(sha1(concatBytes([defs, markers])), 10);
    dv.setUint32(30, o.lengthMs >>> 0, true);
    dv.setUint32(34, o.notes.length, true);
    dv.setUint32(38, o.notes.length, true);
    dv.setUint8(42, o.difficulty);
    dv.setUint8(45, 1);
    dv.setUint8(46, cover ? 1 : 0);
    var offs = [customOff, custom.length, audioOff, audioLen, coverOff, coverLen, defOff, defs.length, mkOff, markers.length];
    for (i = 0; i < offs.length; i++) {
      dv.setUint32(48 + i * 8, offs[i] % 4294967296, true);
      dv.setUint32(52 + i * 8, Math.floor(offs[i] / 4294967296), true);
    }

    var parts = [header, strings, custom].concat(o.audioParts);
    if (cover) parts.push(cover);
    parts.push(defs, markers);
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  // ---------------------------------------------------------------- audio

  // Float PCM (-1..1) -> Int16, with clipping.
  function toInt16(src, from, to) {
    var out = new Int16Array(to - from);
    for (var i = from; i < to; i++) {
      var v = src[i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      out[i - from] = v < 0 ? v * 32768 : v * 32767;
    }
    return out;
  }

  /** LAME inserts this many samples of delay (encoder 576 + decoder 529) that tagless MP3s don't hide. */
  var ENCODER_DELAY_SAMPLES = 1105;

  function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // ---------------------------------------------------------------- merge

  /**
   * Merge parsed maps into one SSPM Blob.
   *
   * opts: { name, gapMs, fadeOutMs, bitrate, coverIndex (-1 = none), syncOffsetMs,
   *         decodeAudio(blob) -> Promise<{left:Float32Array, right:Float32Array|null}> at 44.1 kHz,
   *         Mp3Encoder (lamejs.Mp3Encoder), onProgress(fraction, text), shouldCancel() }
   * Returns { blob, tracklist:[{title, startMs, endMs, notes}], totalMs, noteCount, difficulty }
   */
  async function mergeMaps(maps, opts) {
    if (!maps.length) throw new Error('add at least one map');
    if (maps.length > MAX_MAPS) throw new Error('at most ' + MAX_MAPS + ' maps can be merged');
    var progress = opts.onProgress || function () {};
    var cancelled = opts.shouldCancel || function () { return false; };
    var gapSamples = Math.round((opts.gapMs || 0) * SAMPLE_RATE / 1000);
    var fadeSamples = Math.round((opts.fadeOutMs || 0) * SAMPLE_RATE / 1000);
    var syncMs = opts.syncOffsetMs || 0;

    var enc = new opts.Mp3Encoder(2, SAMPLE_RATE, opts.bitrate || 192);
    var audioParts = [], audioBytes = 0;
    function pushMp3(chunk) {
      if (chunk && chunk.length) {
        // lamejs hands back a fresh buffer each call, so a view is safe
        var u = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
        audioParts.push(u); audioBytes += u.length;
      }
    }

    var CHUNK = 1152 * 32;
    async function feed(l, r, from, to) {
      var t0 = Date.now();
      for (var s = from; s < to; s += CHUNK) {
        var e = Math.min(to, s + CHUNK);
        pushMp3(enc.encodeBuffer(toInt16(l, s, e), toInt16(r, s, e)));
        if (Date.now() - t0 > 40) { await nextTick(); t0 = Date.now(); if (cancelled()) throw new Error('cancelled'); }
      }
    }
    async function feedSilence(count) {
      var z = new Float32Array(Math.min(count, CHUNK * 4));
      for (var left = count; left > 0; left -= z.length) {
        var n = Math.min(left, z.length);
        await feed(z, z, 0, n);
      }
    }

    var notes = [], tracklist = [], mappers = [], mapperSeen = {};
    var posSamples = 0, difficulty = 0;
    // time shift applied to every note to cancel the MP3 encoder delay, plus user tweak
    var shiftMs = Math.round(ENCODER_DELAY_SAMPLES * 1000 / SAMPLE_RATE) + syncMs;

    for (var i = 0; i < maps.length; i++) {
      if (cancelled()) throw new Error('cancelled');
      var m = maps[i];
      progress(i / maps.length, 'Decoding ' + (i + 1) + '/' + maps.length + ': ' + m.title);
      var pcm;
      try { pcm = await opts.decodeAudio(m.audioBlob); }
      catch (e) { throw new Error('Could not decode audio of "' + m.title + '": ' + (e && e.message || e)); }
      var left = pcm.left, right = pcm.right || pcm.left, len = left.length;

      if (i > 0 && gapSamples > 0) { await feedSilence(gapSamples); posSamples += gapSamples; }
      var startMs = Math.round(posSamples * 1000 / SAMPLE_RATE);

      if (fadeSamples > 0) {
        var f = Math.min(fadeSamples, len);
        for (var k = 0; k < f; k++) {
          var g = 1 - (k + 1) / f, idx = len - f + k;
          left[idx] *= g; if (right !== left) right[idx] *= g;
        }
      }
      progress((i + 0.3) / maps.length, 'Encoding ' + (i + 1) + '/' + maps.length + ': ' + m.title);
      await feed(left, right, 0, len);
      posSamples += len;

      for (var n = 0; n < m.notes.length; n++) {
        var src = m.notes[n];
        notes.push({ ms: startMs + src.ms + shiftMs, q: src.q, x: src.x, y: src.y });
      }
      tracklist.push({ title: m.title, startMs: startMs, endMs: Math.round(posSamples * 1000 / SAMPLE_RATE), notes: m.notes.length });
      if (m.difficulty > difficulty && m.difficulty <= 5) difficulty = m.difficulty;
      for (var q = 0; q < m.mappers.length; q++) {
        var key = m.mappers[q].toLowerCase();
        if (!mapperSeen[key]) { mapperSeen[key] = 1; mappers.push(m.mappers[q]); }
      }
    }
    pushMp3(enc.flush());
    progress(0.97, 'Writing SSPM file…');

    var last = notes.length ? notes[notes.length - 1].ms : 0;
    if (last > U32_MAX) throw new Error('merged map is too long');
    var cover = null;
    if (opts.coverIndex >= 0 && maps[opts.coverIndex] && maps[opts.coverIndex].coverBlob) {
      cover = new Uint8Array(await maps[opts.coverIndex].coverBlob.arrayBuffer());
    }

    var name = (opts.name || 'SSPM Map Pack').trim() || 'SSPM Map Pack';
    var blob = buildSSPM({
      mapId: opts.mapId || makeMapId(name),
      mapName: name,
      songName: name,
      mappers: mappers,
      difficulty: difficulty,
      difficultyName: maps.length + ' maps merged',
      lengthMs: last,
      notes: notes,
      audioParts: audioParts,
      cover: cover
    });
    progress(1, 'Done');
    return { blob: blob, tracklist: tracklist, totalMs: Math.round(posSamples * 1000 / SAMPLE_RATE), noteCount: notes.length, difficulty: difficulty, audioBytes: audioBytes };
  }

  function makeMapId(name) {
    var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'pack';
    var rnd = Math.floor(Math.random() * 0xFFFFFF).toString(16);
    return 'sspmmerger_' + slug + '_' + rnd;
  }

  function formatTime(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (h ? String(m).padStart(2, '0') : String(m)), ss = String(sec).padStart(2, '0');
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  return {
    MAX_MAPS: MAX_MAPS, SAMPLE_RATE: SAMPLE_RATE, DIFFICULTY_NAMES: DIFFICULTY_NAMES,
    parseSSPM: parseSSPM, mergeMaps: mergeMaps, buildSSPM: buildSSPM, sha1: sha1,
    formatTime: formatTime, makeMapId: makeMapId
  };
});
