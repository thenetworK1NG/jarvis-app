/* J.A.R.V.I.S. Command — combined deck
 * - Talk: uses a shared Firebase sync path (jarvischat/sync) so the phone
 *   and PC see the same messages in real time.
 * - Transfer: reuses the wetransfer phone app engine (app.js) untouched.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var firebaseOk = (typeof firebase !== 'undefined' && firebase.initializeApp);
  var DB = null;
  var SYNC = null, STATUS = null;
  if (firebaseOk) {
    try {
      DB = firebase.database();
      SYNC = DB.ref('jarvischat/sync');
      STATUS = DB.ref('jarvischat/status');
    } catch (e) { DB = null; }
  }

  var online = false;

  /* ── tab bar ──────────────────────────────────────── */
  var tabs = { talk: $('tab-talk'), transfer: $('tab-transfer') };

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
    } else {
      showScreen('home');
    }
  });

  /* ── J.A.R.V.I.S. online status ────────────────────── */
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
      } else if (online) {
        pill.className = 'hud-pill up';
        pill.textContent = 'ONLINE';
      } else {
        pill.className = 'hud-pill down';
        pill.textContent = 'OFFLINE';
      }
    }
  }

  if (STATUS) {
    STATUS.on('value', function (snap) {
      online = isOnlineVal(snap.val());
      paintHud();
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
  /* Rendering + history live in index.html (window.JarvisChat).
     This file is the transport: Firebase sync in, store calls out. */
  var messagesEl = $('messages');
  var inputEl = $('input');
  var typingEl = null;
  window.__SYNC = SYNC;   // history engine uses this for hydration/clear

  function showTyping() {
    if (typingEl) return;
    thinkingState = true;
    paintChatStatus(true, false);
    var stopBtn = $('stop-btn');
    if (stopBtn) stopBtn.classList.remove('hidden');
    typingEl = document.createElement('div');
    typingEl.className = 'typing';
    for (var i = 0; i < 3; i++) {
      var d = document.createElement('span');
      d.className = 'dot';
      typingEl.appendChild(d);
    }
    messagesEl.appendChild(typingEl);
    if (window.JarvisChat) window.JarvisChat.stick();
    if (thinkingTimer) clearTimeout(thinkingTimer);
    thinkingTimer = setTimeout(hideTyping, 60000);
    if (!wdTimer) {
      setTimeout(wdPoll, 4000);
      wdTimer = setInterval(wdPoll, 10000);
    }
  }
  function hideTyping() {
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    if (wdTimer) { clearInterval(wdTimer); wdTimer = null; }
    if (typingEl) { typingEl.remove(); typingEl = null; }
    var stopBtn = $('stop-btn');
    if (stopBtn) stopBtn.classList.add('hidden');
    thinkingState = false;
    paintChatStatus(true, false);
  }

  function ingestSnap(snap) {
    if (!window.JarvisChat) return;
    var m = snap.val() || {};
    var key = snap.key;
    var rd = m.reply_data || {};
    var reply = ((rd.reply || m.reply) + '').trim();
    var sender = rd.sender || m.sender || '';
    var isAssistantReply = !!reply && (sender === 'assistant' || !sender);
    window.JarvisChat.ingest({
      key: key,
      chatId: m.chatId,
      text: (sender !== 'assistant' && m.text) ? String(m.text).trim() : '',
      reply: isAssistantReply ? reply : '',
      steps: rd.steps || m.steps,
      repliedAt: rd.repliedAt || m.repliedAt,
      ts: m.ts
    });
    /* Only end "typing" / speak when the reply belongs to the chat we're
       looking at — background chats must not touch the indicator. */
    if (isAssistantReply && (!m.chatId || m.chatId === window.JarvisChat.activeId())) {
      hideTyping();
      if (window._jarvisTTS) window._jarvisTTS(reply);
    }
  }

  /* Typing watchdog: Firebase events can get lost (socket drop, PC network
     hiccup). While the indicator is up, re-poll the active chat's last few
     messages so a reply that already landed on the server is picked up. */
  var wdTimer = null;
  function wdPoll() {
    if (!typingEl || !SYNC || !window.JarvisChat) return;
    try {
      SYNC.orderByChild('chatId').equalTo(window.JarvisChat.activeId())
        .limitToLast(6).once('value').then(function (snap) {
          snap.forEach(function (ch) { try { ingestSnap(ch); } catch (_) {} });
        }).catch(function () {});
    } catch (_) {}
  }

  if (SYNC) {
    SYNC.orderByChild('ts').on('child_added', ingestSnap);
    SYNC.orderByChild('ts').on('child_changed', ingestSnap);
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
  }

  var sendBusy = false;
  function sendChat() {
    if (sendBusy) return;
    var text = inputEl.value.trim();
    if (!text) return;
    if (!SYNC || !window.JarvisChat) { toast('No chat link — is Firebase reachable?'); return; }
    sendBusy = true;
    setTimeout(function () { sendBusy = false; }, 500);
    /* kill any live STT session FIRST, then clear the box immediately so a
       second tap finds an empty input and can never double-send */
    if (window.__jarvisSTTReset) window.__jarvisSTTReset();
    inputEl.value = '';
    autoGrow();
    showTyping();
    window.JarvisChat.localUser(text);
    SYNC.push({
      chatId: window.JarvisChat.activeId(),
      sender: 'user',
      text: text,
      ts: Date.now(),
      processed: false,
      from: 'phone'
    });
    inputEl.focus();
  }
  $('send').addEventListener('click', sendChat);
  $('stop-btn').addEventListener('click', function () {
    hideTyping();
    if (typeof SYNC !== 'undefined' && SYNC) {
      SYNC.root.child('cancel').set({ ts: firebase.database.ServerValue.TIMESTAMP }).catch(function () {});
    }
    toast('Generation stopped.');
  });
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

  /* clear chat (active chat only) */
  var clearBackdrop = $('clearBackdrop');
  $('clearChat').addEventListener('click', function () { clearBackdrop.classList.add('show'); });
  $('clearCancel').addEventListener('click', function () { clearBackdrop.classList.remove('show'); });
  $('clearGo').addEventListener('click', function () {
    clearBackdrop.classList.remove('show');
    if (window.JarvisChat) window.JarvisChat.clearActive();
    hideTyping();
    toast('Chat cleared');
  });

  /* expose toast to the history engine */
  window.__toast = toast;

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
    if (!STATUS) { paintChatStatus(thinkingState ? true : false, false); return; }
    STATUS.once('value').then(function (snap) {
      var v = snap.val();
      if (!v || !v.online) {
        paintChatStatus(thinkingState ? true : false, false);
        return;
      }
      paintChatStatus(thinkingState ? true : ((Date.now() - (v.ts || 0)) < 25000), !!v.build);
    }).catch(function () {
      if (!thinkingState) paintChatStatus(false, false);
    });
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

    /* Send calls this so a trailing STT result can't resurrect cleared
       text back into the box (looked like "send did nothing"). */
    window.__jarvisSTTReset = function () {
      confirmedText = '';
      shouldRestart = false;
      if (listening) {
        try { rec.abort(); } catch (e) {}
        setListening(false);
      }
    };

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
  var GH_API = 'https://api.github.com';
  var sitesTabEl = $('tab-sites');

  function getGhUsername() {
    // 1. injected by deploy
    var injected = (window.__GH_USERNAME || '').trim();
    if (injected) return injected;
    // 2. localStorage (set by user input)
    var stored = '';
    try { stored = (localStorage.getItem('gh_username') || '').trim(); } catch (e) {}
    if (stored) return stored;
    // 3. Firebase
    return cachedGhUsername || '';
  }

  function saveGhUsername(username) {
    username = username.trim();
    try { localStorage.setItem('gh_username', username); } catch (e) {}
    cachedGhUsername = username;
    if (DB) {
      DB.ref('jarvischat/meta/gh_username').set(username).catch(function () {});
    }
  }

  var cachedGhUsername = '';
  if (DB) {
    DB.ref('jarvischat/meta/gh_username').on('value', function (snap) {
      var val = snap.val();
      cachedGhUsername = (val && typeof val === 'string') ? val.trim() : '';
    });
  }

  function fetchSites() {
    var listEl = $('sites-list');
    var emptyEl = $('sites-empty');
    var statusEl = $('sites-status');
    var usernameRow = $('sites-username-row');
    var usernameInput = $('sites-username-input');
    var usernameSave = $('sites-username-save');
    if (!listEl) return;

    var username = getGhUsername();

    // Show username input if no username
    if (!username) {
      if (usernameRow) usernameRow.classList.remove('hidden');
      if (emptyEl) emptyEl.classList.add('hidden');
      if (statusEl) statusEl.textContent = '';
      listEl.innerHTML = '';
      // Wire up save button
      if (usernameSave && usernameInput) {
        usernameSave.onclick = function () {
          var val = usernameInput.value.trim();
          if (!val) return;
          saveGhUsername(val);
          if (usernameRow) usernameRow.classList.add('hidden');
          fetchSites();
        };
        usernameInput.onkeydown = function (e) {
          if (e.key === 'Enter') usernameSave.click();
        };
        // Pre-fill with any known value
        usernameInput.value = cachedGhUsername || '';
      }
      return;
    }

    if (usernameRow) usernameRow.classList.add('hidden');
    statusEl.textContent = 'Loading\u2026';
    emptyEl.classList.add('hidden');
    listEl.innerHTML = '';

    fetch(GH_API + '/users/' + encodeURIComponent(username) + '/repos?per_page=100&sort=pushed&direction=desc')
      .then(function (r) { return r.json(); })
      .then(function (repos) {
        if (!Array.isArray(repos)) {
          statusEl.textContent = 'Error loading repos';
          return;
        }
        var sites = repos.filter(function (r) { return r.has_pages || r.homepage; });
        var toShow = sites.length ? sites : repos;
        if (!toShow.length) {
          listEl.innerHTML = '';
          emptyEl.classList.remove('hidden');
          statusEl.textContent = '0 repos';
          return;
        }
        emptyEl.classList.add('hidden');
        statusEl.textContent = toShow.length + ' repo' + (toShow.length === 1 ? '' : 's');
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
          if (hasPages) {
            pollSiteLive(card.querySelector('.site-live-dot'), pagesUrl);
          } else {
            var dot = card.querySelector('.site-live-dot');
            if (dot) dot.className = 'site-live-dot offline';
          }
        });
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
    var checkUrl = 'https://api.github.com/repos/' + encodeURIComponent(getGhUsername()) + '/' + url.split('/').filter(Boolean).pop();
    // Simple check: just try to fetch the pages URL
    fetch(url, { method: 'HEAD', mode: 'no-cors' })
      .then(function () { dotEl.className = 'site-live-dot live'; })
      .catch(function () {
        // Can't detect — show as live since Pages repos are usually live
        dotEl.className = 'site-live-dot live';
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
