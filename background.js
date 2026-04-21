// CMD·AI Bridge — Background v7.0
// Base: v3.1 original (que ya funciona para index)
// Agrega: push a pre_analisis + snapshot CMD + open_pre_analisis
'use strict';

var _cmdTabId = null;  // tab del index.html
var _preTabId = null;  // tab del pre_analisis.html

// Snapshot CMD — se actualiza con cada dato
var _CMD = {
  version:'7.0', enabled:false, asset:null,
  balance:null, payout:null, openOptions:0,
  candleCount:0, lastCandle:null, liveTick:null, ts:0
};

chrome.runtime.onInstalled.addListener(function() {
  console.log('[CMD Bridge] v7.0');
  chrome.storage.local.set({
    pre_analisis_url: chrome.runtime.getURL('pre_analisis.html'),
    index_url:        chrome.runtime.getURL('index.html')
  });
});

// ── Buscar tab del index ──────────────────────────────────────
// Igual que v3.1 original — busca file:// + index.html o localhost
function _findCmdTab(cb) {
  if (_cmdTabId !== null) { cb(_cmdTabId); return; }
  chrome.tabs.query({}, function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      var url = (tabs[i].url||'').toLowerCase();
      // file:// con index.html (NO pre_analisis)
      if (url.indexOf('file:') >= 0 &&
          url.indexOf('index.html') >= 0 &&
          url.indexOf('pre_analisis') < 0) {
        _cmdTabId = tabs[i].id; cb(_cmdTabId); return;
      }
      // chrome-extension:// con index.html (NO pre_analisis)
      if (url.indexOf('chrome-extension') >= 0 &&
          url.indexOf('index.html') >= 0 &&
          url.indexOf('pre_analisis') < 0) {
        _cmdTabId = tabs[i].id; cb(_cmdTabId); return;
      }
      // localhost / 127.0.0.1
      if (url.indexOf('localhost') >= 0 || url.indexOf('127.0.0.1') >= 0) {
        _cmdTabId = tabs[i].id; cb(_cmdTabId); return;
      }
    }
    cb(null);
  });
}

// ── Buscar tab del pre_analisis ───────────────────────────────
function _findPreTab(cb) {
  if (_preTabId !== null) { cb(_preTabId); return; }
  chrome.tabs.query({}, function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      var url = (tabs[i].url||'').toLowerCase();
      if (url.indexOf('pre_analisis') >= 0) {
        _preTabId = tabs[i].id; cb(_preTabId); return;
      }
    }
    cb(null);
  });
}

// ── Limpiar cache cuando tab se cierra o recarga ──────────────
chrome.tabs.onRemoved.addListener(function(tabId) {
  if (tabId === _cmdTabId) _cmdTabId = null;
  if (tabId === _preTabId) _preTabId = null;
});
chrome.tabs.onUpdated.addListener(function(tabId, info) {
  if (info.status === 'loading') {
    if (tabId === _cmdTabId) _cmdTabId = null;
    if (tabId === _preTabId) _preTabId = null;
  }
  // Cuando index carga completo → inyectarle la URL del pre_analisis
  if (info.status === 'complete') {
    chrome.tabs.get(tabId, function(tab) {
      if (chrome.runtime.lastError || !tab) return;
      var u = (tab.url||'').toLowerCase();
      if (u.indexOf('pre_analisis') >= 0) return;
      if ((u.indexOf('index.html') >= 0) || u.indexOf('localhost') >= 0) {
        var preUrl = chrome.runtime.getURL('pre_analisis.html');
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function(url) { localStorage.setItem('cmd_pre_url', url); },
          args: [preUrl], world: 'MAIN'
        }).catch(function(){});
      }
    });
  }
});

