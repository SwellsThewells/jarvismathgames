(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX = SSPM.MAX_MAPS;

  var items = [];          // { uid, map, coverUrl }
  var nextUid = 1;
  var building = false;
  var cancelRequested = false;
  var resultUrls = [];

  var el = {
    drop: $('drop'), file: $('file'), slots: $('slots'), issues: $('issues'),
    orderCard: $('orderCard'), list: $('list'), optsCard: $('optsCard'), buildCard: $('buildCard'),
    name: $('name'), gap: $('gap'), fade: $('fade'), bitrate: $('bitrate'), cover: $('cover'), nudge: $('nudge'),
    stats: $('stats'), build: $('build'), cancel: $('cancel'),
    progressBox: $('progressBox'), bar: $('bar'), status: $('status'), error: $('error'),
    result: $('result'), resultInfo: $('resultInfo'), download: $('download'), dlTracks: $('dlTracks'), tracks: $('tracks'),
    support: $('support'), veil: $('dropveil')
  };

  // ------------------------------------------------------------ support check
  function AudioCtor() { return window.OfflineAudioContext || window.webkitOfflineAudioContext; }
  if (!AudioCtor() || typeof lamejs === 'undefined' || !window.Blob || !window.TextDecoder) {
    el.support.textContent = 'This browser is missing features the merger needs (Web Audio / Blob). Please use a recent Chrome, Edge or Firefox.';
    el.support.hidden = false;
    el.build.disabled = true;
  }

  // ------------------------------------------------------------ audio decode
  async function decodeAudio(blob) {
    var buf = await blob.arrayBuffer();
    var Ctx = AudioCtor();
    var ctx = new Ctx(2, 1, SSPM.SAMPLE_RATE); // decodeAudioData resamples to the context rate
    var audio = await ctx.decodeAudioData(buf);
    if (audio.sampleRate !== SSPM.SAMPLE_RATE) throw new Error('browser decoded at ' + audio.sampleRate + ' Hz instead of 44100 Hz');
    var left = audio.getChannelData(0);
    var right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
    return { left: left, right: right };
  }

  // ------------------------------------------------------------ adding files
  function addIssue(text, kind) {
    var li = document.createElement('li');
    if (kind) li.className = kind;
    var span = document.createElement('span'); span.textContent = text;
    var x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
    x.onclick = function () { li.remove(); };
    li.appendChild(span); li.appendChild(x);
    el.issues.appendChild(li);
  }

  async function addFiles(fileList) {
    if (building) return;
    el.issues.textContent = '';
    var files = Array.prototype.slice.call(fileList).filter(function (f) { return /\.sspm$/i.test(f.name); });
    var skipped = fileList.length - files.length;
    if (skipped > 0) addIssue(skipped + ' file(s) skipped: only .sspm files are accepted.');
    var overflow = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (items.length >= MAX) { overflow++; continue; }
      if (items.some(function (it) { return it.map.fileName === f.name && it.map.size === f.size; })) {
        addIssue(f.name + ': already added.', 'info'); continue;
      }
      try {
        var map = await SSPM.parseSSPM(f, f.name);
        items.push({ uid: nextUid++, map: map, coverUrl: map.coverBlob ? URL.createObjectURL(map.coverBlob) : null });
        if (map.ignoredMarkers) addIssue(map.title + ': ' + map.ignoredMarkers + ' non-note marker(s) will be left out.', 'info');
      } catch (e) {
        addIssue(f.name + ': ' + (e && e.message || e));
      }
      render();
    }
    if (overflow) addIssue(overflow + ' file(s) not added: the limit is ' + MAX + ' maps.');
    render();
  }

  // ------------------------------------------------------------ rendering
  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function diffBadge(map) {
    var b = document.createElement('span');
    var d = map.difficulty;
    b.className = 'badge' + (d >= 1 && d <= 5 ? ' d' + d : '');
    b.textContent = map.difficultyName || SSPM.DIFFICULTY_NAMES[d] || 'N/A';
    return b;
  }

  function iconBtn(label, text, cls, onclick, disabled) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.title = label; b.setAttribute('aria-label', label);
    if (cls) b.className = cls;
    b.disabled = !!disabled;
    b.onclick = onclick;
    return b;
  }

  var dragFrom = null;

  function render() {
    var has = items.length > 0;
    el.slots.textContent = items.length + ' / ' + MAX;
    el.orderCard.hidden = el.optsCard.hidden = el.buildCard.hidden = !has;
    el.list.textContent = '';

    items.forEach(function (it, idx) {
      var m = it.map;
      var li = document.createElement('li');
      li.className = 'item';
      li.draggable = true;
      li.dataset.idx = idx;

      var num = document.createElement('span'); num.className = 'num'; num.textContent = idx + 1; num.title = 'Drag to reorder';
      var thumb;
      if (it.coverUrl) { thumb = document.createElement('img'); thumb.className = 'thumb'; thumb.src = it.coverUrl; thumb.alt = ''; thumb.loading = 'lazy'; }
      else { thumb = document.createElement('div'); thumb.className = 'thumb none'; thumb.textContent = '♪'; }

      var txt = document.createElement('div'); txt.className = 'itxt';
      var t = document.createElement('div'); t.className = 'ttl'; t.textContent = m.title; t.title = m.title;
      var meta = document.createElement('div'); meta.className = 'meta';
      meta.appendChild(diffBadge(m));
      var parts = [m.notes.length.toLocaleString() + ' notes', SSPM.formatTime(m.lengthMs)];
      if (m.mappers.length) parts.push('by ' + m.mappers.join(', '));
      parts.push(m.audioMime.toUpperCase());
      var ms = document.createElement('span'); ms.textContent = parts.join(' · ');
      meta.appendChild(ms);
      txt.appendChild(t); txt.appendChild(meta);

      var acts = document.createElement('div'); acts.className = 'acts';
      acts.appendChild(iconBtn('Move up', '↑', '', function () { move(idx, idx - 1); }, idx === 0));
      acts.appendChild(iconBtn('Move down', '↓', '', function () { move(idx, idx + 1); }, idx === items.length - 1));
      acts.appendChild(iconBtn('Remove', '✕', 'rm', function () { remove(idx); }));

      li.appendChild(num); li.appendChild(thumb); li.appendChild(txt); li.appendChild(acts);

      li.addEventListener('dragstart', function (e) {
        if (building) { e.preventDefault(); return; }
        dragFrom = idx; li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'sspm-row'); // Firefox needs data to start a drag
      });
      li.addEventListener('dragend', function () { dragFrom = null; clearDropMarks(); li.classList.remove('dragging'); });
      li.addEventListener('dragover', function (e) {
        if (dragFrom === null) return;
        e.preventDefault(); e.stopPropagation();
        clearDropMarks();
        var r = li.getBoundingClientRect();
        li.classList.add(e.clientY < r.top + r.height / 2 ? 'dropbefore' : 'dropafter');
      });
      li.addEventListener('drop', function (e) {
        if (dragFrom === null) return;
        e.preventDefault(); e.stopPropagation();
        var r = li.getBoundingClientRect();
        var to = idx + (e.clientY < r.top + r.height / 2 ? 0 : 1);
        var from = dragFrom; dragFrom = null; clearDropMarks();
        if (to > from) to--;
        move(from, to);
      });
      el.list.appendChild(li);
    });

    renderCoverOptions();
    renderStats();
  }

  function clearDropMarks() {
    Array.prototype.forEach.call(el.list.children, function (c) { c.classList.remove('dropbefore', 'dropafter'); });
  }

  function renderCoverOptions() {
    var prev = el.cover.value || 'first';
    el.cover.textContent = '';
    function opt(v, label) { var o = document.createElement('option'); o.value = v; o.textContent = label; el.cover.appendChild(o); }
    opt('first', 'First map in the list');
    opt('none', 'No cover');
    items.forEach(function (it) { if (it.coverUrl) opt(String(it.uid), it.map.title); });
    el.cover.value = Array.prototype.some.call(el.cover.options, function (o) { return o.value === prev; }) ? prev : 'first';
  }

  function renderStats() {
    var notes = 0, ms = 0;
    items.forEach(function (it) { notes += it.map.notes.length; ms += it.map.lengthMs; });
    var gap = parseInt(el.gap.value, 10) * Math.max(0, items.length - 1);
    var kbps = parseInt(el.bitrate.value, 10);
    var est = kbps * 125 * ((ms + gap) / 1000) + 1e6; // rough: audio + cover/notes slack
    el.stats.textContent = '';
    [
      [items.length, 'Maps'],
      [notes.toLocaleString(), 'Notes'],
      ['≈ ' + SSPM.formatTime(ms + gap), 'Length'],
      ['≈ ' + fmtBytes(est), 'File size']
    ].forEach(function (s) {
      var d = document.createElement('div'); d.className = 'stat';
      var b = document.createElement('b'); b.textContent = s[0];
      var sp = document.createElement('span'); sp.textContent = s[1];
      d.appendChild(b); d.appendChild(sp); el.stats.appendChild(d);
    });
  }

  // ------------------------------------------------------------ list editing
  function move(from, to) {
    if (building || to < 0 || to >= items.length || from === to) return;
    var it = items.splice(from, 1)[0];
    items.splice(to, 0, it);
    render();
  }
  function remove(idx) {
    if (building) return;
    var it = items.splice(idx, 1)[0];
    if (it.coverUrl) URL.revokeObjectURL(it.coverUrl);
    el.issues.textContent = '';
    render();
  }
  $('sortDiff').onclick = function () {
    items.sort(function (a, b) { return a.map.difficulty - b.map.difficulty || a.map.notes.length - b.map.notes.length; }); render();
  };
  $('sortName').onclick = function () {
    items.sort(function (a, b) { return a.map.title.localeCompare(b.map.title, undefined, { sensitivity: 'base', numeric: true }); }); render();
  };
  $('reverse').onclick = function () { items.reverse(); render(); };
  $('shuffle').onclick = function () {
    for (var i = items.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = items[i]; items[i] = items[j]; items[j] = t; }
    render();
  };
  $('clear').onclick = function () {
    if (building) return;
    items.forEach(function (it) { if (it.coverUrl) URL.revokeObjectURL(it.coverUrl); });
    items = []; el.issues.textContent = ''; hideResult(); render();
  };
  el.gap.onchange = el.bitrate.onchange = renderStats;

  // ------------------------------------------------------------ file input / drag & drop
  el.drop.onclick = function () { el.file.click(); };
  el.file.onchange = function () { addFiles(el.file.files).then(function () { el.file.value = ''; }); };

  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
  window.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; dragDepth++; el.veil.classList.add('on'); });
  window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) el.veil.classList.remove('on'); });
  window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; el.veil.classList.remove('on');
    addFiles(e.dataTransfer.files);
  });

  // ------------------------------------------------------------ building
  function setBusy(b) {
    building = b;
    document.body.classList.toggle('busy', b);
    el.build.disabled = b;
    el.cancel.hidden = !b;
    el.progressBox.hidden = !b && !el.status.textContent;
  }

  function hideResult() {
    el.result.hidden = true;
    resultUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    resultUrls = [];
  }

  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }

  function safeFileName(s) {
    return (s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim() || 'SSPM Map Pack');
  }

  el.cancel.onclick = function () { cancelRequested = true; el.status.textContent = 'Cancelling…'; };

  el.build.onclick = async function () {
    if (building || !items.length) return;
    hideResult(); el.error.hidden = true;
    cancelRequested = false;
    el.status.textContent = 'Starting…'; el.bar.value = 0;
    setBusy(true);
    el.progressBox.hidden = false;

    var maps = items.map(function (it) { return it.map; });
    var coverIndex = 0;
    if (el.cover.value === 'none') coverIndex = -1;
    else if (el.cover.value !== 'first') {
      coverIndex = items.findIndex(function (it) { return String(it.uid) === el.cover.value; });
      if (coverIndex < 0) coverIndex = 0;
    } else {
      coverIndex = maps.findIndex(function (m) { return m.coverBlob; }); // first map that actually has one
    }
    var packName = el.name.value.trim() || 'SSPM Map Pack';

    try {
      var res = await SSPM.mergeMaps(maps, {
        name: packName,
        gapMs: parseInt(el.gap.value, 10),
        fadeOutMs: parseInt(el.fade.value, 10),
        bitrate: parseInt(el.bitrate.value, 10),
        coverIndex: coverIndex,
        syncOffsetMs: Math.max(-500, Math.min(500, parseInt(el.nudge.value, 10) || 0)),
        decodeAudio: decodeAudio,
        Mp3Encoder: lamejs.Mp3Encoder,
        shouldCancel: function () { return cancelRequested; },
        onProgress: function (f, text) { el.bar.value = Math.round(f * 100); el.status.textContent = text; }
      });
      showResult(res, packName);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (msg === 'cancelled') { el.status.textContent = 'Cancelled.'; }
      else {
        if (/decode/i.test(msg)) msg += ' — if the map uses OGG audio, try Chrome, Edge or Firefox.';
        showError(msg); el.status.textContent = '';
      }
    } finally {
      setBusy(false);
      if (!el.status.textContent) el.progressBox.hidden = true;
    }
  };

  function showResult(res, packName) {
    var base = safeFileName(packName);
    var url = URL.createObjectURL(res.blob);
    el.download.href = url; el.download.download = base + '.sspm';
    resultUrls.push(url);

    var lines = [packName, '', 'Tracklist (time in the merged map):'];
    res.tracklist.forEach(function (t, i) { lines.push((i + 1) + '. ' + SSPM.formatTime(t.startMs) + '  ' + t.title + '  (' + t.notes + ' notes)'); });
    var txtUrl = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
    el.dlTracks.href = txtUrl; el.dlTracks.download = base + ' - tracklist.txt';
    resultUrls.push(txtUrl);

    el.resultInfo.textContent = res.tracklist.length + ' maps · ' + res.noteCount.toLocaleString() + ' notes · ' +
      SSPM.formatTime(res.totalMs) + ' · ' + fmtBytes(res.blob.size) + ' · difficulty: ' + (SSPM.DIFFICULTY_NAMES[res.difficulty] || 'N/A');
    el.tracks.textContent = '';
    res.tracklist.forEach(function (t) {
      var li = document.createElement('li');
      var tm = document.createElement('span'); tm.className = 't'; tm.textContent = SSPM.formatTime(t.startMs);
      var n = document.createElement('span'); n.className = 'n'; n.textContent = t.title;
      li.appendChild(tm); li.appendChild(n); el.tracks.appendChild(li);
    });
    el.result.hidden = false;
    el.status.textContent = 'Done.';
    el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  render();
})();
