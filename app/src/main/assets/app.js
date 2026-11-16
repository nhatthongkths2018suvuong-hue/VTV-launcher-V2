(function () {
  'use strict';

  // Android: file nằm ở thư mục riêng của app, đường dẫn do phần Java cung cấp
  var BRIDGE = window.AndroidBridge || null;
  function channelPath() { try { return BRIDGE.getPath(); } catch (e) { return ''; } }
  var API = 'https://api.vtvdigital.org/live-channel/v21.0/playback/source';
  var COLS = 6;       // số kênh mỗi hàng (mỗi "trang" của hàng kênh)
  var QN = 6;         // số ô ứng dụng nhanh
  var DEFAULT_CHAN = '#1f5a9e'; // màu ô kênh khi dùng hình nền mặc định

  var zone = 'grid';  // 'top' = 2 icon Cài đặt/Ứng dụng, 'quick' = hàng ứng dụng nhanh, 'grid' = hàng kênh
  var topSel = 0;
  var qSel = 0;
  var enterDownAt = 0;
  var enterLong = false;

  var channels = [];
  var sel = 0;
  var playing = false;
  var playIdx = -1;
  var playToken = 0;
  var lastPlayAt = 0;
  var osdTimer = null;
  var msgTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  // ---------- localStorage an toàn ----------
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  var deviceId = lsGet('vtv_device_id');
  if (!deviceId) { deviceId = uuid(); lsSet('vtv_device_id', deviceId); }

  var nameCache = {};
  try { nameCache = JSON.parse(lsGet('vtv_names') || '{}') || {}; } catch (e) { nameCache = {}; }

  // ---------- Phân tích file ----------
  var RE_VTVGO = /vtvgo\.vn\/channel\/([A-Za-z0-9_-]+)/i;

  function cleanName(s) {
    s = (s || '').replace(/[\[\]\(\)]/g, ' ').replace(/[|,;:\-–—]+\s*$/, '').replace(/^\s*[|,;:\-–—]+/, '').trim();
    if (/vtv\s*go|vtvgo|trực tiếp/i.test(s)) return null; // tiêu đề trang, không phải tên kênh
    return s || null;
  }

  function parse(text) {
    var out = [];
    var lines = text.replace(/\r/g, '').split('\n');
    var pendingName = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/^﻿/, '').trim();
      if (!l || l.charAt(0) === ';') continue;
      if (l.indexOf('#EXTINF') === 0) {
        var c = l.lastIndexOf(',');
        pendingName = c >= 0 ? cleanName(l.substring(c + 1)) : null;
        continue;
      }
      if (l.charAt(0) === '#') continue;
      var m = l.match(/https?:\/\/[^\s)\]"']+/i);
      if (!m) continue;
      var url = m[0];
      var name = cleanName(l.substring(0, m.index)) || pendingName;
      pendingName = null;
      var g = url.match(RE_VTVGO);
      var ch = { name: name, url: url, vtvgoId: g ? g[1] : null };
      if (!ch.name) {
        ch.name = (ch.vtvgoId && nameCache[ch.vtvgoId]) || (ch.vtvgoId ? 'Kênh ' + ch.vtvgoId : 'Kênh ' + (out.length + 1));
        ch.autoName = !!ch.vtvgoId && !nameCache[ch.vtvgoId];
      }
      out.push(ch);
    }
    return out;
  }

  var MAX_H = 0; // 0 = tự động (không giới hạn); đặt dòng #quality=480 trong channels.txt để giới hạn chiều cao video

  // cb(list, reason)
  function loadChannels(cb) {
    var text = '';
    try { text = BRIDGE.readChannels(); } catch (e) { text = ''; }
    if (!text) { cb([], 'không đọc được file hoặc file trống'); return; }
    var q = text.match(/^\s*#\s*quality\s*=\s*(\d{3,4})/mi);
    MAX_H = q ? parseInt(q[1], 10) : 0;
    var list = parse(text);
    if (!list.length) { cb([], 'file không có link nào'); return; }
    cb(list, null);
  }

  // ---------- Gọi API vtvgo ----------
  // cb(err, {sources:[url,...], name:string})
  function fetchSources(id, cb) {
    var x = new XMLHttpRequest();
    var done = false;
    function finish(err, data) { if (!done) { done = true; cb(err, data); } }
    try {
      x.open('POST', API, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 12000;
      x.ontimeout = function () { finish('API quá thời gian chờ'); };
      x.onerror = function () { finish('Không gọi được API (mạng hoặc bị chặn)'); };
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status !== 200) { finish('API trả về mã ' + x.status); return; }
        var j;
        try { j = JSON.parse(x.responseText); } catch (e) { finish('Phản hồi API không đọc được'); return; }
        var urls = [];
        var modes = (j && j.data && j.data.sourceModes) || [];
        for (var a = 0; a < modes.length; a++) {
          var ms = modes[a].multiSource || [];
          for (var b = 0; b < ms.length; b++) {
            var s = ms[b];
            if (s.drmTypeID && s.drmTypeID !== 'none') continue;
            if (s.manifestType && s.manifestType !== 'hls') continue;
            var src = s.sources || [];
            for (var c = 0; c < src.length; c++) {
              if (src[c].url && urls.indexOf(src[c].url) < 0) urls.push(src[c].url);
            }
          }
        }
        if (!urls.length) { finish('API không trả về nguồn phát nào cho kênh này'); return; }
        finish(null, { sources: urls, name: (j.data && j.data.channelName) || null });
      };
      x.send(JSON.stringify({ channelId: String(id), platform: 'webPC', deviceId: deviceId }));
    } catch (e) { finish('Lỗi gọi API: ' + e); }
  }

  // ---------- Màu ----------
  function hexRgb(h) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [60, 80, 110];
  }
  // t > 0: pha trắng, t < 0: pha đen
  function shade(c, t) {
    var o = [], i, v;
    for (i = 0; i < 3; i++) {
      v = t >= 0 ? c[i] + (255 - c[i]) * t : c[i] * (1 + t);
      o.push(Math.round(Math.max(0, Math.min(255, v))));
    }
    return 'rgba(' + o[0] + ',' + o[1] + ',' + o[2] + ',0.92)';
  }
  function paintTile(el, hex) {
    var c = hexRgb(hex);
    el.style.background = 'linear-gradient(145deg,' + shade(c, 0.16) + ',' + shade(c, -0.2) + ')';
  }

  // ---------- Hàng kênh: mỗi lần hiện 6 kênh, ▲▼ chuyển 6 kênh trước/sau ----------
  var chanRow = $('chanRow');
  var chanColor = DEFAULT_CHAN;
  var pageEls = [];     // [{el, idx}] của hàng đang hiển thị
  var shownPage = -1;

  function pageOf(i) { return Math.floor(i / COLS); }
  function label(i) { return (i + 1) + '. ' + channels[i].name; }
  function setLabel(i) {
    var p = pageOf(i);
    if (p !== shownPage) return;
    var o = pageEls[i - p * COLS];
    if (o) o.lb.textContent = label(i);
  }

  function showPage() {
    if (!channels.length) return;
    var p = pageOf(sel);
    if (p === shownPage && pageEls.length) return;
    shownPage = p;
    pageEls = [];
    chanRow.innerHTML = '';
    for (var k = 0; k < COLS; k++) {
      var i = p * COLS + k;
      if (i >= channels.length) break;
      var d = document.createElement('div');
      d.className = 'tl ch';
      var inn = document.createElement('div');
      inn.className = 'in';
      var sp = document.createElement('span');
      var lb = document.createElement('i');
      lb.className = 'lb';
      lb.textContent = label(i);
      sp.appendChild(lb);
      inn.appendChild(sp);
      d.appendChild(inn);
      paintTile(d, chanColor);
      (function (idx) {
        d.addEventListener('click', function () {
          if (playing) return;
          zone = 'grid';
          play(idx);
        }, false);
      })(i);
      chanRow.appendChild(d);
      pageEls.push({ el: d, lb: lb, idx: i });
    }
    updateSel();
  }

  function render() {
    shownPage = -1;
    pageEls = [];
    showPage();
  }

  function repaintChannels() {
    for (var i = 0; i < pageEls.length; i++) paintTile(pageEls[i].el, chanColor);
  }

  // Vuốt lên/xuống trên hàng kênh = sang hàng 6 kênh sau/trước
  var cStartY = 0, cSwiped = false;
  chanRow.addEventListener('touchstart', function (e) {
    if (playing || !e.touches.length) return;
    cStartY = e.touches[0].clientY;
    cSwiped = false;
  }, false);
  chanRow.addEventListener('touchend', function (e) {
    if (playing || !e.changedTouches.length) return;
    var dy = e.changedTouches[0].clientY - cStartY;
    if (Math.abs(dy) < 40) return;
    e.preventDefault(); // đã vuốt: không tính là chạm vào ô
    var p = pageOf(sel) + (dy < 0 ? 1 : -1);
    if (p < 0 || p * COLS >= channels.length) return;
    sel = Math.min(p * COLS + (sel % COLS), channels.length - 1);
    showPage();
  }, false);

  // Lấy tên kênh thật cho các link không đặt tên (lần lượt, chạy nền)
  function resolveNames() {
    var q = [];
    for (var i = 0; i < channels.length; i++) if (channels[i].autoName) q.push(i);
    (function step() {
      if (!q.length) return;
      if (playing) { setTimeout(step, 2000); return; }
      var i = q.shift();
      var ch = channels[i];
      fetchSources(ch.vtvgoId, function (err, data) {
        if (!err && data && data.name) {
          ch.name = data.name;
          nameCache[ch.vtvgoId] = data.name;
          lsSet('vtv_names', JSON.stringify(nameCache));
          setLabel(i);
        }
        setTimeout(step, 150);
      });
    })();
  }

  // ---------- Phát ----------
  function showMsg(t, ms) {
    $('msg').textContent = t || '';
    clearTimeout(msgTimer);
    if (t && ms) msgTimer = setTimeout(function () { $('msg').textContent = ''; }, ms);
  }

  function showOsd() {
    var o = $('osd');
    o.textContent = (playIdx + 1) + '. ' + channels[playIdx].name + '   (OK: về danh sách)';
    o.style.display = 'block';
    clearTimeout(osdTimer);
    $('ctl').style.display = 'block';
    osdTimer = setTimeout(hideOsd, 3500);
  }

  function hideOsd() {
    $('osd').style.display = 'none';
    $('ctl').style.display = 'none';
  }

  // ---------- Giới hạn chất lượng (HLS) ----------
  function resolveUrl(base, ref) {
    if (/^https?:\/\//i.test(ref)) return ref;
    var m = base.match(/^(https?:\/\/[^\/?#]+)([^?#]*)/i);
    if (!m) return ref;
    if (ref.charAt(0) === '/') return m[1] + ref;
    return m[1] + m[2].replace(/[^\/]*$/, '') + ref;
  }

  function pickVariant(text, base, maxH) {
    var lines = text.replace(/\r/g, '').split('\n');
    var vs = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (l.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var bw = l.match(/BANDWIDTH=(\d+)/i);
      var rs = l.match(/RESOLUTION=(\d+)x(\d+)/i);
      var j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().charAt(0) === '#')) j++;
      if (j >= lines.length) break;
      vs.push({ uri: lines[j].trim(), bw: bw ? parseInt(bw[1], 10) : 0, h: rs ? parseInt(rs[2], 10) : 0 });
    }
    if (vs.length < 2) return null; // không phải danh sách nhiều chất lượng
    var cap = maxH * 3500; // ước lượng băng thông tối đa khi link không ghi độ phân giải
    var best = null, lowest = vs[0];
    for (var k = 0; k < vs.length; k++) {
      var v = vs[k];
      var ok = v.h ? (v.h <= maxH) : (v.bw && v.bw <= cap);
      var key = v.h || v.bw;
      var lowKey = lowest.h || lowest.bw;
      if (key < lowKey) lowest = v;
      if (ok && (!best || key > (best.h || best.bw))) best = v;
    }
    return resolveUrl(base, (best || lowest).uri);
  }

  var srcToken = 0;

  function setVideoSrc(url) {
    var t = ++srcToken;
    if (!MAX_H) { applyVideoSrc(url); return; }
    var x = new XMLHttpRequest();
    var done = false;
    function fin(u) { if (done) return; done = true; if (t === srcToken && playing) applyVideoSrc(u || url); }
    try {
      x.open('GET', url, true);
      x.timeout = 6000;
      x.ontimeout = function () { fin(null); };
      x.onerror = function () { fin(null); };
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status !== 200) { fin(null); return; }
        var u = null;
        try { u = pickVariant(x.responseText || '', url, MAX_H); } catch (e) { u = null; }
        fin(u);
      };
      x.send();
    } catch (e) { fin(null); }
  }

  function applyVideoSrc(url) {
    try { video.pause(); } catch (e) {}
    try { video.removeAttribute('src'); } catch (e) {}
    video.src = url;
    try { video.load(); } catch (e) {}
    try {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  // Lấy nguồn (nếu là link vtvgo) rồi phát. tryIdx: nguồn thứ mấy, refetched: đã lấy lại link chưa
  function startChannel(i, tryIdx, refetched) {
    var ch = channels[i];
    var token = ++playToken;
    showMsg(ch.vtvgoId ? 'Đang lấy luồng...' : 'Đang tải...', 0);

    function go(sources) {
      if (token !== playToken || !playing) return;
      ch.sources = sources;
      ch.srcIdx = tryIdx < sources.length ? tryIdx : 0;
      ch.refetched = refetched;
      setVideoSrc(sources[ch.srcIdx]);
    }

    if (!ch.vtvgoId) { go([ch.url]); return; }

    fetchSources(ch.vtvgoId, function (err, data) {
      if (token !== playToken || !playing) return;
      if (err) {
        ch.lastErr = err;
        showMsg(err + '. Bấm Back để quay lại, hoặc ▲▼ đổi kênh.', 0);
        return;
      }
      if (data.name && ch.autoName) {
        ch.name = data.name;
        nameCache[ch.vtvgoId] = data.name;
        lsSet('vtv_names', JSON.stringify(nameCache));
        setLabel(i);
        showOsd();
      }
      go(data.sources);
    });
  }

  function play(i) {
    if (i < 0 || i >= channels.length) return;
    playIdx = i;
    sel = i;
    playing = true;
    lastPlayAt = new Date().getTime();
    $('gridView').style.display = 'none';
    $('playerView').style.display = 'block';
    showOsd();
    startChannel(i, 0, false);
  }

  function stop() {
    playToken++;
    // Đổi giao diện trước, dọn video sau (và bọc try/catch) để lỗi của trình phát không chặn việc quay lại lưới
    playing = false;
    $('playerView').style.display = 'none';
    $('gridView').style.display = 'block';
    zone = 'grid';
    hideOsd();
    showMsg('', 0);
    try { showPage(); updateSel(); tick(); } catch (e) {}
    try { video.pause(); } catch (e) {}
    try { video.removeAttribute('src'); } catch (e) {}
    try { video.load(); } catch (e) {}
  }

  function zap(d) {
    if (!channels.length) return;
    play((playIdx + d + channels.length) % channels.length);
  }

  video.addEventListener('playing', function () { showMsg('', 0); });
  video.addEventListener('waiting', function () { if (playing) showMsg('Đang đệm...', 0); });
  video.addEventListener('error', function () {
    if (!playing || playIdx < 0) return;
    var ch = channels[playIdx];
    if (!ch.sources) return;
    // 1) link vtvgo: token có thể hết hạn -> xin link mới 1 lần
    if (ch.vtvgoId && !ch.refetched) {
      showMsg('Lỗi phát, đang lấy luồng mới...', 0);
      startChannel(playIdx, ch.srcIdx || 0, true);
      return;
    }
    // 2) thử nguồn dự phòng tiếp theo
    if (ch.srcIdx + 1 < ch.sources.length) {
      ch.srcIdx++;
      showMsg('Nguồn lỗi, đổi sang nguồn ' + (ch.srcIdx + 1) + '/' + ch.sources.length + '...', 0);
      setVideoSrc(ch.sources[ch.srcIdx]);
      return;
    }
    showMsg('Không phát được kênh này. Bấm Back để quay lại, ▲▼ để đổi kênh.', 0);
  });

  // ---------- 2 icon góc phải: Cài đặt / Ứng dụng ----------
  var tiles = [$('tSettings'), $('tApps')];

  // ---------- 6 ô ứng dụng nhanh ----------
  var ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
  var ICON_STAR = '<svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
  var qRow = $('quickRow');
  var qEls = [];   // [{el, ic, lb, filled}]
  var qTimers = [];
  var qLongTouch = [];

  (function () {
    for (var n = 0; n < QN; n++) {
      (function (i) {
        var d = document.createElement('div');
        d.className = 'tl q empty';
        var inn = document.createElement('div');
        inn.className = 'in';
        var sp = document.createElement('span');
        var ic = document.createElement('div');
        ic.className = 'qic';
        var lb = document.createElement('i');
        lb.className = 'lb';
        sp.appendChild(ic);
        sp.appendChild(lb);
        inn.appendChild(sp);
        d.appendChild(inn);
        qRow.appendChild(d);
        qEls.push({ el: d, ic: ic, lb: lb, filled: false });

        d.addEventListener('click', function () {
          if (playing) return;
          if (qLongTouch[i]) { qLongTouch[i] = false; return; }
          zone = 'quick'; qSel = i; updateSel();
          activateQuick(i);
        }, false);
        // chạm giữ để chọn lại ứng dụng cho ô này
        d.addEventListener('touchstart', function () {
          qLongTouch[i] = false;
          clearTimeout(qTimers[i]);
          qTimers[i] = setTimeout(function () { qLongTouch[i] = true; pickQuick(i); }, 700);
        }, false);
        d.addEventListener('touchmove', function () { clearTimeout(qTimers[i]); }, false);
        d.addEventListener('touchend', function (e) {
          clearTimeout(qTimers[i]);
          if (qLongTouch[i]) e.preventDefault();
        }, false);
      })(n);
    }
  })();

  function refreshQuick() {
    for (var i = 0; i < QN; i++) {
      var info = null;
      try { var t = BRIDGE.getQuickApp(i); if (t) info = JSON.parse(t); } catch (e) { info = null; }
      var o = qEls[i];
      o.filled = !!info;
      if (info) {
        var ico = '';
        try { ico = BRIDGE.getQuickIcon(i); } catch (e) { ico = ''; }
        o.ic.innerHTML = (ico && ico.indexOf('data:image/') === 0) ? '<img src="' + ico + '">' : ICON_STAR;
        o.lb.textContent = info.label || 'Ứng dụng';
        paintTile(o.el, info.color || '#3a4a66');
      } else {
        o.ic.innerHTML = ICON_PLUS;
        o.lb.textContent = 'Thêm ứng dụng';
        o.el.style.background = 'rgba(12,20,36,.55)';
      }
    }
    updateSel();
  }

  function pickQuick(i) { try { BRIDGE.pickQuick(i); } catch (e) {} }

  function activateQuick(i) {
    try {
      if (qEls[i].filled) BRIDGE.launchQuick(i);
      else BRIDGE.pickQuick(i);
    } catch (e) {}
  }

  function activateTop(i) {
    try {
      if (i === 0) BRIDGE.openSettings();
      else BRIDGE.openApps();
    } catch (e) {}
  }

  for (var tn = 0; tn < tiles.length; tn++) {
    (function (i) {
      tiles[i].addEventListener('click', function () {
        if (playing) return;
        zone = 'top'; topSel = i; updateSel();
        activateTop(i);
      }, false);
    })(tn);
  }

  // Tô sáng ô đang chọn (chỉ ô của vùng đang hoạt động)
  function updateSel() {
    var i;
    for (i = 0; i < tiles.length; i++) {
      tiles[i].className = 'ibtn' + (zone === 'top' && topSel === i ? ' sel' : '');
    }
    for (i = 0; i < qEls.length; i++) {
      qEls[i].el.className = 'tl q' + (qEls[i].filled ? '' : ' empty') + (zone === 'quick' && qSel === i ? ' sel' : '');
    }
    for (i = 0; i < pageEls.length; i++) {
      pageEls[i].el.className = 'tl ch' + (zone === 'grid' && pageEls[i].idx === sel ? ' sel' : '');
    }
  }

  // ---------- Đồng hồ ----------
  var lastTime = '', lastDate = '';
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function tick() {
    var d = new Date();
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var dt = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    if (t !== lastTime) { lastTime = t; $('time').textContent = t; }
    if (dt !== lastDate) { lastDate = dt; $('date').textContent = dt; }
  }
  setInterval(function () { if (!playing) tick(); }, 1000);

  // ---------- Hình nền (Nen.jpg trong thư mục dữ liệu của app) ----------
  var wallStamp = null;
  function refreshWall() {
    var st = '';
    try { st = BRIDGE.getBackgroundStamp() || ''; } catch (e) { st = ''; }
    if (st === wallStamp) return;
    wallStamp = st;
    var wall = $('wall');
    var color = DEFAULT_CHAN;
    var uri = '';
    if (st) {
      try { uri = BRIDGE.getBackground() || ''; } catch (e) { uri = ''; }
    }
    if (uri && uri.indexOf('data:image/') === 0) {
      wall.style.backgroundImage = 'url("' + uri + '")';
      var c = '';
      try { c = BRIDGE.getBackgroundColor() || ''; } catch (e) { c = ''; }
      if (/^#[0-9a-f]{6}$/i.test(c)) color = c;
    } else {
      wall.style.backgroundImage = ''; // về hình nền mặc định trong style.css
    }
    chanColor = color;
    repaintChannels();
  }

  // ---------- Phím điều khiển ----------
  var lastBackAt = 0;
  var numBuf = '';
  var numTimer = null;
  var numOsd = $('numOsd');

  function now() { return new Date().getTime(); }
  function isBack(k) { return k === 461 || k === 8 || k === 27 || k === 10009; }

  function showNum(text, ms) {
    numOsd.textContent = text;
    numOsd.style.display = text ? 'block' : 'none';
    clearTimeout(numTimer);
    if (text && ms) numTimer = setTimeout(function () { numOsd.style.display = 'none'; }, ms);
  }

  function commitNum() {
    clearTimeout(numTimer);
    var n = parseInt(numBuf, 10);
    numBuf = '';
    if (n >= 1 && n <= channels.length) {
      showNum('', 0);
      play(n - 1);
    } else {
      showNum('Không có kênh ' + n, 1800);
    }
  }

  function numKey(d) {
    if (!channels.length) return;
    if (numBuf.length >= 3) numBuf = '';
    numBuf += d;
    var n = parseInt(numBuf, 10);
    if (n === 0) { numBuf = ''; return; }
    showNum('Kênh ' + numBuf + '_', 0);
    clearTimeout(numTimer);
    // đủ chữ số (không thể có số lớn hơn) thì chuyển ngay, nếu không thì chờ thêm
    if (n * 10 > channels.length || numBuf.length >= 3) commitNum();
    else numTimer = setTimeout(commitNum, 1200);
  }

  function goBack() {
    lastBackAt = now();
    if (playing) { stop(); return; }
    // Đang là launcher (màn hình Home) thì Back ở danh sách kênh không làm gì; chạy như app thường thì thoát
    var isHome = false;
    try { isHome = BRIDGE.isDefaultHome(); } catch (e) { isHome = false; }
    if (isHome) return;
    try { BRIDGE.exit(); } catch (e) { window.close(); }
  }

  function onKeyDown(e) {
    var k = e.keyCode;
    var digit = (k >= 48 && k <= 57) ? k - 48 : ((k >= 96 && k <= 105) ? k - 96 : -1);
    if (digit >= 0) { numKey(digit); e.preventDefault(); return; }
    if (isBack(k)) {
      // vừa quay về lưới từ player (giữ phím/lặp phím) thì không thoát app
      if (!playing && now() - lastBackAt < 800) { e.preventDefault(); return; }
      goBack();
      e.preventDefault();
      return;
    }
    if (k === 13 && numBuf) { commitNum(); e.preventDefault(); return; }
    if (playing) {
      if (k === 38 || k === 33 || k === 427) { zap(1); e.preventDefault(); }
      else if (k === 40 || k === 34 || k === 428) { zap(-1); e.preventDefault(); }
      else if (k === 13) {
        // OK khi đang xem: quay về lưới (bỏ qua nếu vừa mới bấm chọn kênh, tránh lặp phím)
        if (now() - lastPlayAt > 600) stop();
        e.preventDefault();
      }
      else if (k === 37 || k === 39) { showOsd(); e.preventDefault(); }
      return;
    }
    if (zone === 'top' || zone === 'quick') {
      var isQ = zone === 'quick';
      if (k === 37) {
        if (isQ) { if (qSel > 0) qSel--; } else if (topSel > 0) topSel--;
      }
      else if (k === 39) {
        if (isQ) { if (qSel < QN - 1) qSel++; } else if (topSel < tiles.length - 1) topSel++;
      }
      else if (k === 38) {
        if (isQ) { zone = 'top'; topSel = (qSel >= QN - 1) ? 1 : 0; }
      }
      else if (k === 40) {
        if (isQ) {
          if (channels.length) { zone = 'grid'; sel = Math.min(pageOf(sel) * COLS + qSel, channels.length - 1); }
        } else {
          zone = 'quick'; qSel = topSel ? QN - 1 : QN - 2;
        }
      }
      else if (k === 13) {
        // Kích hoạt khi nhả phím (keyup); giữ OK ~0,7s trên ô ứng dụng nhanh thì chọn lại ứng dụng cho ô đó
        if (!e.repeat) { enterDownAt = now(); enterLong = false; }
        else if (isQ && !enterLong && enterDownAt && now() - enterDownAt >= 700) {
          enterLong = true;
          pickQuick(qSel);
        }
      }
      else if (k === 82) { if (isQ) pickQuick(qSel); else return; }
      else return;
      updateSel();
      e.preventDefault();
      return;
    }
    // Hàng kênh
    var page = pageOf(sel);
    if (k === 37) { if (sel % COLS > 0) sel--; }
    else if (k === 39) { if (sel % COLS < COLS - 1 && sel + 1 < channels.length) sel++; }
    else if (k === 38) {
      if (page > 0) sel -= COLS;
      else { zone = 'quick'; qSel = sel % COLS; }
    }
    else if (k === 40) {
      if ((page + 1) * COLS < channels.length) sel = Math.min(sel + COLS, channels.length - 1);
    }
    else if (k === 13) { play(sel); }
    else return;
    showPage();
    updateSel();
    e.preventDefault();
  }

  // Một số bản webOS chỉ gửi phím Back ở sự kiện keyup: dự phòng cho trường hợp đó (khi đang xem)
  function onKeyUp(e) {
    if (e.keyCode === 13 && enterDownAt) {
      var wasLong = enterLong;
      enterDownAt = 0;
      enterLong = false;
      if (!wasLong && !playing) {
        if (zone === 'top') activateTop(topSel);
        else if (zone === 'quick') activateQuick(qSel);
      }
      e.preventDefault();
      return;
    }
    if (isBack(e.keyCode) && playing && now() - lastBackAt > 800) {
      goBack();
      e.preventDefault();
    }
  }

  var pStartX = 0, pStartY = 0;
  var playerEl = $('playerView');

  playerEl.addEventListener('touchstart', function (e) {
    if (!e.touches.length) return;
    pStartX = e.touches[0].clientX;
    pStartY = e.touches[0].clientY;
  }, false);

  playerEl.addEventListener('touchend', function (e) {
    if (!playing || !e.changedTouches.length) return;
    var t = e.target;
    if (t && t.tagName === 'BUTTON') return; // để nút tự xử lý click
    e.preventDefault();
    var dx = e.changedTouches[0].clientX - pStartX;
    var dy = e.changedTouches[0].clientY - pStartY;
    if (Math.abs(dy) > 80 && Math.abs(dy) > Math.abs(dx)) {
      zap(dy < 0 ? 1 : -1); // vuốt lên = kênh sau, vuốt xuống = kênh trước
    } else if ($('ctl').style.display === 'block') {
      hideOsd();
    } else {
      showOsd();
    }
  }, false);

  $('bPrev').addEventListener('click', function () { if (playing) zap(-1); }, false);
  $('bNext').addEventListener('click', function () { if (playing) zap(1); }, false);
  $('bList').addEventListener('click', function () { if (playing) stop(); }, false);

  window.nativeBack = function () {
    if (!playing && now() - lastBackAt < 800) return;
    goBack();
  };
  // Phím điều hướng do Java chuyển vào (down: true = nhấn, false = nhả)
  window.nativeKey = function (down, k, rep) {
    var ev = { keyCode: k, repeat: !!rep, preventDefault: function () {} };
    if (down) onKeyDown(ev); else onKeyUp(ev);
  };
  window.nativeZap = function (d) { if (playing) zap(d); };
  // Bấm Home: đang xem kênh thì về màn hình chọn kênh (không tự phát kênh nào)
  window.nativeHome = function () { numBuf = ''; showNum('', 0); if (playing) stop(); };
  // Quay lại từ màn hình khác (Cài đặt, danh sách ứng dụng...): cập nhật ô ứng dụng nhanh
  window.nativeRefresh = function () {
    enterDownAt = 0;
    enterLong = false;
    refreshWall();
    refreshQuick();
    tick();
    if (playing) { try { var p = video.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // ---------- Khởi động ----------
  tick();
  refreshWall();
  refreshQuick();
  loadChannels(function (list, why) {
    channels = list;
    if (!list.length) {
      zone = 'top';
      updateSel();
      chanRow.innerHTML = '<div class="err">Không đọc được danh sách kênh.<br>' +
        channelPath() + '<br>' + (why || '') + '</div>';
      return;
    }
    render();
    resolveNames();
  });
})();