// ── Inyectar en index (idéntico al v3.1) ─────────────────────
function _injectIndex(tabId, type, color, strength, ohlc, deal, candles, meta, lt) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function(t, c, s, o, d, hist, m, lt) {
      if (t === 'history_init') {
        if (typeof window.initHistory === 'function') window.initHistory(hist);
        return;
      }
      if (t === 'meta') {
        if (typeof window.receiveMeta === 'function') window.receiveMeta(m);
        return;
      }
      if (t === 'live_tick') {
        if (typeof window.receiveLiveTick === 'function') window.receiveLiveTick(lt);
        return;
      }
      if (t === 'disable_bridge') {
        if (typeof window.toggleAutoMode === 'function' && window._autoMode) window.toggleAutoMode();
        window._bridgeEnabled = false; return;
      }
      // candle
      if (window._bridgeEnabled === false) {
        var buf = { color:c, strength:s, ohlc:o, deal:d, timestamp:Date.now() };
        localStorage.setItem('cmd-candle', JSON.stringify(buf));
        localStorage.setItem('cmd-candle-ts', String(Date.now()));
        return;
      }
      if (typeof window.quickAddCandle === 'function') {
        window.quickAddCandle(c, s, o, d);
      }
    },
    args: [type, color, strength, ohlc, deal, candles, meta, lt],
    world: 'MAIN'
  }).catch(function() { _cmdTabId = null; });
}

// ── Inyectar en pre_analisis via CustomEvent ──────────────────
function _injectPre(tabId, cmd) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function(cmd) {
      window.__CMD_LATEST = cmd;
      document.dispatchEvent(new CustomEvent('cmd-bridge-data', { detail: cmd }));
    },
    args: [cmd], world: 'MAIN'
  }).catch(function() { _preTabId = null; });
}

// ── Actualizar snapshot CMD ───────────────────────────────────
function _updateCMD(type, msg) {
  if (type === 'candle') {
    var o = msg.ohlc || {};
    _CMD.lastCandle = {
      color:msg.color, str:msg.strength,
      open:o.open||null, high:o.high||null, low:o.low||null, close:o.close||null,
      ticks:o.ticks||null, tickSpeed:o.tickSpeed||null,
      spread:o.spread||null, spreadMult:o.spreadMult||null,
      strBreakdown:o.strBreakdown||null, session:o.session||null,
      bodyRatio:o.bodyRatio||null, wickRatio:o.wickRatio||null,
      ts:Date.now()
    };
    _CMD.candleCount++;
    _CMD.enabled = true;
  }
  if (type === 'live_tick') {
    _CMD.liveTick = {
      color:msg.color, open:msg.open, high:msg.high, low:msg.low, close:msg.close,
      ticks:msg.ticks, tickSpeed:msg.tickSpeed, accel:msg.accel,
      bodyRatio:msg.bodyRatio, wickTop:msg.wickTop, wickBot:msg.wickBot,
      rejectTop:msg.rejectTop, rejectBot:msg.rejectBot,
      strPartial:msg.strPartial, progress:msg.progress,
      elapsed:msg.elapsed, remaining:msg.remaining, asset:msg.asset
    };
    if (msg.asset) _CMD.asset = msg.asset;
    _CMD.enabled = true;
  }
  if (type === 'meta' && msg.data) {
    var d = msg.data;
    if (d.type === 'balance' && d.value)      { _CMD.balance = d.value; _CMD.enabled = true; }
    if (d.type === 'payout'  && d.value)      { _CMD.payout  = d.value; if(d.asset) _CMD.asset = d.asset; _CMD.enabled = true; }
    if (d.type === 'open_options')             { _CMD.openOptions = d.value || 0; }
  }
  if (type === 'history_init' && msg.candles) { _CMD.history = msg.candles; }
  _CMD.ts = Date.now();
  chrome.storage.local.set({ cmd_snapshot: _CMD });
}

