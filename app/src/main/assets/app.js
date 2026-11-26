(function () {
  'use strict';

  // Android: file nằm ở thư mục riêng của app, đường dẫn do phần Java cung cấp
  var BRIDGE = window.AndroidBridge || null;
  function channelPath() { try { return BRIDGE.getPath(); } catch (e) { return ''; } }
  var API = 'https://api.vtvdigital.org/live-channel/v21.0/playback/source';
  var COLS = 6;       // số kênh mỗi hàng (mỗi "trang" của hàng kênh)
  var QN = 6;         // số ô ứng dụng nhanh

  var zone = 'grid';  // 'top' = 3 icon Nguồn/Cài đặt/Ứng dụng, 'quick' = hàng ứng dụng nhanh, 'grid' = hàng kênh
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
  // Ưu tiên gọi qua phía Java (không phụ thuộc quy tắc CORS/phiên bản WebView); nếu không được thì thử lại bằng XHR trong WebView.
  // cb(err, {sources:[url,...], name:string})

  // Đọc phản hồi JSON của API -> {err} hoặc {data}
  function parseSources(status, text) {
    if (status !== 200) return { err: 'API trả về mã ' + status };
    var j;
    try { j = JSON.parse(text); } catch (e) { return { err: 'Phản hồi API không đọc được' }; }
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
    if (!urls.length) return { err: 'API không trả về nguồn phát nào cho kênh này' };
    return { data: { sources: urls, name: (j.data && j.data.channelName) || null } };
  }

  function apiBody(id) {
    return JSON.stringify({ channelId: String(id), platform: 'webPC', deviceId: deviceId });
  }

  // Gọi bằng XHR trong WebView. cb(status, text, errMsg)
  function xhrCall(id, cb) {
    var x = new XMLHttpRequest();
    var done = false;
    function finish(st, tx, er) { if (!done) { done = true; cb(st, tx, er); } }
    try {
      x.open('POST', API, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 12000;
      x.ontimeout = function () { finish(0, '', 'quá thời gian chờ'); };
      x.onerror = function () { finish(0, '', 'không gọi được (mạng hoặc bị chặn)'); };
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        finish(x.status, x.responseText, x.status ? '' : 'WebView không nhận được phản hồi (mã 0)');
      };
      x.send(apiBody(id));
    } catch (e) { finish(0, '', 'lỗi ' + e); }
  }

  // Gọi qua Java. cb(status, text, errMsg); không có cầu nối thì trả status -1
  var apiCbs = {};
  var apiSeq = 0;
  window.nativeApiResult = function (token, status, text, err) {
    var f = apiCbs[token];
    if (!f) return;
    delete apiCbs[token];
    f(status, text, err);
  };
  function nativeCall(id, cb) {
    if (!BRIDGE || typeof BRIDGE.apiPost !== 'function') { cb(-1, '', 'không có cầu nối Java'); return; }
    var token = 'a' + (++apiSeq);
    apiCbs[token] = cb;
    try { BRIDGE.apiPost(token, API, apiBody(id)); }
    catch (e) { delete apiCbs[token]; cb(-1, '', 'lỗi cầu nối: ' + e); }
  }

  function fetchSources(id, cb) {
    var done = false;
    function finish(err, data) { if (!done) { done = true; cb(err, data); } }
    nativeCall(id, function (st1, tx1, er1) {
      var r1 = st1 > 0 ? parseSources(st1, tx1) : { err: 'Java: ' + er1 };
      if (r1.data) { finish(null, r1.data); return; }
      // Java không thành công: thử lại bằng WebView
      xhrCall(id, function (st2, tx2, er2) {
        var r2 = st2 > 0 ? parseSources(st2, tx2) : { err: 'WebView: ' + er2 };
        if (r2.data) { finish(null, r2.data); return; }
        finish(r1.err + ' | ' + r2.err);
      });
    });
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
  // Màu ngẫu nhiên cho từng ô kênh, chọn lại mỗi lần khởi động; 2 ô cạnh nhau luôn khác tông màu
  function hsvHex(h, sv, v) {
    var c = v * sv, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r, g, b;
    if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
    function p(n) { var t = Math.round((n + m) * 255).toString(16); return t.length < 2 ? '0' + t : t; }
    return '#' + p(r) + p(g) + p(b);
  }
  var tileHues = [];
  function tileColorFor(i) {
    while (tileHues.length <= i) {
      var prev = tileHues.length ? tileHues[tileHues.length - 1] : -999;
      var h, tries = 0;
      do {
        h = Math.random() * 360;
        var d = Math.abs(h - prev);
        if (d > 180) d = 360 - d;
        tries++;
      } while (d < 60 && tries < 50); // cách ít nhất 60° trên vòng màu so với ô bên trái
      tileHues.push(h);
    }
    return hsvHex(tileHues[i], 0.55 + Math.random() * 0.2, 0.52 + Math.random() * 0.14);
  }
  var tileColors = [];
  // Chọn lại toàn bộ màu ô kênh và vẽ lại hàng đang hiển thị (gọi mỗi khi bấm Home / thoát ra từ app khác)
  function reshuffleColors() {
    tileHues = [];
    tileColors = [];
    if (channels.length) render();
  }
  function chanColorOf(i) {
    if (!tileColors[i]) tileColors[i] = tileColorFor(i);
    return tileColors[i];
  }

  function paintTile(el, hex) {
    var c = hexRgb(hex);
    el.style.background = 'linear-gradient(145deg,' + shade(c, 0.16) + ',' + shade(c, -0.2) + ')';
  }

  // ---------- Hàng kênh: mỗi lần hiện 6 kênh, ▲▼ chuyển 6 kênh trước/sau ----------
  var chanRow = $('chanRow');
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
      paintTile(d, chanColorOf(i));
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
    var fails = 0; // API lỗi liên tiếp 3 lần thì dừng, đỡ gọi vô ích cả chục kênh
    (function step() {
      if (!q.length) return;
      if (playing) { setTimeout(step, 2000); return; }
      var i = q.shift();
      var ch = channels[i];
      fetchSources(ch.vtvgoId, function (err, data) {
        if (err) { if (++fails >= 3) return; } else { fails = 0; }
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

  // ---------- 3 icon góc phải: Nguồn tín hiệu / Cài đặt / Ứng dụng ----------
  var tiles = [$('tSource'), $('tSettings'), $('tApps')];

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
      if (i === 0) { openSources(); return; }
      if (i === 1) BRIDGE.openSettings();
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

  // ---------- Chọn nguồn tín hiệu (HDMI / AV / USB...) ----------
  var srcOpen = false;
  var srcItems = [];
  var srcSel = 0;
  var srcOv = $('srcOverlay');
  var srcListEl = $('srcList');
  var SRC_H = 64; // chiều cao 1 dòng + khoảng cách (56 + 8)

  function srcStateText(st) {
    if (st === 2) return 'Có tín hiệu';
    if (st === 1) return 'Đang chờ';
    if (st === 0) return 'Chưa có tín hiệu';
    return '';
  }

  function srcRender() {
    var html = '';
    if (!srcItems.length) {
      html = '<div class="sempty">Không tìm thấy cổng vào nào trên TV này.<br>Máy có thể không hỗ trợ chọn nguồn từ ứng dụng; hãy dùng nút INPUT / SOURCE trên remote của TV.</div>';
    }
    for (var i = 0; i < srcItems.length; i++) {
      var it = srcItems[i];
      var cls = 'si' + (it.state === 2 ? ' on' : (it.state === 0 ? ' off' : '')) + (i === srcSel ? ' sel' : '');
      html += '<div class="' + cls + '" data-i="' + i + '"><span class="sn">' + esc(it.label) +
        '</span><span class="ss">' + esc(srcStateText(it.state)) + '</span></div>';
    }
    srcListEl.innerHTML = html;
    // cuộn để dòng đang chọn luôn nằm trong khung
    var top = srcSel * SRC_H, view = srcListEl.clientHeight || 392;
    if (top < srcListEl.scrollTop) srcListEl.scrollTop = top;
    else if (top + SRC_H > srcListEl.scrollTop + view) srcListEl.scrollTop = top + SRC_H - view;
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function openSources() {
    var list = [];
    try { list = JSON.parse(BRIDGE.getInputs() || '[]') || []; } catch (e) { list = []; }
    srcItems = list;
    srcSel = 0; // danh sách đã xếp sẵn: cổng có tín hiệu nằm trên cùng
    srcOpen = true;
    srcOv.style.display = 'block';
    srcListEl.scrollTop = 0;
    srcRender();
  }

  function closeSources() {
    srcOpen = false;
    srcOv.style.display = 'none';
  }

  // builtin = true: xem thẳng trong launcher (dự phòng khi ứng dụng TV của hãng không chuyển được nguồn)
  function activateSource(i, builtin) {
    var it = srcItems[i];
    if (!it) return;
    closeSources();
    try { BRIDGE.openInput(it.id, it.label, !!builtin); } catch (e) {}
  }

  // Phím khi hộp nguồn đang mở; trả về true nếu đã xử lý
  function srcKey(k, rep) {
    if (k === 38) { if (srcSel > 0) srcSel--; srcRender(); }
    else if (k === 40) { if (srcSel < srcItems.length - 1) srcSel++; srcRender(); }
    else if (k === 13) { if (!rep) activateSource(srcSel, false); }
    else if (k === 39) { if (!rep) activateSource(srcSel, true); }
    return true; // chặn mọi phím khác khi hộp đang mở
  }

  srcOv.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== srcOv && !(t.getAttribute && t.getAttribute('data-i') !== null)) t = t.parentNode;
    if (t && t !== srcOv) { activateSource(parseInt(t.getAttribute('data-i'), 10), false); return; }
    if (e.target === srcOv) closeSources();
  }, false);

  // ---------- Đồng hồ ----------
  // ---------- Âm lịch Việt Nam (thuật toán Hồ Ngọc Đức, múi giờ UTC+7) ----------
  var CAN = ['Giáp', 'Ất', 'Bính', 'Đinh', 'Mậu', 'Kỷ', 'Canh', 'Tân', 'Nhâm', 'Quý'];
  var CHI = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];
  var PI = Math.PI;

  function jdFromDate(dd, mm, yy) {
    var a = Math.floor((14 - mm) / 12);
    var y = yy + 4800 - a;
    var m = mm + 12 * a - 3;
    var jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    if (jd < 2299161) jd = dd + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
    return jd;
  }
  function newMoon(k) {
    var T = k / 1236.85, T2 = T * T, T3 = T2 * T, dr = PI / 180;
    var Jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
    Jd1 = Jd1 + 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
    var M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
    var Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
    var F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
    var C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
    C1 = C1 - 0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr);
    C1 = C1 - 0.0004 * Math.sin(dr * 3 * Mpr);
    C1 = C1 + 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr));
    C1 = C1 - 0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M));
    C1 = C1 - 0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr));
    C1 = C1 + 0.0010 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M));
    var deltat;
    if (T < -11) deltat = 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3;
    else deltat = -0.000278 + 0.000265 * T + 0.000262 * T2;
    return Jd1 + C1 - deltat;
  }
  function sunLongitude(jdn) {
    var T = (jdn - 2451545.0) / 36525, T2 = T * T, dr = PI / 180;
    var M = 357.52910 + 35999.05030 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
    var L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
    var DL = (1.914600 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
    DL = DL + (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.000290 * Math.sin(dr * 3 * M);
    var L = (L0 + DL) * dr;
    L = L - PI * 2 * Math.floor(L / (PI * 2));
    return L;
  }
  function sunLongitudeIdx(dayNumber, tz) { return Math.floor(sunLongitude(dayNumber - 0.5 - tz / 24) / PI * 6); }
  function newMoonDay(k, tz) { return Math.floor(newMoon(k) + 0.5 + tz / 24); }
  function lunarMonth11(yy, tz) {
    var off = jdFromDate(31, 12, yy) - 2415021;
    var k = Math.floor(off / 29.530588853);
    var nm = newMoonDay(k, tz);
    if (sunLongitudeIdx(nm, tz) >= 9) nm = newMoonDay(k - 1, tz);
    return nm;
  }
  function leapMonthOffset(a11, tz) {
    var k = Math.floor((a11 - 2415021.076998695) / 29.530588853 + 0.5);
    var last = 0, i = 1;
    var arc = sunLongitudeIdx(newMoonDay(k + i, tz), tz);
    do {
      last = arc;
      i++;
      arc = sunLongitudeIdx(newMoonDay(k + i, tz), tz);
    } while (arc !== last && i < 14);
    return i - 1;
  }
  // -> {day, month, year, leap, jd}
  function solarToLunar(dd, mm, yy, tz) {
    var dayNumber = jdFromDate(dd, mm, yy);
    var k = Math.floor((dayNumber - 2415021.076998695) / 29.530588853);
    var monthStart = newMoonDay(k + 1, tz);
    if (monthStart > dayNumber) monthStart = newMoonDay(k, tz);
    var a11 = lunarMonth11(yy, tz);
    var b11 = a11;
    var lunarYear;
    if (a11 >= monthStart) { lunarYear = yy; a11 = lunarMonth11(yy - 1, tz); }
    else { lunarYear = yy + 1; b11 = lunarMonth11(yy + 1, tz); }
    var lunarDay = dayNumber - monthStart + 1;
    var diff = Math.floor((monthStart - a11) / 29);
    var lunarLeap = false;
    var lunarMonth = diff + 11;
    if (b11 - a11 > 365) {
      var leapOff = leapMonthOffset(a11, tz);
      if (diff >= leapOff) {
        lunarMonth = diff + 10;
        if (diff === leapOff) lunarLeap = true;
      }
    }
    if (lunarMonth > 12) lunarMonth -= 12;
    if (lunarMonth >= 11 && diff < 4) lunarYear -= 1;
    return { day: lunarDay, month: lunarMonth, year: lunarYear, leap: lunarLeap, jd: dayNumber };
  }
  // Trả về 2 dòng chữ âm lịch
  function lunarLines(d) {
    var L = solarToLunar(d.getDate(), d.getMonth() + 1, d.getFullYear(), 7);
    var ngay = CAN[(L.jd + 9) % 10] + ' ' + CHI[(L.jd + 1) % 12];
    var thang = CAN[(L.year * 12 + L.month + 3) % 10] + ' ' + CHI[(L.month + 1) % 12];
    var nam = CAN[(L.year + 6) % 10] + ' ' + CHI[(L.year + 8) % 12];
    return [
      'Âm lịch: ' + L.day + '/' + L.month + (L.leap ? ' nhuận' : '') + ' - ngày ' + ngay + ',',
      'tháng ' + thang + (L.leap ? ' (nhuận)' : '') + ', năm ' + nam
    ];
  }

  var lastTime = '', lastDate = '';
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function tick() {
    var d = new Date();
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var dt = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    if (t !== lastTime) { lastTime = t; $('time').textContent = t; }
    if (dt !== lastDate) {
      lastDate = dt;
      $('date').textContent = 'Dương lịch: ' + dt;
      try {
        var ln = lunarLines(d);
        $('lunar1').textContent = ln[0];
        $('lunar2').textContent = ln[1];
      } catch (e) { $('lunar1').textContent = ''; $('lunar2').textContent = ''; }
    }
  }
  setInterval(function () { if (!playing) tick(); }, 1000);

  // ---------- Hình nền (ảnh ngẫu nhiên trong thư mục dữ liệu của app) ----------
  var wallStamp = null;
  function refreshWall() {
    var st = '';
    try { st = BRIDGE.getBackgroundStamp() || ''; } catch (e) { st = ''; }
    if (st === wallStamp) return;
    wallStamp = st;
    var wall = $('wall');
    var uri = '';
    if (st) {
      try { uri = BRIDGE.getBackground() || ''; } catch (e) { uri = ''; }
    }
    if (uri && (uri.indexOf('file:') === 0 || uri.indexOf('data:image/') === 0)) {
      // Nạp thử ảnh trước: được thì mới đặt làm nền, lỗi thì giữ hình nền mặc định
      var im = new Image();
      im.onload = function () { wall.style.backgroundImage = 'url("' + uri + '")'; };
      im.onerror = function () { wall.style.backgroundImage = ''; };
      im.src = uri;
    } else {
      wall.style.backgroundImage = ''; // về hình nền mặc định trong style.css
    }
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
    if (srcOpen) { closeSources(); return; }
    if (playing) { stop(); return; }
    // Đang là launcher (màn hình Home) thì Back ở danh sách kênh không làm gì; chạy như app thường thì thoát
    var isHome = false;
    try { isHome = BRIDGE.isDefaultHome(); } catch (e) { isHome = false; }
    if (isHome) return;
    try { BRIDGE.exit(); } catch (e) { window.close(); }
  }

  function onKeyDown(e) {
    var k = e.keyCode;
    if (srcOpen && !isBack(k)) { srcKey(k, e.repeat); e.preventDefault(); return; }
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
        if (isQ) { zone = 'top'; topSel = Math.max(0, tiles.length - 1 - (QN - 1 - qSel)); }
      }
      else if (k === 40) {
        if (isQ) {
          if (channels.length) { zone = 'grid'; sel = Math.min(pageOf(sel) * COLS + qSel, channels.length - 1); }
        } else {
          zone = 'quick'; qSel = QN - 1 - (tiles.length - 1 - topSel);
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
    if (srcOpen) { enterDownAt = 0; enterLong = false; return; }
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
  window.nativeHome = function () { closeSources(); numBuf = ''; showNum('', 0); if (playing) stop(); refreshWall(); reshuffleColors(); };
  // Quay lại từ màn hình khác (Cài đặt, danh sách ứng dụng...): cập nhật ô ứng dụng nhanh
  window.nativeRefresh = function () {
    closeSources();
    enterDownAt = 0;
    enterLong = false;
    refreshWall();
    reshuffleColors();
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
