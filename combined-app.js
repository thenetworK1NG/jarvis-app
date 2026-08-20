/* J.A.R.V.I.S. Command — combined deck
 * - Talk: uses a shared Firebase sync path (jarvischat/sync) so the phone
 *   and PC see the same messages in real time.
 * - Transfer: reuses the wetransfer phone app engine (app.js) untouched.
 * - Wake: if J.A.R.V.I.S. is offline, writes a wake request to Firebase that
 *   the PC-side wake_listener.py watches and uses to boot jarvis.py.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var firebaseOk = (typeof firebase !== 'undefined' && firebase.initializeApp);
  var DB = null;
  var SYNC = null, STATUS = null, WAKE = null, WAKE_LISTENER = null;
  if (firebaseOk) {
    try {
      DB = firebase.database();
      SYNC = DB.ref('jarvischat/sync');
      STATUS = DB.ref('jarvischat/status');
      WAKE = DB.ref('jarvischat/wake');
      WAKE_LISTENER = DB.ref('jarvischat/wakeListener');
    } catch (e) { DB = null; }
  }

  var online = false;
  var pendingWake = false;
  var wakeListenerArmed = false;
  var lastWakeSent = 0;
  var wakeTimeoutTimer = null;
  var booting = false;

  function myLabel() {
    try {
      if (window.getSessionUser) {
        var u = getSessionUser();
        if (u) return u;
      }
      if (window.getDeviceName) return getDeviceName();
    } catch (e) {}
    return 'JARVIS-Command';
  }

  /* ── tab bar ──────────────────────────────────────── */
  var tabs = { talk: $('tab-talk'), transfer: $('tab-transfer'), wake: $('tab-wake') };

  function updateTabs(screenId) {
    var active = (screenId === 'talk') ? 'talk' : (screenId === 'sites') ? 'sites' : 'transfer';
    tabs.talk.classList.toggle('active', active === 'talk');
    tabs.transfer.classList.toggle('active', active === 'transfer');
    if (sitesTabEl) sitesTabEl.classList.toggle('active', active === 'sites');
  }

  // Wrap app.js's showScreen so the tab bar stays in sync with every screen
  // change, including ones app.js makes itself (startApp, disconnect, logout).
  var _origShow = window.showScreen;
  if (typeof _origShow === 'function') {
    window.showScreen = function (id) {
      _origShow(id);
      updateTabs(id);
    };
  }

  tabs.talk.addEventListener('click', function () {
    showScreen('talk');
  });
  tabs.transfer.addEventListener('click', function () {
    var st = window.state;
    if (st === 'connecting' || st === 'connected') {
      showScreen(st);
    } else if (window.getSessionUser && getSessionUser()) {
      showScreen('home');
    } else {
      showScreen('login');
    }
  });

  /* ── J.A.R.V.I.S. online / wake status ─────────────── */
  function isOnlineVal(v) {
    return !!(v && v.online && (Date.now() - (v.ts || 0)) < 25000);
  }

  function paintHud() {
    var pill = $('hud-status');
    var linked = !!(window.autoConnected);

    if (pill) {
      if (linked) {
        pill.className = 'hud-pill linked';
        pill.textContent = 'LINKED';
      } else if (booting || pendingWake) {
        pill.className = 'hud-pill waking';
        pill.textContent = 'WAKING';
      } else if (online) {
        pill.className = 'hud-pill up';
        pill.textContent = 'ONLINE';
      } else {
        pill.className = 'hud-pill down';
        pill.textContent = 'OFFLINE';
      }
    }
    paintWakeStrip();
  }

  function paintWakeStrip() {
    var strip = $('wake-strip');
    var sub = $('wake-sub');
    var btn = $('btn-wake');

    // Drive the WAKE tab visual state
    var wakeTab = $('tab-wake');
    if (wakeTab) {
      var wState = (online && !pendingWake) ? 'online'
        : (pendingWake || booting) ? 'waking'
        : wakeListenerArmed ? 'armed'
        : 'offline';
      wakeTab.dataset.wakeState = wState;
      var lbl = wakeTab.querySelector('.wake-label');
      if (lbl) lbl.textContent = wState === 'waking' ? 'WAKING' : wState === 'online' ? 'ONLINE' : 'WAKE';
    }

    if (!strip || !btn) return;

    if (online && !pendingWake) {
      strip.classList.add('hidden');
      return;
    }
    strip.classList.remove('hidden');

    if (pendingWake) {
      btn.disabled = true;
      btn.classList.remove('armed');
      btn.classList.add('done');
      btn.textContent = 'WAKING';
      if (sub) sub.textContent = 'Wake signal sent — booting J.A.R.V.I.S. on his PC…';
    } else if (wakeListenerArmed) {
      btn.disabled = false;
      btn.classList.add('armed');
      btn.classList.remove('done');
      btn.textContent = 'WAKE';
      if (sub) sub.textContent = 'Remote wake armed · tap WAKE to boot him';
    } else {
      btn.disabled = false;
      btn.classList.remove('armed', 'done');
      btn.textContent = 'WAKE';
      if (sub) sub.textContent = 'Wake listener not running on his PC — open the wake listener to boot him remotely';
    }
  }

  function sendWakeRequest() {
    if (!WAKE) { toast('No network to reach the wake channel.'); return; }
    if (online || pendingWake) return;
    pendingWake = true;
    booting = true;
    lastWakeSent = Date.now();
    WAKE.set({ by: myLabel(), ts: Date.now(), status: 'request' });
    paintHud();
    toast('Wake signal sent, sir.');
    if (wakeTimeoutTimer) clearTimeout(wakeTimeoutTimer);
    wakeTimeoutTimer = setTimeout(function () {
      if (pendingWake && !online) {
        pendingWake = false;
        booting = false;
        paintHud();
        toast('No response — is the wake listener running on his PC?');
      }
    }, 60000);
  }

  var wakeBtn = $('btn-wake');
  if (wakeBtn) wakeBtn.addEventListener('click', sendWakeRequest);

  // WAKE center tab click
  var tabWakeEl = $('tab-wake');
  if (tabWakeEl) {
    tabWakeEl.addEventListener('click', function () {
      if (online && !pendingWake) { toast('J.A.R.V.I.S. is already online.'); return; }
      if (pendingWake) { toast('Wake signal already sent…'); return; }
      sendWakeRequest();
    });
  }

  if (STATUS) {
    STATUS.on('value', function (snap) {
      online = isOnlineVal(snap.val());
      if (online) {
        pendingWake = false;
        booting = false;
        if (wakeTimeoutTimer) { clearTimeout(wakeTimeoutTimer); wakeTimeoutTimer = null; }
      }
      paintHud();
    });
  }

  if (WAKE) {
    WAKE.on('value', function (snap) {
      var v = snap.val();
      if (!v) return;
      if (v.status === 'ack') {
        pendingWake = false;
        booting = false;
        if (wakeTimeoutTimer) { clearTimeout(wakeTimeoutTimer); wakeTimeoutTimer = null; }
        paintHud();
        if (!online) toast('J.A.R.V.I.S. is booting on his PC.');
      }
    });
  }

  if (WAKE_LISTENER) {
    WAKE_LISTENER.on('value', function (snap) {
      var v = snap.val();
      wakeListenerArmed = !!(v && v.online && (Date.now() - (v.ts || 0)) < 60000);
      paintWakeStrip();
    });
  }

  /* ── toast ─────────────────────────────────────────── */
  var toastEl = $('toast');
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  /* ── chat ──────────────────────────────────────────── */
  var messagesEl = $('messages');
  var inputEl = $('input');
  var rendered = {};
  var typingEl = null;
  var activeChatId = null;
  try {
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'jarvis-chat-active') {
        activeChatId = e.data.chatId;
      }
    });
  } catch (e) {}

  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  var URL_RE = /(https?:\/\/[^\s<>'")\]]+)/g;
  function linkify(s) {
    var parts = s.split(URL_RE);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var a = document.createElement('a');
        a.href = parts[i];
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = parts[i];
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(parts[i]));
      }
    }
    return frag;
  }

  function bubble(cls, text, ts) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.appendChild(linkify(text));
    var t = document.createElement('span');
    t.className = 'time';
    t.textContent = fmtTime(ts);
    el.appendChild(t);
    // Tap to copy
    el.addEventListener('click', function () {
      if (window.getSelection && window.getSelection().toString()) return;
      var raw = (cls === 'me' ? 'You: ' : 'J.A.R.V.I.S.: ') + text;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(raw).then(function () { toast('Copied to clipboard'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = raw; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Copied to clipboard'); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
    return el;
  }

  function stepBubble(text) {
    var el = document.createElement('div');
    el.className = 'msg step';
    el.textContent = text;
    return el;
  }

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function showTyping() {
    if (typingEl) return;
    thinkingState = true;
    paintChatStatus(true, false);
    typingEl = document.createElement('div');
    typingEl.className = 'typing';
    for (var i = 0; i < 3; i++) {
      var d = document.createElement('span');
      d.className = 'dot';
      typingEl.appendChild(d);
    }
    messagesEl.appendChild(typingEl);
    scrollBottom();
  }
  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
    thinkingState = false;
    paintChatStatus(true, false);
  }

  function renderSteps(steps) {
    if (!steps || typeof steps !== 'object') return;
    var keys = Object.keys(steps).sort();
    for (var i = 0; i < keys.length; i++) {
      var s = steps[keys[i]];
      if (!s) continue;
      var label = '';
      if (s.type === 'tool') {
        label = (s.name || 'tool') + (s.target ? ' ' + s.target : '');
        if (s.status) label += ' \u2022 ' + s.status;
      } else if (s.type === 'step') {
        label = 'Working\u2026 step ' + (s.stage || '');
      } else if (s.text) {
        label = s.text;
      }
      if (label) messagesEl.appendChild(stepBubble(label));
    }
  }

  function render(msg, key) {
    if (rendered[key]) return;
    rendered[key] = true;
    var text = (msg.text || '').trim();
    var reply = (msg.reply || '').trim();
    if (text) messagesEl.appendChild(bubble('me', text, msg.ts));
    if (msg.steps) renderSteps(msg.steps);
    if (reply) {
      messagesEl.appendChild(bubble('jarvis', reply, msg.repliedAt || msg.ts));
    }
    scrollBottom();
  }

  function update(msg, key) {
    if (!rendered[key]) { render(msg, key); return; }
    var reply = (msg.reply || '').trim();
    if (reply && !rendered[key + ':r']) {
      rendered[key + ':r'] = true;
      messagesEl.appendChild(bubble('jarvis', reply, msg.repliedAt || msg.ts));
      scrollBottom();
      if (window._jarvisTTS) window._jarvisTTS(reply);
    }
  }

  if (SYNC) {
    SYNC.orderByChild('ts').on('child_added', function (snap) {
      var msg = snap.val() || {};
      var key = snap.key;
      if (rendered[key]) return;
      var sender = msg.sender || '';
      var text = (msg.text || '').trim();
      var replyData = msg.reply_data || {};
      var reply = (replyData.reply || msg.reply || '').trim();
      if (sender === 'user' && text) {
        rendered[key] = true;
        messagesEl.appendChild(bubble('me', text, msg.ts));
        scrollBottom();
      }
      if (sender === 'assistant' && reply && !rendered[key + ':r']) {
        rendered[key + ':r'] = true;
        if (!rendered[key]) {
          messagesEl.appendChild(bubble('me', text || '(phone message)', msg.ts));
        }
        messagesEl.appendChild(bubble('jarvis', reply, replyData.repliedAt || msg.repliedAt || msg.ts));
        if (replyData.steps || msg.steps) renderSteps(replyData.steps || msg.steps);
        scrollBottom();
        if (window._jarvisTTS) window._jarvisTTS(reply);
      }
      if (!sender && text && !reply) {
        rendered[key] = true;
        messagesEl.appendChild(bubble('me', text, msg.ts));
        scrollBottom();
      }
    });
    SYNC.orderByChild('ts').on('child_changed', function (snap) {
      var msg = snap.val() || {};
      var key = snap.key;
      var replyData = msg.reply_data || {};
      var reply = (replyData.reply || msg.reply || '').trim();
      var sender = msg.sender || '';
      if (sender === 'assistant' && reply && !rendered[key + ':r']) {
        rendered[key + ':r'] = true;
        messagesEl.appendChild(bubble('jarvis', reply, replyData.repliedAt || msg.repliedAt || Date.now()));
        if (replyData.steps || msg.steps) renderSteps(replyData.steps || msg.steps);
        scrollBottom();
        hideTyping();
        if (window._jarvisTTS) window._jarvisTTS(reply);
      }
    });
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
  }

  function sendChat() {
    var text = inputEl.value.trim();
    if (!text) return;
    if (!SYNC) { toast('No chat link — is Firebase reachable?'); return; }
    var chatId = activeChatId || window.activeChatId || 'default';
    showTyping();
    SYNC.push({
      chatId: chatId,
      sender: 'user',
      text: text,
      ts: Date.now(),
      processed: false,
      from: 'phone'
    });
    inputEl.value = '';
    autoGrow();
    inputEl.focus();
  }
  $('send').addEventListener('click', sendChat);
  // Enter always inserts a newline — send only via the button.
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var pos = inputEl.selectionStart;
      var val = inputEl.value;
      inputEl.value = val.slice(0, pos) + '\n' + val.slice(inputEl.selectionEnd);
      inputEl.selectionStart = inputEl.selectionEnd = pos + 1;
      autoGrow();
    }
  });
  inputEl.addEventListener('input', autoGrow);

  /* clear chat */
  var clearBackdrop = $('clearBackdrop');
  $('clearChat').addEventListener('click', function () { clearBackdrop.classList.add('show'); });
  $('clearCancel').addEventListener('click', function () { clearBackdrop.classList.remove('show'); });
  $('clearGo').addEventListener('click', function () {
    clearBackdrop.classList.remove('show');
    if (SYNC) SYNC.remove().catch(function () {});
    rendered = {};
    messagesEl.innerHTML = '';
    hideTyping();
    toast('Comms log cleared');
  });

  /* chat status (inside comms log) */
  var statusEl = $('conn-status');
  var buildEl = $('build-status');
  var thinkingState = false;
  function paintChatStatus(o, build) {
    if (thinkingState && o) {
      statusEl.className = 'thinking';
      statusEl.textContent = 'thinking';
    } else {
      statusEl.className = o ? 'up' : 'down';
      statusEl.textContent = o ? 'online' : 'offline';
    }
    if (buildEl) buildEl.classList.toggle('hidden', !build);
  }
  function checkStatus() {
    if (!STATUS) { paintChatStatus(false, false); return; }
    STATUS.once('value').then(function (snap) {
      var v = snap.val();
      if (!v || !v.online) { paintChatStatus(false, false); return; }
      paintChatStatus((Date.now() - (v.ts || 0)) < 25000, !!v.build);
    }).catch(function () { paintChatStatus(false, false); });
  }
  if (STATUS) { STATUS.on('value', checkStatus); }
  setInterval(checkStatus, 5000);
  checkStatus();

  /* ── install as PWA ────────────────────────────────── */
  var installBtn = $('install');
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.classList.add('show');
  });
  installBtn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () {
      deferredPrompt = null;
      installBtn.classList.remove('show');
    });
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    installBtn.classList.remove('show');
  });

  /* ── text-to-speech (JARVIS voice replies) ─────────── */
  (function initTTS() {
    var synth = window.speechSynthesis;
    var voiceBtn = $('voice-btn');
    if (!synth || !voiceBtn) return;

    var enabled = false;
    var selectedVoice = null;

    function pickBestVoice() {
      var voices = synth.getVoices();
      if (!voices || !voices.length) return;
      // Priority: male neural voices first, then any online en voice
      var matchers = [
        function(v) { return /microsoft.*guy.*online/i.test(v.name); },
        function(v) { return /microsoft.*davis.*online/i.test(v.name); },
        function(v) { return /microsoft.*ryan.*online/i.test(v.name); },
        function(v) { return /microsoft.*christopher.*online/i.test(v.name); },
        function(v) { return /microsoft.*eric.*online/i.test(v.name); },
        function(v) { return /microsoft.*guy/i.test(v.name) && /en/i.test(v.lang); },
        function(v) { return /microsoft.*david/i.test(v.name) && /en/i.test(v.lang); },
        function(v) { return /microsoft.*neural/i.test(v.name) && /en/i.test(v.lang) && !/aria|jenny|sonia|natasha|leah|mia|clara|libby|maisie/i.test(v.name); },
        function(v) { return /google uk english male/i.test(v.name); },
        function(v) { return /google.*male/i.test(v.name) && /en/i.test(v.lang); },
        function(v) { return /google/i.test(v.name) && /en-US/i.test(v.lang) && !v.localService; },
        function(v) { return /en-US/i.test(v.lang) && !v.localService; },
        function(v) { return /microsoft/i.test(v.name) && /en-US/i.test(v.lang); },
        function(v) { return /en-US/i.test(v.lang); },
        function(v) { return /en/i.test(v.lang); },
      ];
      for (var i = 0; i < matchers.length; i++) {
        var v = voices.filter(matchers[i])[0];
        if (v) { selectedVoice = v; break; }
      }
    }

    pickBestVoice();
    if (typeof synth.onvoiceschanged !== 'undefined') {
      synth.onvoiceschanged = pickBestVoice;
    }

    function speak(text) {
      if (!enabled || !text) return;
      var clean = text
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/https?:\/\/\S+/g, 'a link')
        .replace(/[#_~]/g, '')
        .trim();
      if (!clean) return;
      voiceBtn.classList.add('speaking');
      function doneSpeaking() {
        voiceBtn.classList.remove('speaking');
        if (enabled) voiceBtn.classList.add('active');
      }
      function fallbackTTS() {
        if (!synth) { doneSpeaking(); return; }
        synth.cancel();
        var utt = new SpeechSynthesisUtterance(clean);
        if (selectedVoice) utt.voice = selectedVoice;
        utt.lang = 'en-US'; utt.rate = 0.92; utt.pitch = 0.86;
        utt.onstart = function() { voiceBtn.classList.add('speaking'); };
        utt.onend = utt.onerror = doneSpeaking;
        synth.speak(utt);
      }
      // Use the server's edge-tts voice to match PC JARVIS; fall back to Web Speech
      var audio = new Audio(apiBase() + '/api/tts?text=' + encodeURIComponent(clean));
      audio.onended = doneSpeaking;
      audio.onerror = function() { doneSpeaking(); fallbackTTS(); };
      audio.play().catch(fallbackTTS);
    }

    voiceBtn.addEventListener('click', function () {
      enabled = !enabled;
      voiceBtn.classList.toggle('active', enabled);
      if (!enabled) {
        synth.cancel();
        voiceBtn.classList.remove('speaking');
        toast('Voice replies off.');
      } else {
        toast('Voice on \u2014 ' + (selectedVoice ? selectedVoice.name : 'system voice') + '.');
      }
    });

    window._jarvisTTS = speak;
  }());

  /* ── speech-to-text (mic input) ─────────────────────── */
  (function initSTT() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var micBtn = $('mic-btn');
    if (!SR || !micBtn) {
      if (micBtn) micBtn.classList.add('unsupported');
      return;
    }

    var rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false; // false = far more reliable; we restart manually

    var listening = false;
    var shouldRestart = false;
    var confirmedText = ''; // finalized words so far in this session

    function setListening(v) {
      listening = v;
      micBtn.classList.toggle('listening', v);
      inputEl.placeholder = v ? '\ud83c\udfa4 Listening\u2026' : 'Message J.A.R.V.I.S. \u2026';
    }

    function tryRestart() {
      if (!shouldRestart) return;
      try { rec.start(); }
      catch (e) { setListening(false); shouldRestart = false; }
    }

    rec.onresult = function (e) {
      var interim = '';
      var finalChunk = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) {
        confirmedText = (confirmedText + ' ' + finalChunk).trim();
      }
      inputEl.value = confirmedText + (interim ? ' ' + interim.trim() : '');
      inputEl.value = inputEl.value.trim();
      autoGrow();
    };

    rec.onend = function () {
      // Restart immediately if still in listening mode (keeps STT alive)
      if (shouldRestart && listening) {
        tryRestart();
      } else {
        setListening(false);
        shouldRestart = false;
      }
    };

    rec.onerror = function (e) {
      if (e.error === 'no-speech') {
        // silence — just restart silently
        if (shouldRestart && listening) { tryRestart(); return; }
      } else if (e.error !== 'aborted') {
        toast('Mic: ' + e.error);
      }
      setListening(false);
      shouldRestart = false;
    };

    micBtn.addEventListener('click', function () {
      if (listening) {
        // Stop listening
        shouldRestart = false;
        try { rec.abort(); } catch (e2) {}
        setListening(false);
      } else {
        // Start listening — preserve any text already typed
        confirmedText = inputEl.value.trim();
        shouldRestart = true;
        try {
          rec.start();
          setListening(true);
        } catch (e) {
          toast('Could not start mic \u2014 check permissions.');
          shouldRestart = false;
        }
      }
    });

    // Stop mic when user hits Send
    var origSendChat = window.sendChat;
    $('send').addEventListener('click', function () {
      if (listening) { shouldRestart = false; try { rec.abort(); } catch (e) {} setListening(false); }
    }, true);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && listening) {
        shouldRestart = false;
        try { rec.abort(); } catch (e2) {}
        setListening(false);
      }
    }, true);
  }());

  /* ── intro splash ─────────────────────────────────── */
  function startIntro() {
    var introEl = $('intro');
    if (!introEl) return;
    var done = false;
    function dismiss() {
      if (done) return;
      done = true;
      introEl.classList.add('done');
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
      setTimeout(function () { try { introEl.parentNode.removeChild(introEl); } catch (e) {} }, 700);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    setTimeout(dismiss, 3200);
  }

  /* ── wake word detection (background “JARVIS” listener) ───────────── */
  (function initWakeWord() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var micBtnEl = $('mic-btn');
    if (!SR || !micBtnEl || micBtnEl.classList.contains('unsupported')) return;

    var wakeRec = null;
    var wakeOn = false;

    function isWake(txt) {
      var flat = txt.toLowerCase().replace(/[^a-z]/g, '');
      if (flat.indexOf('jarvis') !== -1 || flat.indexOf('harvis') !== -1) return true;
      var words = txt.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
      if (!words.length) return false;
      var last = words[words.length - 1];
      if (/^(jarvis|jerris|jerry|javis)$/.test(last)) return true;
      if (words.length >= 2 && /^(hey|ok|yo)$/.test(words[0]) && /^jar/.test(last)) return true;
      return false;
    }

    function stopWake() {
      wakeOn = false;
      if (wakeRec) { try { wakeRec.stop(); } catch (e) {} }
    }

    function startWake() {
      if (wakeOn || micBtnEl.classList.contains('listening')) return;
      wakeOn = true;
      wakeRec = new SR();
      wakeRec.continuous = true;
      wakeRec.interimResults = true;
      wakeRec.lang = 'en-US';
      wakeRec.onresult = function (e) {
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          if (isWake(e.results[i][0].transcript)) {
            stopWake();
            if (!micBtnEl.classList.contains('listening')) micBtnEl.click();
            return;
          }
        }
      };
      wakeRec.onend = function () {
        wakeOn = false;
        if (!micBtnEl.classList.contains('listening')) setTimeout(startWake, 400);
      };
      wakeRec.onerror = function (e) {
        wakeOn = false;
        if (e.error !== 'not-allowed' && !micBtnEl.classList.contains('listening')) {
          setTimeout(startWake, 2000);
        }
      };
      try { wakeRec.start(); } catch (e) { wakeOn = false; }
    }

    // Sync wake state with mic button every second
    setInterval(function () {
      var active = micBtnEl.classList.contains('listening');
      if (active && wakeOn) stopWake();
      else if (!active && !wakeOn) startWake();
    }, 1000);

    setTimeout(startWake, 4500);
  }());

  /* ── Sites tab: GitHub Pages deployments ──────────────────────────────── */
  var JARVIS_URL = 'http://127.0.0.1:5001';
  var GH_API = 'https://api.github.com';
  var sitesTabEl = $('tab-sites');
  var sitesRendered = false;

  function getGhUsername() {
    return (window.__GH_USERNAME || '').trim();
  }

  function fetchSites() {
    var listEl = $('sites-list');
    var emptyEl = $('sites-empty');
    var statusEl = $('sites-status');
    if (!listEl) return;

    var username = getGhUsername();
    if (!username) {
      statusEl.textContent = 'GitHub not linked';
      emptyEl.classList.remove('hidden');
      return;
    }

    statusEl.textContent = 'Loading\u2026';

    fetch(GH_API + '/users/' + encodeURIComponent(username) + '/repos?per_page=100&sort=pushed&direction=desc')
      .then(function (r) { return r.json(); })
      .then(function (repos) {
        if (!Array.isArray(repos)) {
          statusEl.textContent = 'Error loading repos';
          return;
        }
        // Find repos that likely have GitHub Pages (have homepage set, or have gh-pages branch)
        // For now show all repos sorted by last push
        var sites = repos.filter(function (r) { return r.has_pages || r.homepage; });
        var allRepos = repos;

        // Show Pages-enabled repos first, then others
        var toShow = sites.length ? sites : allRepos;
        if (!toShow.length) {
          listEl.innerHTML = '';
          emptyEl.classList.remove('hidden');
          statusEl.textContent = '0 repos';
          return;
        }
        emptyEl.classList.add('hidden');
        statusEl.textContent = (sites.length || toShow.length) + ' repo' + (toShow.length === 1 ? '' : 's');
        listEl.innerHTML = '';

        toShow.forEach(function (repo) {
          var pagesUrl = 'https://' + username + '.github.io/' + repo.name + '/';
          var hasPages = !!repo.has_pages;
          var card = document.createElement('div');
          card.className = 'site-card';
          var timeAgo = repo.pushed_at ? formatTimeAgo(repo.pushed_at) : '';
          card.innerHTML =
            '<div class="site-name">' +
              '<span class="site-live-dot pending" data-url="' + escHtml(pagesUrl) + '"></span>' +
              escHtml(repo.name) +
              (repo.fork ? ' <span style="font-size:.6rem;color:var(--muted-2)">(fork)</span>' : '') +
            '</div>' +
            (repo.description ? '<div class="site-desc">' + escHtml(repo.description) + '</div>' : '') +
            '<div class="site-meta">' +
              '<span>' + (repo.language || 'repo') + '</span>' +
              '<span>\u00b7</span>' +
              '<span>' + (repo.stargazers_count || 0) + ' \u2605</span>' +
              '<span>\u00b7</span>' +
              '<span>pushed ' + timeAgo + '</span>' +
            '</div>' +
            '<div class="site-actions">' +
              (hasPages
                ? '<button class="site-btn open" data-url="' + escHtml(pagesUrl) + '">Live Site</button>'
                : '<button class="site-btn disabled">No Pages</button>') +
              '<button class="site-btn open" data-url="' + escHtml(repo.html_url) + '">Source</button>' +
            '</div>';
          listEl.appendChild(card);
          // Poll live status only for Pages-enabled repos
          if (hasPages) {
            pollSiteLive(card.querySelector('.site-live-dot'), pagesUrl);
          } else {
            var dot = card.querySelector('.site-live-dot');
            if (dot) dot.className = 'site-live-dot offline';
          }
        });
        // Wire up open buttons
        listEl.querySelectorAll('.site-btn.open').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var url = btn.getAttribute('data-url');
            if (url) window.open(url, '_blank');
          });
        });
      })
      .catch(function () {
        statusEl.textContent = 'Offline';
      });
  }

  function pollSiteLive(dotEl, url) {
    if (!dotEl) return;
    // Try the PC backend first, fall back to direct fetch
    var checkUrl = JARVIS_URL + '/api/deploy-check?url=' + encodeURIComponent(url);
    fetch(checkUrl)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.live) { dotEl.className = 'site-live-dot live'; }
        else { setTimeout(function () { pollSiteLive(dotEl, url); }, 5000); }
      })
      .catch(function () {
        // Backend unreachable — try direct HEAD fetch
        fetch(url, { method: 'HEAD', mode: 'no-cors' })
          .then(function () { dotEl.className = 'site-live-dot live'; })
          .catch(function () { dotEl.className = 'site-live-dot offline'; });
      });
  }

  function formatTimeAgo(isoStr) {
    var diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  if (sitesTabEl) {
    sitesTabEl.addEventListener('click', function () {
      showScreen('sites');
      updateTabs('sites');
      // Always refresh when opened
      fetchSites();
    });
  }

  /* ── boot: always land on TALK (no login needed to chat) ───────────── */
  function boot() {
    if (typeof showScreen === 'function') showScreen('talk');
    updateTabs('talk');
    paintHud();
    startIntro();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