// ── Listener principal: mensajes del content.js ───────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  var allowed = { candle:1, history_init:1, meta:1, live_tick:1 };
  if (!allowed[msg.type]) { sendResponse({ ok:false }); return true; }

  var type     = msg.type;
  var color    = msg.color;
  var strength = msg.strength || 5.0;
  var ohlc     = msg.ohlc    || null;
  var deal     = msg.deal    || null;
  var candles  = msg.candles || null;
  var meta     = msg.data    || null;
  var lt       = type === 'live_tick' ? msg : null;

  // 1. Actualizar snapshot CMD
  _updateCMD(type, msg);

  // 2. Push al index (lógica v3.1 intacta)
  _findCmdTab(function(tabId) {
    if (tabId) _injectIndex(tabId, type, color, strength, ohlc, deal, candles, meta, lt);
  });

  // 3. Push a pre_analisis
  _findPreTab(function(tabId) {
    if (tabId) _injectPre(tabId, _CMD);
  });

  sendResponse({ ok: true });
  return true;
});

// ── read_cmd — popup solicita snapshot ───────────────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type !== 'read_cmd') return true;
  sendResponse({ ok:true, cmd: _CMD.ts > 0 ? _CMD : null });
  return true;
});

// ── pred_update — index envía predicción activa → relay a tabs PO ─
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type !== 'pred_update') return true;
  if (msg.dir) _CMD.pred = { dir: msg.dir, conf: msg.conf||0, ts: Date.now() };
  // Relay a todas las tabs de PO
  chrome.tabs.query({}, function(tabs) {
    tabs.forEach(function(t) {
      var u = (t.url||'').toLowerCase();
      if (u.indexOf('po.market') >= 0 || u.indexOf('pocketoption') >= 0) {
        chrome.tabs.sendMessage(t.id, { type:'pred_update', dir:msg.dir, conf:msg.conf }, function(){ chrome.runtime.lastError; });
      }
    });
  });
  sendResponse({ ok:true });
  return true;
});

// ── disable_index ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type !== 'disable_index') return true;
  _findCmdTab(function(tabId) {
    if (!tabId) { sendResponse({ ok:false }); return; }
    _injectIndex(tabId, 'disable_bridge', null, null, null, null, null, null, null);
    sendResponse({ ok:true });
  });
  return true;
});

// ── Abrir pre_analisis como chrome-extension:// ───────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type !== 'open_pre_analisis') return true;
  var url = chrome.runtime.getURL('pre_analisis.html');
  chrome.tabs.query({}, function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].url||'').indexOf('pre_analisis') >= 0) {
        _preTabId = tabs[i].id;
        chrome.tabs.update(_preTabId, { active:true });
        chrome.windows.update(tabs[i].windowId, { focused:true });
        if (_CMD.ts > 0) _injectPre(_preTabId, _CMD);
        sendResponse({ ok:true }); return;
      }
    }
    // Crear nueva tab y esperar que cargue para inyectar _CMD
    chrome.tabs.create({ url:url }, function(tab) {
      _preTabId = tab.id;
      sendResponse({ ok:true });
      // Esperar que la tab cargue completamente antes de inyectar
      if (_CMD.ts > 0) {
        var _injected = false;
        var _listener = function(tabId, info) {
          if (tabId !== _preTabId || _injected) return;
          if (info.status === 'complete') {
            _injected = true;
            chrome.tabs.onUpdated.removeListener(_listener);
            // Dar 300ms extra para que los scripts de la página ejecuten
            setTimeout(function() {
              _injectPre(_preTabId, _CMD);
            }, 300);
          }
        };
        chrome.tabs.onUpdated.addListener(_listener);
        // Timeout de seguridad — si no carga en 10s, limpiar
        setTimeout(function() {
          chrome.tabs.onUpdated.removeListener(_listener);
        }, 10000);
      }
    });
  });
  return true;
});

// ── Abrir index ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type !== 'open_index') return true;
  _findCmdTab(function(tabId) {
    if (tabId) {
      chrome.tabs.update(tabId, { active:true });
      chrome.windows.update(null, { focused:true }, function(){});
      sendResponse({ ok:true });
    } else {
      var url = chrome.runtime.getURL('index.html');
      chrome.tabs.create({ url:url }, function(tab) {
        _cmdTabId = tab.id;
        sendResponse({ ok:true });
      });
    }
  });
  return true;
});
