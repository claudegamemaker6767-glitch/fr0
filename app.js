(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var USER_HUES = [12, 38, 95, 150, 185, 215, 265, 320];

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function userHue(id) { return USER_HUES[hash(id || 'x') % USER_HUES.length]; }

  var sid = store.get('tree:sid');
  if (!sid) { sid = 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set('tree:sid', sid); }
  var code = store.get('tree:code') || '';
  var myName = store.get('tree:name') || '';
  var active = store.get('tree:active') || 'lobby';

  var ws = null, ready = false, wantOpen = false, retries = 0, retryTimer = null;
  var rooms = [], roomMap = new Map(), msgs = new Map(), seenMem = {};
  var stick = true, pendingSwitch = null, onlineNames = [];

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var toastTimer;
  function toast(t) {
    var n = $('#toast'); n.textContent = t; n.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { n.hidden = true; }, 4500);
  }
  function timeLabel(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(ts) {
    var now = Date.now();
    if (dayKey(ts) === dayKey(now)) return 'Today';
    if (dayKey(ts) === dayKey(now - 864e5)) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function linkify(text, into) {
    var parts = text.split(/(https?:\/\/[^\s<]+)/g);
    parts.forEach(function (p, i) {
      if (i % 2 === 1) {
        var a = el('a', null, p); a.href = p; a.target = '_blank'; a.rel = 'noopener noreferrer'; into.appendChild(a);
      } else if (p) into.appendChild(document.createTextNode(p));
    });
  }
  function slugify(s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); }
  function cleanName(s) { return s.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }

  function getSeen(id) {
    if (seenMem[id] != null) return seenMem[id];
    var v = store.get('tree:seen:' + id);
    seenMem[id] = v == null ? null : +v;
    return seenMem[id];
  }
  function setSeen(id, t) { seenMem[id] = t; store.set('tree:seen:' + id, String(t)); }
  function lastTs(id) { var l = msgs.get(id) || []; return l.length ? l[l.length - 1].ts : 0; }
  function markSeen(id) { var t = lastTs(id); if (t > (getSeen(id) || 0)) setSeen(id, t); }
  function unreadCount(id) {
    var s = getSeen(id) || 0;
    return (msgs.get(id) || []).filter(function (m) { return m.ts > s && m.uid !== sid; }).length;
  }

  /* ---------- rendering ---------- */
  function renderSide() {
    var wrap = $('#rooms'); wrap.replaceChildren();
    var total = 0;
    rooms.forEach(function (r) {
      var n = r.id === active ? 0 : unreadCount(r.id);
      total += n;
      var b = el('button', 'room' + (n > 0 ? ' unread' : ''));
      b.type = 'button'; b.style.setProperty('--h', r.hue);
      if (r.id === active) b.setAttribute('aria-current', 'true');
      b.appendChild(el('span', 'dot'));
      b.appendChild(el('span', 'nm', r.name));
      if (n > 0) b.appendChild(el('span', 'badge', n > 9 ? '9+' : String(n)));
      b.addEventListener('click', function () { switchRoom(r.id); });
      wrap.appendChild(b);
    });
    $('#pip').hidden = total === 0;
    document.title = (total > 0 ? '(' + total + ') ' : '') + 'The Treehouse';
    var av = $('#meAv');
    av.textContent = (myName || '?').trim().charAt(0) || '?';
    av.style.setProperty('--h', userHue(sid));
    $('#meName').textContent = myName || 'Guest';
    var on = $('#online');
    if (ready) {
      on.className = '';
      on.textContent = onlineNames.length + ' online';
      on.title = onlineNames.join(', ');
    } else { on.className = 'off'; on.textContent = 'offline'; on.title = ''; }
  }

  function renderHead() {
    var r = roomMap.get(active);
    if (!r) return;
    $('#hName').textContent = r.name;
    $('#hTopic').textContent = r.topic || '';
    $('#hDot').parentElement.style.setProperty('--h', r.hue);
    $('#input').placeholder = 'Message ' + r.name;
  }

  function emptyState(r) {
    var box = el('div', 'empty');
    box.innerHTML = '<svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="26" fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="3 6"/><path d="M17 31 28 21l11 10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><rect x="21" y="31" width="14" height="9" rx="2" fill="var(--accent)"/></svg>';
    box.appendChild(el('h2', null, 'Nobody has said anything in ' + r.name + ' yet'));
    box.appendChild(el('p', null, 'Write the first message and get it going.'));
    return box;
  }

  function renderFeed() {
    var feed = $('#feed');
    var r = roomMap.get(active);
    if (!r) return;
    var near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    feed.replaceChildren();
    var list = msgs.get(active) || [];
    if (!list.length) feed.appendChild(emptyState(r));
    var prev = null;
    list.forEach(function (m) {
      if (!prev || dayKey(m.ts) !== dayKey(prev.ts)) feed.appendChild(el('div', 'day', dayLabel(m.ts)));
      var cont = prev && prev.uid === m.uid && dayKey(prev.ts) === dayKey(m.ts) && m.ts - prev.ts < 5 * 60 * 1000;
      var row = el('div', 'msg' + (cont ? ' cont' : ''));
      row.style.setProperty('--h', userHue(m.uid));
      if (cont) row.appendChild(el('div', 'gut'));
      else row.appendChild(el('div', 'av', (m.name || '?').trim().charAt(0) || '?'));
      var body = el('div');
      if (!cont) {
        var meta = el('div', 'meta');
        meta.appendChild(el('span', 'name', m.name || 'Someone'));
        if (m.uid === sid) meta.appendChild(el('span', 'you', 'you'));
        meta.appendChild(el('span', 'time', timeLabel(m.ts)));
        body.appendChild(meta);
      }
      var t = el('div', 'txt'); linkify(m.text, t); body.appendChild(t);
      row.appendChild(body);
      if (m.uid === sid) {
        var del = el('button', 'del', 'Delete'); del.type = 'button';
        del.addEventListener('click', function () { sendJson({ type: 'del', room: active, id: m.id }); });
        row.appendChild(del);
      }
      feed.appendChild(row);
      prev = m;
    });
    if (stick || near) { feed.scrollTop = feed.scrollHeight; stick = false; }
    if (document.visibilityState !== 'hidden') markSeen(active);
  }

  function renderAll() { renderSide(); renderHead(); renderFeed(); updateSend(); }
  function updateSend() {
    var can = ready && ws && ws.readyState === 1;
    $('#input').disabled = !can;
    $('#send').disabled = !(can && $('#input').value.trim());
  }

  /* ---------- connection ---------- */
  function sendJson(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function setGateMsg(text, info) { var e = $('#gateErr'); e.textContent = text; e.className = 'err' + (info ? ' info' : ''); }
  function showApp() { $('#gate').hidden = true; $('#app').hidden = false; }
  function showGate() { $('#app').hidden = true; $('#gate').hidden = false; $('#gateGo').disabled = false; }

  function connect() {
    clearTimeout(retryTimer);
    if (ws) { var old = ws; ws = null; try { old.close(); } catch (e) {} }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var mine;
    try { mine = new WebSocket(proto + '//' + location.host); } catch (e) { scheduleRetry(); return; }
    ws = mine;
    mine.onopen = function () {
      if (mine !== ws) return;
      mine.send(JSON.stringify({ type: 'join', code: code, name: myName, sid: sid }));
    };
    mine.onmessage = function (ev) {
      if (mine !== ws) return;
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      handle(d);
    };
    mine.onclose = function () {
      if (mine !== ws) return;
      var was = ready; ready = false;
      updateSend();
      if (!wantOpen) return;
      if (was) { $('#conn').hidden = false; renderSide(); }
      else if (!$('#gate').hidden) setGateMsg('Waking the server up. A free host can take up to a minute. Trying again…', true);
      scheduleRetry();
    };
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retries++;
    var wait = Math.min(1000 * Math.pow(1.6, Math.min(retries, 8)), 12000);
    retryTimer = setTimeout(function () { if (wantOpen) connect(); }, wait);
  }

  function handle(d) {
    switch (d.type) {
      case 'ready':
        ready = true; retries = 0;
        store.set('tree:code', code); store.set('tree:name', myName);
        rooms = d.rooms || [];
        roomMap = new Map(); rooms.forEach(function (r) { roomMap.set(r.id, r); });
        msgs = new Map();
        rooms.forEach(function (r) {
          msgs.set(r.id, (d.history && d.history[r.id]) || []);
          if (getSeen(r.id) == null) setSeen(r.id, lastTs(r.id));
        });
        if (!roomMap.has(active)) active = 'lobby';
        $('#conn').hidden = true;
        showApp(); renderAll();
        break;
      case 'error':
        if (d.reason === 'bad_code') {
          wantOpen = false; code = ''; store.set('tree:code', '');
          showGate(); setGateMsg('That code is not right. Check it with whoever invited you.');
        } else if (d.reason === 'rate') {
          wantOpen = false; showGate(); setGateMsg('Too many wrong tries. Wait ten minutes and try again.');
        } else if (d.reason === 'bad_name') {
          wantOpen = false; showGate(); setGateMsg('Pick a name to use in the chat.');
        } else if (d.reason === 'slow') toast('Easy there, you are sending too fast.');
        else if (d.reason === 'room_limit') toast('That is the most rooms this place can hold.');
        break;
      case 'msg':
        if (!msgs.has(d.room)) break;
        var list = msgs.get(d.room); list.push(d.msg);
        if (list.length > 200) list.splice(0, list.length - 200);
        if (d.room === active && d.msg.uid === sid) stick = true;
        renderSide();
        if (d.room === active) renderFeed();
        break;
      case 'del':
        var l2 = msgs.get(d.room);
        if (l2) { var i = l2.findIndex(function (m) { return m.id === d.id; }); if (i > -1) l2.splice(i, 1); }
        renderSide();
        if (d.room === active) renderFeed();
        break;
      case 'room':
        if (!roomMap.has(d.room.id)) { rooms.push(d.room); roomMap.set(d.room.id, d.room); msgs.set(d.room.id, []); setSeen(d.room.id, 0); }
        renderSide();
        if (pendingSwitch === d.room.id) { pendingSwitch = null; switchRoom(d.room.id); }
        break;
      case 'presence':
        onlineNames = d.names || [];
        renderSide();
        break;
    }
  }

  /* ---------- ui wiring ---------- */
  function switchRoom(id) {
    if (!roomMap.has(id)) return;
    active = id; store.set('tree:active', id); stick = true;
    closeDrawer(); renderAll();
    if (window.matchMedia('(hover: hover)').matches) $('#input').focus();
  }
  function openDrawer() { $('#side').classList.add('open'); $('#scrim').hidden = false; }
  function closeDrawer() { $('#side').classList.remove('open'); $('#scrim').hidden = true; }
  $('#menu').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);

  function autosize() { var t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
  $('#input').addEventListener('input', function () { autosize(); updateSend(); });
  $('#input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#composer').addEventListener('submit', function (e) { e.preventDefault(); send(); });
  function send() {
    var ta = $('#input'), text = ta.value.trim();
    if (!text || !ready) return;
    sendJson({ type: 'msg', room: active, text: text.slice(0, 1000) });
    ta.value = ''; autosize(); updateSend();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { markSeen(active); renderSide(); }
  });

  /* code + name screen */
  $('#codeInput').value = code;
  $('#gateName').value = myName;
  $('#gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var c = $('#codeInput').value.trim(), n = cleanName($('#gateName').value);
    if (!c) { setGateMsg('Type the access code first.'); return; }
    if (!n) { setGateMsg('Pick a name to use in the chat.'); return; }
    code = c; myName = n; wantOpen = true; ready = false; retries = 0;
    $('#gateGo').disabled = true;
    setGateMsg('Checking the code…', true);
    connect();
  });

  /* rename */
  $('#rename').addEventListener('click', function () {
    $('#nameInput').value = myName; $('#nameErr').textContent = '';
    $('#nameModal').hidden = false;
    setTimeout(function () { $('#nameInput').focus(); $('#nameInput').select(); }, 0);
  });
  $('#nameCancel').addEventListener('click', function () { $('#nameModal').hidden = true; });
  $('#nameForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = cleanName($('#nameInput').value);
    if (!n) { $('#nameErr').textContent = 'Type a name first.'; return; }
    myName = n; store.set('tree:name', n);
    sendJson({ type: 'rename', name: n });
    $('#nameModal').hidden = true; renderSide();
  });

  /* leave */
  $('#leave').addEventListener('click', function () {
    wantOpen = false; store.set('tree:code', '');
    if (ws) { try { ws.close(); } catch (e) {} }
    location.reload();
  });

  /* new room */
  $('#addRoom').addEventListener('click', function () {
    $('#roomName').value = ''; $('#roomTopic').value = ''; $('#roomErr').textContent = '';
    $('#roomModal').hidden = false;
    setTimeout(function () { $('#roomName').focus(); }, 0);
  });
  $('#roomCancel').addEventListener('click', function () { $('#roomModal').hidden = true; });
  $('#roomForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = slugify($('#roomName').value);
    if (!id) { $('#roomErr').textContent = 'Use letters or numbers in the name.'; return; }
    $('#roomModal').hidden = true;
    if (roomMap.has(id)) { switchRoom(id); return; }
    pendingSwitch = id;
    sendJson({ type: 'newroom', name: id, topic: $('#roomTopic').value.trim().slice(0, 80) });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#roomModal').hidden) $('#roomModal').hidden = true;
    else if (!$('#nameModal').hidden) $('#nameModal').hidden = true;
    else closeDrawer();
  });

  /* ---------- start ---------- */
  if (code && myName) {
    wantOpen = true;
    $('#gateGo').disabled = true;
    setGateMsg('Joining…', true);
    connect();
  } else {
    setTimeout(function () { (code ? $('#gateName') : $('#codeInput')).focus(); }, 0);
  }
})();
