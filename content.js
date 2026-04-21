// CMD·AI Bridge — Content Script v6.1
// ISOLATED world → envía datos al MAIN world via CustomEvent 'cmd-update'
// El interceptor.js (MAIN world) mantiene window.CMD que el popup lee
'use strict';
(function() {

var _enabled      = false;
var _candleCount  = 0;
var _lastSent     = 0;
var _lastLiveSent = 0;
var _liveInterval = 5;
var _liveTick     = 0;
var _candles      = {};
var _activeAsset  = null;
var _tf           = 60;

var _allAssets    = {};
var _lastPrices   = {};
var _spreadHist   = {};
var _tickTimes    = {};

var _balance      = null;
var _openOptions  = [];
var _historyInit  = false;
var _payout       = null;
var _payoutAsset  = null;
var _speedRef     = {};

// ── Reloj interno de vela ───────────────────────────────────────
var _clockAsset    = null;  // activo activo del reloj
var _clockStart    = null;  // timestamp cuando empezó la vela actual
var _clockColor    = 'G';   // color actual de la vela en formación
var _clockTimer    = null;  // el setInterval

function _startClock(asset, color, startTs) {
  _clockAsset = asset;
  _clockColor = color;
  _clockStart = startTs || Date.now();
  if (_clockTimer) return; // ya corriendo
  _clockTimer = setInterval(function() {
    if (!_clockStart) return;
    var elapsed   = (Date.now() - _clockStart) / 1000;
    var remaining = Math.max(0, _tf - elapsed);
    if (remaining <= 0) { _clockStart = null; }
  }, 100);
}

function _stopClock() {
  if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
  _clockStart = null;
  _clockAsset = null;
}

function log(m){ console.log('[CMD Bridge v6]', m); }

// ── Normalizar nombre de activo ───────────────────────────────
function normalizeAsset(a) {
  if (!a) return '';
  return String(a).toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/OTC$/,'')
    .replace(/^#/,'');
}

// ── Enviar meta al background ─────────────────────────────────
function sendMeta(data) {
  try { chrome.runtime.sendMessage({ type:'meta', data:data }); } catch(e) {}
}

// ── Spread sintético (bid-ask estimado de ticks históricos) ───
function _calcSpreadSynthetic(asset) {
  var prices = _lastPrices[asset];
  if (!prices || prices.length < 2) return 0;
  var diffs = [];
  for (var i = 1; i < prices.length; i++) {
    var d = Math.abs(prices[i] - prices[i-1]);
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 0;
  diffs.sort(function(a,b){return a-b;});
  return diffs[Math.floor(diffs.length * 0.25)] || 0; // percentil 25
}

// ── Spread promedio histórico ─────────────────────────────────
function _avgSpread(asset) {
  var h = _spreadHist[asset];
  if (!h || !h.length) return 0;
  return h.reduce(function(s,v){return s+v;},0) / h.length;
}

// ── Sesión de mercado ─────────────────────────────────────────
function _getSession(unixSec) {
  var d = new Date(unixSec * 1000);
  var h = d.getUTCHours();
  if (h >= 0  && h < 7)  return { name:'Asia',    color:'#29b6f6' };
  if (h >= 7  && h < 9)  return { name:'Overlap A/E', color:'#ab47bc' };
  if (h >= 9  && h < 13) return { name:'Europa',  color:'#66bb6a' };
  if (h >= 13 && h < 17) return { name:'Overlap E/NY', color:'#ffa726' };
  if (h >= 17 && h < 21) return { name:'NY',      color:'#ef5350' };
  return                         { name:'Off',     color:'#546e7a' };
}

// ── Enviar estado completo al MAIN world (interceptor.js) ─────
function _pushState() {
  document.dispatchEvent(new CustomEvent('cmd-update', { detail: {
    type        : 'state',
    enabled     : _enabled,
    balance     : _balance,
    payout      : _payout,
    asset       : _activeAsset,
    openOptions : _openOptions.length,
    candleCount : _candleCount,
  }}));
}

function _pushLiveTick(data) {
  document.dispatchEvent(new CustomEvent('cmd-update', { detail: { type:'liveTick', data:data }}));
}

function _pushLastCandle(data) {
  document.dispatchEvent(new CustomEvent('cmd-update', { detail: {
    type:'lastCandle', data:data, candleCount:_candleCount,
  }}));
}

// ════════════════════════════════════════════════════════════════
// WS — recibe mensajes del interceptor via CustomEvent
// ════════════════════════════════════════════════════════════════
document.addEventListener('cmd-ws-message', function(evt) {
  if (!evt.detail || !evt.detail.data) return;
  var raw = evt.detail.data;
  if (typeof raw !== 'string') return;
  // Sin guard _enabled: window.CMD se actualiza siempre
  // sendMessage al background solo ocurre si _enabled (más abajo)

  var payload = raw;
  // Strip Socket.IO prefix: handles 42[..], 451-[..], 2, 3, etc.
  var _jsonStart = raw.search(/[\[{]/);
  if (_jsonStart > 0) payload = raw.substring(_jsonStart);
  else if (_jsonStart < 0) return; // no JSON

  try {
    var parsed = JSON.parse(payload);

    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      var evtName = parsed[0].toLowerCase();
      var evtData = parsed[1] || {};

      if (evtName.indexOf('balance') >= 0) {
        handleObjectMessage({ balance: evtData.balance || evtData.value || evtData });
        return;
      }
      if (evtName.indexOf('asset') >= 0 || evtName.indexOf('payout') >= 0 ||
          evtName.indexOf('symbol') >= 0 || evtName.indexOf('instrument') >= 0) {
        handleObjectMessage(evtData); return;
      }
      if (evtName.indexOf('option') >= 0 || evtName.indexOf('trade') >= 0 ||
          evtName.indexOf('deal') >= 0) {
        if (Array.isArray(evtData)) handleObjectMessage({ open_options: evtData });
        else handleObjectMessage(evtData);
        return;
      }
      if (evtName.indexOf('candle') >= 0 || evtName.indexOf('history') >= 0) {
        var hist = Array.isArray(evtData) ? evtData : (evtData.candles || evtData.data || []);
        if (hist.length > 5) { handleCandleHistory(hist); return; }
      }
      if (Array.isArray(parsed[1]) && Array.isArray(parsed[1][0])) {
        processPriceArray(parsed[1]); return;
      }
      return;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Formato: {"asset":"X","period":5,"history":[[ts,price],...]}
      if (parsed.asset && parsed.history && Array.isArray(parsed.history)) {
        var hAsset = parsed.asset;
        var hPrices = parsed.history;
        var hConverted = [];
        for (var hi = 0; hi < hPrices.length; hi++) {
          if (Array.isArray(hPrices[hi]) && hPrices[hi].length >= 2) {
            hConverted.push([hAsset, hPrices[hi][0], hPrices[hi][1]]);
          }
        }
        if (hConverted.length > 0) {
          console.log('[CMD] History prices:', hConverted.length, 'ticks for', hAsset);
          processPriceArray(hConverted);
          // Forzar redibujado inmediato
          setTimeout(function() {
            _fRaf = false;
            if (_fCanvas && _fCtx) { _fRaf=true; requestAnimationFrame(_forceDraw); }
          }, 200);
          return;
        }
      }
      handleObjectMessage(parsed); return;
    }

    if (Array.isArray(parsed)) {
      // Formato: [["UKBrent_otc",1776738797.804,89.574]] — array de ticks
      if (parsed.length >= 1 && Array.isArray(parsed[0]) && parsed[0].length >= 3
          && typeof parsed[0][0] === 'string' && typeof parsed[0][2] === 'number') {
        processPriceArray(parsed); return;
      }
      // Historial largo: [[ts,open,high,low,close,...],...]
      if (parsed.length > 10 && Array.isArray(parsed[0]) && parsed[0].length >= 3
          && typeof parsed[0][0] === 'number') {
        handleCandleHistory(parsed); return;
      }
      processPriceArray(parsed);
    }
  } catch(e) { console.error('[CMD parse error]', e.message, raw.substring(0,100)); }
});

// ════════════════════════════════════════════════════════════════
// OBJETO: balance, payout, opciones
// ════════════════════════════════════════════════════════════════
function handleObjectMessage(msg) {
  if (msg.payout !== undefined || msg.profit_percent !== undefined || msg.yield !== undefined) {
    var rawPay = msg.payout || msg.profit_percent || (msg.yield ? msg.yield * 100 : null);
    if (rawPay !== null) {
      var pay = parseFloat(rawPay);
      if (pay > 0 && pay <= 1) pay = Math.round(pay * 100);
      if (pay > 1 && pay <= 100) {
        _payout = pay; _payoutAsset = msg.asset || msg.symbol || _activeAsset || '?';
        _pushState();
        sendMeta({ type:'payout', value:pay, asset:_payoutAsset });
      }
    }
    return;
  }
  if (msg.balance !== undefined || msg.user_balance !== undefined ||
      msg.data_balance !== undefined || msg.currentBalance !== undefined) {
    var bal = parseFloat(msg.balance||msg.user_balance||msg.data_balance||msg.currentBalance||0);
    if (bal > 0 && bal !== _balance) {
      _balance = bal; _pushState();
      sendMeta({ type:'balance', value:bal });
    }
    return;
  }
  if (msg.open_options || msg.openOptions || msg.deals) {
    var opts = msg.open_options || msg.openOptions || msg.deals || [];
    if (Array.isArray(opts)) {
      _openOptions = opts.map(function(o){
        return { dir:o.direction||o.dir||o.action||'?',
                 amount:parseFloat(o.amount||o.bet||0),
                 asset:o.asset||o.pair||'', expiry:o.expiry||o.time||0 };
      });
      _pushState();
      sendMeta({ type:'open_options', value:_openOptions.length,
        buys:_openOptions.filter(function(o){return /up|call|buy/i.test(o.dir);}).length,
        sells:_openOptions.filter(function(o){return /down|put|sell/i.test(o.dir);}).length });
    }
    return;
  }
  if (msg.candles || msg.history || msg.data) {
    var h2 = msg.candles || msg.history || msg.data;
    if (Array.isArray(h2) && h2.length > 5) handleCandleHistory(h2);
    return;
  }
  if (msg.updateStream !== undefined) return;
}

// ════════════════════════════════════════════════════════════════
// HISTORIAL INICIAL
// ════════════════════════════════════════════════════════════════
function handleCandleHistory(hist) {
  if (_historyInit || hist.length < 5) return;
  var validCandles = [];
  hist.forEach(function(item) {
    var arr   = Array.isArray(item) ? item : [item.asset||'',item.ts||item.time||0,item.close||item.c||0];
    var ts    = parseFloat(arr[1]);
    var close = parseFloat(arr[2]);
    var open  = parseFloat(arr[3] !== undefined ? arr[3] : arr[2]);
    var high  = parseFloat(arr[4] !== undefined ? arr[4] : close * 1.001);
    var low   = parseFloat(arr[5] !== undefined ? arr[5] : close * 0.999);
    if (isNaN(close) || isNaN(ts) || close <= 0) return;
    var color = close >= open ? 'G' : 'R';
    var body  = Math.abs(close - open);
    var range = high - low || body || close * 0.0001;
    var br    = Math.min(1, body / range);
    validCandles.push({ color:color, str:parseFloat((br*6+2).toFixed(2)), ts:ts,
      open:open,high:high,low:low,close:close, body:body,range:range,
      bodyRatio:br,wickRatio:1-br, ticks:null,tickSpeed:null,spread:null,spreadMult:null,
      corr:null,session:null,fromHistory:true });
  });
  if (validCandles.length < 5) return;
  validCandles.sort(function(a,b){ return a.ts - b.ts; });
  chrome.runtime.sendMessage({ type:'history_init', candles:validCandles.slice(-100) });
  _historyInit = true;
  log('Historial: '+Math.min(validCandles.length,100)+' velas enviadas');

  // Cargar historial al buffer del chart — así se ve desde el primer momento
  _chartData = [];
  validCandles.slice(-80).forEach(function(c) {
    _chartData.push({ color:c.color, str:c.str||5, close:c.close||0 });
  });

}

// ════════════════════════════════════════════════════════════════
// TICK A TICK
// ════════════════════════════════════════════════════════════════
function processPriceArray(msg) {
  if (!Array.isArray(msg)) return;
  var forceOnly = !_enabled;
  msg.forEach(function(item) {
    if (!Array.isArray(item) || item.length < 3) return;
    var asset  = String(item[0]);
    var ts     = parseFloat(item[1]);
    var price  = parseFloat(item[2]);
    var extra3 = item[3] !== undefined ? parseFloat(item[3]) : null;
    var extra4 = item[4] !== undefined ? parseFloat(item[4]) : null;
    var bid=null, ask=null, realVolume=null;
    if (extra3 !== null && !isNaN(extra3)) {
      if (Math.abs(extra3-price)/price < 0.01) bid=extra3;
      else if (extra3 > 100) realVolume=extra3;
    }
    if (extra4 !== null && !isNaN(extra4) && bid !== null) ask=extra4;
    if (!asset || isNaN(price) || isNaN(ts)) return;

    // Force overlay — SIEMPRE, antes de cualquier guard
    if (asset===_activeAsset||!_activeAsset) {
      if (!_fEl) _ensureForce();
      _forceRawTick(price, _candles[asset]||null);
    } else if (!_fEl) {
      // Crear overlay aunque sea con cualquier activo
      _ensureForce();
      _forceRawTick(price, _candles[asset]||null);
    }

    // Si bridge OFF, solo procesar para el force overlay
    if (forceOnly) return;

    _allAssets[asset] = { close:price, ts:ts, bid:bid, ask:ask };
    if (!_tickTimes[asset]) _tickTimes[asset]=[];
    _tickTimes[asset].push(Date.now());
    if (_tickTimes[asset].length>20) _tickTimes[asset].shift();

    var spread = 0;
    if (bid !== null && ask !== null && ask > bid) {
      spread = ask - bid;
    } else {
      if (!_lastPrices[asset]) _lastPrices[asset]=[];
      _lastPrices[asset].push(price);
      if (_lastPrices[asset].length>5) _lastPrices[asset].shift();
      spread = _calcSpreadSynthetic(asset);
    }
    if (!_spreadHist[asset]) _spreadHist[asset]=[];
    if (spread>0) { _spreadHist[asset].push(spread); if (_spreadHist[asset].length>40) _spreadHist[asset].shift(); }

    if (_activeAsset) {
      var na=normalizeAsset(_activeAsset), nb=normalizeAsset(asset);
      if (nb!==na && !nb.includes(na) && !na.includes(nb)) return;
    }

    var period = Math.floor(ts / _tf);
    if (!_candles[asset]) {
      _candles[asset]={ open:price,high:price,low:price,close:price,
        period:period,ticks:1,firstTs:Date.now(),lastTs:Date.now(),
        realVolume:realVolume||0,realSpreadSum:spread,realSpreadCount:1 };
      // Arrancar reloj interno para este activo
      if (asset === _activeAsset || !_activeAsset) {
        _clockColor = 'G'; // neutral al inicio — se actualiza con primer tick
        _startClock(asset, _clockColor, Date.now());
      }
      return;
    }
    var c=_candles[asset];
    if (period !== c.period) {
      _closeCandle(asset, c, spread, bid, ask, realVolume);
      _candles[asset]={ open:price,high:price,low:price,close:price,
        period:period,ticks:1,firstTs:Date.now(),lastTs:Date.now(),
        realVolume:realVolume||0,realSpreadSum:spread,realSpreadCount:spread>0?1:0 };
      if (asset === _activeAsset || !_activeAsset) {
        _clockColor = 'G';
        _startClock(asset, _clockColor, Date.now());
        // Force overlay — nueva vela
        _fCandle = _candles[asset];
        _forceRawTick(price, _fCandle);
      }
    } else {
      c.close=price; c.high=Math.max(c.high,price); c.low=Math.min(c.low,price);
      c.ticks++; c.lastTs=Date.now();
      if (realVolume) c.realVolume+=realVolume;
      if (spread>0) { c.realSpreadSum+=spread; c.realSpreadCount++; }
      if (asset === _activeAsset || !_activeAsset) {
        _clockColor = c.close >= c.open ? 'G' : 'R';
        // Force overlay — tick normal con vela actualizada
        _fCandle = c;
        _forceRawTick(price, c);
      }
      _liveTick++;
      if (_liveTick >= _liveInterval) {
        _liveTick=0;
        var now2=Date.now();
        if (now2-_lastLiveSent>=800) { _lastLiveSent=now2; _sendLiveTick(asset,c,spread); }
      }
    }
  });
}



// ════════════════════════════════════════════════════════════════
// LIVE TICK
// ════════════════════════════════════════════════════════════════
function _sendLiveTick(asset, c, spread) {
  var elapsed   = Math.max(0.1,(Date.now()-c.firstTs)/1000);
  var progress  = Math.min(1.0,elapsed/_tf);
  var isGreen   = c.close >= c.open;
  var body      = Math.abs(c.close-c.open);
  var range     = c.high-c.low||body||0.00001;
  var bodyRatio = body/range;
  var tickSpeed = parseFloat((c.ticks/elapsed).toFixed(2));
  var f1p       = bodyRatio*3.5;
  var f2p       = Math.min(1.25,(c.ticks/(_tf*0.8))*1.25);
  var strPartial= parseFloat(Math.min(10,f1p+f2p).toFixed(1));
  var wickTop   = isGreen ? c.high-c.close : c.high-c.open;
  var wickBot   = isGreen ? c.open-c.low   : c.close-c.low;
  var ref       = _speedRef[asset];
  var avgSp     = ref&&ref.length ? ref.reduce(function(s,v){return s+v;},0)/ref.length : tickSpeed;
  var accel     = avgSp>0 ? parseFloat((tickSpeed/avgSp).toFixed(2)) : 1.0;

  var lt = {
    asset:asset, progress:parseFloat(progress.toFixed(2)),
    color:isGreen?'G':'R',
    open:c.open, high:c.high, low:c.low, close:c.close,
    ticks:c.ticks, tickSpeed:tickSpeed, accel:accel,
    bodyRatio:parseFloat(bodyRatio.toFixed(2)),
    wickTop:parseFloat((range>0?wickTop/range:0).toFixed(2)),
    wickBot:parseFloat((range>0?wickBot/range:0).toFixed(2)),
    rejectTop:range>0&&(wickTop/range)>0.4,
    rejectBot:range>0&&(wickBot/range)>0.4,
    strPartial:strPartial,
    elapsed:Math.round(elapsed),
    remaining:Math.max(0,Math.round(_tf-elapsed)),
  };


  // Lo siguiente solo si el bridge está activo
  if (!_enabled) return;

  _pushLiveTick(lt);
  chrome.runtime.sendMessage({ type:'live_tick', ...lt });
}

// ════════════════════════════════════════════════════════════════
// CERRAR VELA
// ════════════════════════════════════════════════════════════════
function _closeCandle(asset, c, spread, bid, ask, realVolume) {
  var color     = c.close >= c.open ? 'G' : 'R';
  var body      = Math.abs(c.close-c.open);
  var range     = c.high-c.low||body||0.00001;
  var bodyRatio = Math.min(1,body/range);
  var wickTop   = color==='G' ? c.high-c.close : c.high-c.open;
  var wickBot   = color==='G' ? c.open-c.low   : c.close-c.low;
  var wickRatio = (wickTop+wickBot)/range;
  var elapsed   = Math.max(0.1,(c.lastTs-c.firstTs)/1000);
  var tickSpeed = parseFloat((c.ticks/elapsed).toFixed(2));
  var f1=bodyRatio*3.5;
  var f2=Math.min(2.0,c.ticks/(_tf*0.8))*1.25;
  if (!_speedRef[asset]) _speedRef[asset]=[];
  _speedRef[asset].push(tickSpeed);
  if (_speedRef[asset].length>20) _speedRef[asset].shift();
  var avgSpeed=_speedRef[asset].reduce(function(s,v){return s+v;},0)/_speedRef[asset].length;
  var f3=Math.min(2.0,avgSpeed>0?tickSpeed/avgSpeed:1.0);
  var wc=color==='G' ? (wickBot>wickTop?wickBot/range:-(wickTop/range)*0.5)
                     : (wickTop>wickBot?wickTop/range:-(wickBot/range)*0.5);
  var f4=Math.max(-0.5,Math.min(1.2,wc*1.2));
  var avgSpr=_avgSpread(asset);
  var sm=avgSpr>0?(c.realSpreadCount>0?(c.realSpreadSum/c.realSpreadCount)/avgSpr:1):1;
  var f5=sm<=1.0?0.8:sm<=1.5?0.4:0.0;
  var strength=Math.max(0.1,Math.min(10.0,parseFloat((f1+f2+f3+f4+f5).toFixed(2))));
  var curSpread=c.realSpreadCount>0?c.realSpreadSum/c.realSpreadCount:spread;
  var sMult=avgSpr>0?parseFloat((curSpread/avgSpr).toFixed(2)):1;
  var session=_getSession(c.lastTs/1000);

  var minTicks=Math.max(2,Math.round(_tf*0.35));
  if (c.ticks<minTicks) { log('Descartada '+c.ticks+'/'+minTicks); return; }

  log(color+' str='+strength+' ticks='+c.ticks+' sess='+session.name);

  var strBd={ body:parseFloat(f1.toFixed(2)), ticks:parseFloat(f2.toFixed(2)),
               speed:parseFloat(f3.toFixed(2)), wick:parseFloat(f4.toFixed(2)),
               spread:parseFloat(f5.toFixed(2)) };

  _candleCount++;

  // Publicar vela cerrada al MAIN world (popup)
  _pushLastCandle({
    color:color, str:strength, asset:asset,
    open:c.open, high:c.high, low:c.low, close:c.close,
    ticks:c.ticks, spread:curSpread, spreadMult:sMult,
    strBreakdown:strBd, session:session,
  });
  _pushState();

  // Enviar al index (legacy)
  var now=Date.now();
  if (now-_lastSent>=120) {
    _lastSent=now;
    chrome.runtime.sendMessage({
      type:'candle', color:color, strength:strength,
      count:_candleCount, ts:now, asset:asset||'',
      ohlc:{ open:c.open,high:c.high,low:c.low,close:c.close,
             body:body,range:range,bodyRatio:bodyRatio,
             wickRatio:wickRatio,wickTop:wickTop,wickBottom:wickBot,
             ticks:c.ticks,tickSpeed:tickSpeed,
             spread:curSpread,spreadAvg:avgSpr,spreadMult:sMult,
             payout:_payout,strBreakdown:strBd,
             session:session,balance:_balance,openOptions:_openOptions.length },
      deal:null,
    });
  }

  // Guardar vela cerrada para separadores y comparación en el overlay
  _fClosedCandles.push({
    isG  : color==='G',
    force: parseFloat(strength)||5,
    ticks: c.ticks||0,
    body : bodyRatio||0,
    priceCount: _fPriceGroups.length>0 ? _fPriceGroups[_fPriceGroups.length-1].length : 0
  });
  if (_fClosedCandles.length > 20) _fClosedCandles.shift();
  // F — registrar win rate: comparar predicción anterior vs color real
  if (typeof _lastPredForWin !== 'undefined' && _lastPredForWin !== null && _activeAsset) {
    _recordWin(_activeAsset, _lastPredForWin, color);
    _lastPredForWin = null;
  }
  // Nuevo grupo de precios para la próxima vela
  _fPriceGroups.push([]);
  if (_fPriceGroups.length > 8) _fPriceGroups.shift();
}


// ════════════════════════════════════════════════════════════════
// PRESSURE OVERLAY — presión compra/venta en tiempo real
// Muestra los últimos N precios como delta acumulado
// Se actualiza con cada precio del WS — sin throttle
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// FORCE OVERLAY — franja lateral derecha, vertical
// Se posiciona sobre el panel de precios de PO sin tapar velas
// ════════════════════════════════════════════════════════════════
var _fEl      = null;
var _fCanvas  = null;
var _fCtx     = null;
var _fRaf     = false;
var _fPrices  = [];
var _fCandle    = null;
var _fPrevForce = 0;
var _fThreshold     = 0.5;
var _fDragging      = false;
var _fDragOffY      = 0;
var _fLastPrice     = null;
var _fLastTs        = 0;
var _fStale         = false;
var _fClosedCandles = [];
var _fPriceGroups   = [[]];
var _fBars = 15;
var _fMarkerX    = 0.5;
var _fDragMarker = false;
var _fDragMarker = false;
var _fCollapsed  = true; // ocultar gráfico/sentimiento por defecto

// Load threshold from storage
try { chrome.storage.local.get(['force_threshold','force_bars','force_collapsed'], function(r) {
  if (r.force_threshold != null) _fThreshold = r.force_threshold;
  if (r.force_bars) _fBars = r.force_bars;
  if (r.force_marker != null) _fMarkerX = r.force_marker;
  if (r.force_collapsed != null) _fCollapsed = r.force_collapsed;
  // Aplicar tamaño inicial según estado
  if (_fEl) _applyCollapsedSize();
}); } catch(e2) {}

function _applyCollapsedSize() {
  if (!_fEl) return;
  var signal  = _fEl.querySelector('#cmd-fsignal');
  var canvas  = _fEl.querySelector('#cmd-fcanvas');
  var advCv   = _fEl.querySelector('#cmd-adv-canvas');
  var slider  = _fEl.querySelector('#cmd-fslider');
  var btn     = _fEl.querySelector('#cmd-fexpand');
  if (_fCollapsed) {
    _fEl.style.height = '120px';
    // básico: mostrar señal DOM, ocultar canvas
    if (signal) signal.style.display = 'flex';
    if (canvas) canvas.style.display = 'none';
    if (advCv)  advCv.style.display  = 'none';
    if (slider) slider.style.display = 'none';
    if (btn) btn.textContent = '▼';
  } else {
    _fEl.style.height = '';
    // básico: ocultar señal DOM (el canvas ya la pinta), mostrar canvas
    if (signal) signal.style.display = 'none';
    if (canvas) canvas.style.display = 'block';
    if (advCv)  advCv.style.display  = 'block';
    if (slider) slider.style.display = 'flex';
    if (btn) btn.textContent = '▲';
  }
  if (!_fRaf) { _fRaf = true; requestAnimationFrame(_forceDraw); }
}

function _ensureForce() {
  if (_fEl) return;
  // Eliminar cualquier overlay duplicado que exista
  var _old = document.getElementById('cmd-rev');
  if (_old) { _old.parentNode.removeChild(_old); }
  _fEl = null; _fCanvas = null; _fCtx = null;

  // ── OVERLAY DESDE CERO ──────────────────────────────────────
  var el = document.createElement('div');
  el.id = 'cmd-rev';
  el.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'width:190px',
    'height:330px',
    'background:#050510',
    'border:1px solid #333',
    'border-radius:8px',
    'z-index:2147483647',
    'overflow:hidden',
    'display:flex',
    'flex-direction:column',
    'font-family:monospace',
    'box-shadow:0 4px 20px rgba(0,0,0,.8)',
    'cursor:default',
    'user-select:none'
  ].join(';');

  // Header
  var hdr = document.createElement('div');
  hdr.id = 'cmd-rev-hdr';
  hdr.style.cssText = 'height:22px;background:#0a0a1a;display:flex;align-items:center;padding:0 8px;cursor:move;border-bottom:1px solid #222;flex-shrink:0';
  hdr.innerHTML = '<span style="color:#444;font-size:7px;letter-spacing:.1em">CMD·AI</span><span style="flex:1"></span><span id="cmd-rev-sz" style="color:#333;font-size:6px"></span>';
  el.appendChild(hdr);

  // Canvas
  var cv = document.createElement('canvas');
  cv.id = 'cmd-rev-cv';
  cv.style.cssText = 'display:block;flex:1';
  el.appendChild(cv);

  // Resize handle BR
  var rz = document.createElement('div');
  rz.style.cssText = 'position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:se-resize;background:linear-gradient(135deg,transparent 50%,#333 50%)';
  el.appendChild(rz);

  document.body.appendChild(el);
  _fEl     = el;
  _fCanvas = cv;
  _fCtx    = cv.getContext('2d');

  console.log('%c CMD·AI OVERLAY CREADO ', 'background:#00e676;color:#000;font-size:11px');

  // Set canvas size immediately
  function _resize() {
    cv.width  = el.offsetWidth;
    cv.height = el.offsetHeight - 22;
    if (!_fRaf) { _fRaf=true; requestAnimationFrame(_forceDraw); }
  }
  setTimeout(_resize, 50);

  // Load saved position
  try { chrome.storage.local.get(['fpos','force_threshold','force_bars'], function(r) {
    if (r.fpos) {
      if (r.fpos.r != null) el.style.right  = r.fpos.r + 'px';
      if (r.fpos.b != null) el.style.bottom = r.fpos.b + 'px';
      if (r.fpos.w) el.style.width  = r.fpos.w + 'px';
      if (r.fpos.h) el.style.height = r.fpos.h + 'px';
    }
    if (r.force_threshold != null) _fThreshold = r.force_threshold;
    if (r.force_bars) _fBars = r.force_bars;
    setTimeout(_resize, 50);
  }); } catch(ex) {}

  function _savePos() {
    try { chrome.storage.local.set({fpos:{
      r:parseInt(el.style.right)||8, b:parseInt(el.style.bottom)||8,
      w:el.offsetWidth, h:el.offsetHeight
    }}); } catch(ex) {}
    var sz = document.getElementById('cmd-rev-sz');
    if (sz) sz.textContent = el.offsetWidth+'×'+el.offsetHeight;
  }

  // Drag
  var _dx=false,_dsx=0,_dsy=0,_dr=0,_db=0;
  hdr.addEventListener('mousedown', function(e) {
    _dx=true; _dsx=e.clientX; _dsy=e.clientY;
    _dr=parseInt(el.style.right)||8; _db=parseInt(el.style.bottom)||8;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!_dx) return;
    el.style.right  = Math.max(0,_dr-(e.clientX-_dsx))+'px';
    el.style.bottom = Math.max(0,_db-(e.clientY-_dsy))+'px';
    _resize();
  });
  document.addEventListener('mouseup', function() {
    if (!_dx) return; _dx=false; _savePos();
  });

  // Resize from corner
  var _rx=false,_rsx=0,_rsy=0,_rw=0,_rh=0;
  rz.addEventListener('mousedown', function(e) {
    _rx=true; _rsx=e.clientX; _rsy=e.clientY;
    _rw=el.offsetWidth; _rh=el.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if (!_rx) return;
    el.style.width  = Math.max(140,_rw+(e.clientX-_rsx))+'px';
    el.style.height = Math.max(180,_rh+(e.clientY-_rsy))+'px';
    _resize();
  });
  document.addEventListener('mouseup', function() {
    if (!_rx) return; _rx=false; _savePos();
  });

  // Watchdog: redraw every second
  setInterval(function() {
    if (!_fEl || !_fCanvas || !_fCtx) return;
    // Re-sync canvas size if panel was resized
    if (cv.width !== el.offsetWidth || cv.height !== el.offsetHeight-22) _resize();
    if (!_fRaf) { _fRaf=true; requestAnimationFrame(_forceDraw); }
  }, 1000);
}

var _fTab = 'actual'; // 'actual' | 'velas'

function _drawActual(ctx, W, H) {
  var cc=_fClosedCandles,prices=_fPrices,n=prices.length,c=_fCandle;
  _fRaf = false;
  var cv = _fCanvas; if (!cv || !_fCtx) return;
  var W = cv.width||190, H = cv.height||308;
  if (W<10||H<10){W=190;H=308;cv.width=W;cv.height=H;}
  var ctx = _fCtx;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#050510'; ctx.fillRect(0,0,W,H);
  ctx.textAlign='center'; var cx=W/2;

  var cc=_fClosedCandles, prices=_fPrices, n=prices.length, c=_fCandle;

  if (cc.length<2 || n<4) {
    ctx.fillStyle='rgba(255,255,255,.3)'; ctx.font='9px monospace';
    ctx.fillText('Esperando datos...', cx, H/2);
    ctx.fillStyle='rgba(255,255,255,.15)'; ctx.font='7px monospace';
    ctx.fillText(cc.length+' velas · '+n+' ticks', cx, H/2+16);
    ctx.textAlign='left'; return;
  }

  // ═══════════════════════════════════════════════════════════
  // PREGUNTA CLAVE: ¿La vela ACTUAL está revirtiendo?
  // Si sí → la SIGUIENTE vela irá en sentido contrario
  // ═══════════════════════════════════════════════════════════

  // Dirección dominante de la vela actual según sus ticks
  var upT=0, dnT=0;
  for (var i=1;i<n;i++){
    if(prices[i]>prices[i-1]) upT++;
    else if(prices[i]<prices[i-1]) dnT++;
  }
  var candleDir = upT >= dnT; // true=alcista, false=bajista

  // Dirección de la vela anterior cerrada
  var prevCandle = cc[cc.length-1];
  var prevDir = prevCandle.isG;

  // ¿Hubo cambio de dirección respecto a la vela anterior?
  var dirChanged = candleDir !== prevDir;

  // ── ANÁLISIS INTERNO DE LA VELA ACTUAL ──────────────────────
  // Dividir los ticks en 3 partes: inicio / medio / fin
  var third = Math.floor(n/3);
  var sumA=0, sumB=0, sumC=0; // inicio, medio, fin
  for (var j=1;j<third;j++) sumA+=prices[j]-prices[j-1];
  for (var j2=third;j2<third*2;j2++) sumB+=prices[j2]-prices[j2-1];
  for (var j3=third*2;j3<n;j3++) sumC+=prices[j3]-prices[j3-1];

  // Tendencia: ¿el precio empezó en una dirección y terminó en otra?
  var startDir = sumA >= 0;
  var endDir   = sumC >= 0;
  var internalFlip = startDir !== endDir && n >= 8;

  // Fuerza del flip: qué tan fuerte es el giro interno
  var flipStrength = 0;
  if (internalFlip) {
    var total = Math.abs(sumA)+Math.abs(sumC)||0.00001;
    flipStrength = Math.min(1, Math.abs(sumC)/total);
  }

  // Últimos 3 ticks vs dirección dominante — ¿frenando?
  var last3=0, contra3=0;
  for (var k=n-3;k<n;k++) if(k>0){
    var d=prices[k]-prices[k-1];
    if(candleDir ? d<0 : d>0) contra3++;
    else last3++;
  }
  var braking = contra3 >= 2; // 2 de los últimos 3 van en contra

  // Wick actual — ¿precio rechazado en el extremo?
  var wickReject = false;
  if (c) {
    var rng=(c.high-c.low)||0.00001;
    var wickTop=(c.high-prices[n-1])/rng;
    var wickBot=(prices[n-1]-c.low)/rng;
    // Si alcista y hay mecha superior larga = rechazo
    if (candleDir && wickTop > 0.35) wickReject=true;
    if (!candleDir && wickBot > 0.35) wickReject=true;
  }

  // Racha de velas anteriores en la misma dirección
  var streak=0;
  for (var s2=cc.length-1;s2>=0&&cc[s2].isG===prevDir;s2--) streak++;

  // ── SCORE FINAL ─────────────────────────────────────────────
  // Cada señal dice: "la vela actual ESTÁ revirtiendo"
  var score = 0;
  var sigs = [];

  if (dirChanged) {
    score += 0.30;
    sigs.push('cambio dirección');
  }
  if (internalFlip && flipStrength > 0.4) {
    score += 0.25;
    sigs.push('giro interno');
  }
  if (braking) {
    score += 0.20;
    sigs.push('frenando');
  }
  if (wickReject) {
    score += 0.20;
    sigs.push('mecha rechazo');
  }
  if (streak >= 3 && dirChanged) {
    score += 0.15; // racha larga que ahora revierte = más peso
    sigs.push('racha '+streak);
  }

  score = Math.min(1, score);

  // Dirección de la SIGUIENTE vela (si hay reversión)
  // = contraria a la dirección dominante de velas anteriores
  var nextDir = !prevDir;

  // ═══════════════════════════════════════════════════════════
  // DISPLAY
  // ═══════════════════════════════════════════════════════════

  // Zona superior — señal principal
  var SIG_H = Math.round(H * 0.62);

  if (score >= 0.50) {
    // ── REVERSIÓN EN CURSO — entra en la siguiente vela ──────
    var pulse = 0.55+0.45*Math.sin(Date.now()/200);

    ctx.fillStyle='rgba(40,0,8,'+(0.7+pulse*0.25)+')';
    ctx.fillRect(0,0,W,SIG_H);

    // Círculo pulsante
    var cr=Math.min(W,SIG_H)*0.24, cy2=SIG_H*0.34;
    ctx.globalAlpha=0.1+pulse*0.25;
    ctx.beginPath(); ctx.arc(cx,cy2,cr*1.6,0,Math.PI*2);
    ctx.fillStyle='#ff1744'; ctx.fill();
    ctx.globalAlpha=1;
    ctx.beginPath(); ctx.arc(cx,cy2,cr,0,Math.PI*2);
    ctx.fillStyle='#ff1744'; ctx.fill();
    ctx.font='bold '+Math.round(cr*.8)+'px monospace';
    ctx.fillStyle='#fff'; ctx.fillText('↕',cx,cy2+cr*.3);

    ctx.font='bold '+Math.round(W*.095)+'px monospace';
    ctx.fillStyle='#ff3355'; ctx.fillText('REVIRTIENDO',cx,SIG_H*.64);

    ctx.font='bold '+Math.round(W*.085)+'px monospace';
    ctx.fillStyle=nextDir?'#00e676':'#ff6b6b';
    ctx.fillText('SIG. VELA '+( nextDir?'▲ SUBE':'▼ BAJA'),cx,SIG_H*.78);

    ctx.font='7px monospace'; ctx.fillStyle='rgba(255,200,200,.7)';
    ctx.fillText(sigs.slice(0,2).join(' + '),cx,SIG_H*.91);

    if(!_fRaf){_fRaf=true;requestAnimationFrame(_forceDraw);}

  } else if (score >= 0.25) {
    // ── SEÑAL DÉBIL — posible reversión ──────────────────────
    ctx.fillStyle='rgba(28,12,0,.85)'; ctx.fillRect(0,0,W,SIG_H);

    var cr3=Math.min(W,SIG_H)*0.18, cy3=SIG_H*0.32;
    ctx.beginPath(); ctx.arc(cx,cy3,cr3,0,Math.PI*2);
    ctx.fillStyle='rgba(255,140,0,.55)'; ctx.fill();
    ctx.font='bold '+Math.round(cr3*.9)+'px monospace';
    ctx.fillStyle='#fff'; ctx.fillText('⚠',cx,cy3+cr3*.32);

    ctx.font='bold '+Math.round(W*.085)+'px monospace';
    ctx.fillStyle='#ffa040'; ctx.fillText('POSIBLE',cx,SIG_H*.60);
    ctx.fillText('REVERSO',cx,SIG_H*.73);
    ctx.font=Math.round(W*.075)+'px monospace';
    ctx.fillStyle=nextDir?'rgba(0,200,80,.7)':'rgba(255,100,100,.7)';
    ctx.fillText(nextDir?'→ SUBE':'→ BAJA',cx,SIG_H*.87);
    ctx.font='7px monospace'; ctx.fillStyle='rgba(255,200,100,.5)';
    ctx.fillText(sigs.join(' · '),cx,SIG_H*.97);

  } else {
    // ── NEUTRAL — vela continúa normal ───────────────────────
    ctx.fillStyle='rgba(5,5,16,.95)'; ctx.fillRect(0,0,W,SIG_H);

    // Ticks como grafico de línea
    if (n>=2) {
      var gH=Math.round(SIG_H*.55), gY=Math.round(SIG_H*.10);
      var pMn=Math.min.apply(null,prices),pMx=Math.max.apply(null,prices);
      var pSp=pMx-pMn||0.00001;
      ctx.beginPath();
      ctx.moveTo(8, gY+gH-Math.round(((prices[0]-pMn)/pSp)*(gH-4)));
      for (var ti=1;ti<n;ti++) {
        var tx=8+ti*(W-16)/(n-1);
        var ty=gY+gH-Math.round(((prices[ti]-pMn)/pSp)*(gH-4));
        ctx.lineTo(tx,ty);
      }
      ctx.strokeStyle=candleDir?'rgba(0,200,80,.6)':'rgba(200,0,40,.6)';
      ctx.lineWidth=1.5; ctx.stroke();
    }

    // Dirección actual
    ctx.font='bold '+Math.round(W*.085)+'px monospace';
    ctx.fillStyle=candleDir?'rgba(0,200,80,.7)':'rgba(200,0,40,.7)';
    ctx.fillText(candleDir?'▲ SUBE':'▼ BAJA', cx, SIG_H*.78);
    ctx.font='7px monospace'; ctx.fillStyle='rgba(255,255,255,.2)';
    ctx.fillText('sin reversión', cx, SIG_H*.90);
    if (streak>=2) {
      ctx.fillStyle='rgba(255,255,255,.15)';
      ctx.fillText('racha '+(prevDir?'▲':'▼')+'×'+streak, cx, SIG_H*.98);
    }
  }

  // ── Barra score ──────────────────────────────────────────────
  var SB_Y = SIG_H+4;
  ctx.fillStyle='rgba(255,255,255,.04)'; ctx.fillRect(8,SB_Y,W-16,4);
  ctx.fillStyle=score>=0.50?'#ff1744':score>=0.25?'#ffa500':'rgba(255,255,255,.15)';
  ctx.fillRect(8,SB_Y,(W-16)*score,4);

  // ── Historial de velas ───────────────────────────────────────
  var HIST_Y = SB_Y+10, HIST_H=H-HIST_Y-4;
  if (HIST_H>20) {
    var nb=Math.min(14,cc.length), bw2=Math.floor((W-16)/nb);
    for (var bi=0;bi<nb;bi++) {
      var bc=cc[cc.length-nb+bi];
      var bh2=Math.max(3,Math.round((bc.force/10)*(HIST_H-4)));
      var bx2=8+bi*bw2;
      var inS=bi>=nb-streak;
      var al=0.25+(bc.force/10)*0.55;
      ctx.fillStyle=bc.isG?'rgba(0,200,80,'+al+')':'rgba(200,0,40,'+al+')';
      ctx.fillRect(bx2+1,HIST_Y+HIST_H-bh2,bw2-2,bh2);
      if(inS){
        ctx.strokeStyle=bc.isG?'rgba(0,255,100,.6)':'rgba(255,50,50,.6)';
        ctx.lineWidth=1.5; ctx.strokeRect(bx2+1,HIST_Y+HIST_H-bh2,bw2-2,bh2);
      }
    }
    // Vela actual (en progreso)
    if (n>=2) {
      var curUp=upT>=dnT;
      var curF=Math.min(10,Math.abs(prices[n-1]-prices[0])/(Math.max.apply(null,prices)-Math.min.apply(null,prices)||0.00001)*8);
      var cbh=Math.max(3,Math.round((curF/10)*(HIST_H-4)));
      var cbx=8+(nb)*bw2;
      if(cbx+bw2-2<=W-8){
        ctx.fillStyle=curUp?'rgba(0,200,80,.4)':'rgba(200,0,40,.4)';
        ctx.fillRect(cbx+1,HIST_Y+HIST_H-cbh,bw2-2,cbh);
        ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1;
        ctx.strokeRect(cbx+1,HIST_Y+HIST_H-cbh,bw2-2,cbh);
      }
    }
  }

  ctx.textAlign='left';
}

function _drawVelas(ctx, W, H) {
  var cc=_fClosedCandles,prices=_fPrices,n=prices.length,c=_fCandle;
  _fRaf = false;
  var cv = _fCanvas; if (!cv || !_fCtx) return;
  var W = cv.width || 190; var H = cv.height || 308;
  if (W < 10 || H < 10) { W=190; H=308; cv.width=W; cv.height=H; }
  var ctx = _fCtx;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#050510'; ctx.fillRect(0,0,W,H);
  ctx.textAlign='center'; var cx=W/2;

  var cc = _fClosedCandles;   // velas cerradas [{isG,force,ticks,body}]
  var prices = _fPrices;      // ticks raw actuales
  var n = prices.length;

  // Necesitamos al menos 3 velas cerradas
  if (cc.length < 3) {
    ctx.fillStyle='rgba(255,255,255,.3)'; ctx.font='9px monospace';
    ctx.fillText('Esperando velas...', cx, H/2);
    ctx.fillStyle='rgba(255,255,255,.15)'; ctx.font='7px monospace';
    ctx.fillText(cc.length+' / 3 velas', cx, H/2+16);
    ctx.textAlign='left'; return;
  }

  // ════════════════════════════════════════════════════════════
  // MOTOR DE REVERSIÓN — basado en comportamiento entre velas
  // ════════════════════════════════════════════════════════════

  var rev = 0; // score 0-1
  var reasons = [];
  var revDir = false; // hacia dónde va la reversión

  // ── PATRÓN 1: Racha larga (3+ velas iguales) ─────────────────
  // Cuantas velas seguidas del mismo color = más probabilidad de reversa
  var streak = 1;
  var streakColor = cc[cc.length-1].isG;
  for (var i=cc.length-2; i>=0 && cc[i].isG===streakColor; i--) streak++;
  if (streak >= 4) {
    rev += 0.35; revDir = !streakColor;
    reasons.push(streak+'× '+( streakColor?'▲':'▼')+' seguidas');
  } else if (streak >= 3) {
    rev += 0.20; revDir = !streakColor;
    reasons.push('racha '+streak);
  }

  // ── PATRÓN 2: Fuerza cayendo en la racha ─────────────────────
  // Si la fuerza va bajando vela a vela = agotamiento
  if (streak >= 2) {
    var last3 = cc.slice(-Math.min(streak,3));
    var forceDrop = last3[0].force - last3[last3.length-1].force;
    if (forceDrop > 1.5) {
      rev += 0.20;
      reasons.push('fuerza ↓ '+forceDrop.toFixed(1));
    }
  }

  // ── PATRÓN 3: Vela actual va CONTRA la racha ─────────────────
  // Si los ticks actuales van en dirección contraria a la racha
  if (n >= 4 && streak >= 2) {
    var upT=0, dnT=0;
    for (var j=1; j<n; j++) {
      if (prices[j]>prices[j-1]) upT++; else if(prices[j]<prices[j-1]) dnT++;
    }
    var tickDir = upT >= dnT;
    if (tickDir !== streakColor && Math.abs(upT-dnT) >= 2) {
      rev += 0.25; revDir = tickDir;
      reasons.push('ticks '+(tickDir?'▲':'▼')+' vs racha');
    }
  }

  // ── PATRÓN 4: Vela anterior muy débil (duda del mercado) ──────
  var prevCandle = cc[cc.length-1];
  if (prevCandle.force < 3.5 && streak >= 2) {
    rev += 0.15;
    reasons.push('última débil F'+prevCandle.force.toFixed(1));
  }

  // ── PATRÓN 5: Frenazo en ticks actuales ──────────────────────
  // Los últimos 3 ticks van en contra de los 3 anteriores
  if (n >= 7) {
    var last3up=0,last3dn=0,prev3up=0,prev3dn=0;
    for (var k=n-3;k<n;k++) if(k>0){if(prices[k]>prices[k-1])last3up++;else last3dn++;}
    for (var k2=n-6;k2<n-3;k2++) if(k2>0){if(prices[k2]>prices[k2-1])prev3up++;else prev3dn++;}
    var prevDir3=prev3up>=prev3dn, lastDir3=last3up>=last3dn;
    if (prevDir3!==lastDir3 && Math.abs(last3up-last3dn)>=2) {
      rev += 0.20; revDir = lastDir3;
      reasons.push('frenazo');
    }
  }

  rev = Math.min(1, rev);

  // ════════════════════════════════════════════════════════════
  // DISPLAY
  // ════════════════════════════════════════════════════════════

  // Mini gráfico de velas cerradas (fondo siempre visible)
  var CHART_H = Math.round(H * 0.30);
  var CHART_Y = H - CHART_H - 6;
  var nBars = Math.min(12, cc.length);
  var bw = Math.floor((W-16)/nBars);
  for (var bi=0; bi<nBars; bi++) {
    var bc = cc[cc.length-nBars+bi];
    var bh = Math.max(3, Math.round((bc.force/10)*(CHART_H-4)));
    var bx = 8 + bi*bw;
    var alpha = 0.3 + (bc.force/10)*0.6;
    ctx.fillStyle = bc.isG ? 'rgba(0,200,80,'+alpha+')' : 'rgba(200,0,40,'+alpha+')';
    ctx.fillRect(bx+1, CHART_Y+CHART_H-bh, bw-2, bh);
    // Marcar racha con borde
    var inStreak = bi >= nBars-streak;
    if (inStreak) {
      ctx.strokeStyle = bc.isG ? 'rgba(0,255,100,.5)' : 'rgba(255,50,50,.5)';
      ctx.lineWidth = 1.5; ctx.strokeRect(bx+1, CHART_Y+CHART_H-bh, bw-2, bh);
    }
  }
  // Línea base chart
  ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(8,CHART_Y+CHART_H); ctx.lineTo(W-8,CHART_Y+CHART_H); ctx.stroke();

  // Score bar
  var SB_Y = CHART_Y - 14;
  ctx.fillStyle='rgba(255,255,255,.05)'; ctx.fillRect(8,SB_Y,W-16,6);
  var sbColor = rev>=0.55?'#ff1744':rev>=0.30?'#ffa500':'rgba(255,255,255,.2)';
  ctx.fillStyle=sbColor; ctx.fillRect(8,SB_Y,(W-16)*rev,6);
  ctx.font='6px monospace'; ctx.fillStyle='rgba(255,255,255,.25)';
  ctx.fillText(Math.round(rev*100)+'%', W-12, SB_Y+5);
  ctx.textAlign='left';
  ctx.textAlign='center';

  if (rev >= 0.55) {
    // ── REVERSIÓN CONFIRMADA ────────────────────────────────
    var pulse = 0.6 + 0.4*Math.sin(Date.now()/220);

    // Fondo rojo
    ctx.fillStyle='rgba(40,0,8,'+(.7+pulse*.2)+')';
    ctx.fillRect(0,0,W,CHART_Y-20);

    // Círculo
    var cr = Math.min(W,CHART_Y-20)*.28;
    var cy = (CHART_Y-20)*.38;
    ctx.globalAlpha=.15+pulse*.2;
    ctx.beginPath(); ctx.arc(cx,cy,cr*1.5,0,Math.PI*2);
    ctx.fillStyle='#ff1744'; ctx.fill();
    ctx.globalAlpha=1;
    ctx.beginPath(); ctx.arc(cx,cy,cr,0,Math.PI*2);
    ctx.fillStyle='#ff1744'; ctx.fill();
    ctx.font='bold '+Math.round(cr*.85)+'px monospace';
    ctx.fillStyle='#fff'; ctx.fillText('↕',cx,cy+cr*.3);

    // Texto
    ctx.font='bold '+Math.round(W*.10)+'px monospace';
    ctx.fillStyle='#ff3355';
    ctx.fillText('REVERSIÓN',cx,(CHART_Y-20)*.66);
    ctx.font='bold '+Math.round(W*.085)+'px monospace';
    ctx.fillStyle=revDir?'#00e676':'#ff6b6b';
    ctx.fillText(revDir?'→ SUBE':'→ BAJA',cx,(CHART_Y-20)*.82);

    // Razón
    ctx.font='7px monospace'; ctx.fillStyle='rgba(255,200,200,.7)';
    ctx.fillText(reasons[0]||'',cx,(CHART_Y-20)*.95);

    if(!_fRaf){_fRaf=true;requestAnimationFrame(_forceDraw);}

  } else if (rev >= 0.30) {
    // ── POSIBLE REVERSIÓN ───────────────────────────────────
    ctx.fillStyle='rgba(30,12,0,.8)'; ctx.fillRect(0,0,W,CHART_Y-20);

    var cr2=Math.min(W,CHART_Y-20)*.22;
    var cy2=(CHART_Y-20)*.35;
    ctx.beginPath(); ctx.arc(cx,cy2,cr2,0,Math.PI*2);
    ctx.fillStyle='rgba(255,140,0,.6)'; ctx.fill();
    ctx.font='bold '+Math.round(cr2*.9)+'px monospace';
    ctx.fillStyle='#fff'; ctx.fillText('⚠',cx,cy2+cr2*.32);

    ctx.font='bold '+Math.round(W*.09)+'px monospace';
    ctx.fillStyle='#ffa040';
    ctx.fillText('POSIBLE',cx,(CHART_Y-20)*.62);
    ctx.fillText('REVERSO',cx,(CHART_Y-20)*.75);
    ctx.font=Math.round(W*.08)+'px monospace';
    ctx.fillStyle=revDir?'rgba(0,220,100,.8)':'rgba(255,100,100,.8)';
    ctx.fillText(revDir?'→ SUBE':'→ BAJA',cx,(CHART_Y-20)*.89);
    ctx.font='7px monospace'; ctx.fillStyle='rgba(255,200,100,.5)';
    ctx.fillText(reasons.join(' · '),cx,(CHART_Y-20)*.98);

  } else {
    // ── NEUTRAL — sin señal ─────────────────────────────────
    ctx.fillStyle='rgba(5,5,16,.9)'; ctx.fillRect(0,0,W,CHART_Y-20);

    // Ticks actuales
    if (n >= 2) {
      var tH=Math.round((CHART_Y-20)*.55), tY=Math.round((CHART_Y-20)*.08);
      var pMn=Math.min.apply(null,prices), pMx=Math.max.apply(null,prices);
      var pSp=pMx-pMn||0.00001;
      var tw=(W-16)/n;
      for (var ti=1;ti<n;ti++) {
        var up2=prices[ti]>=prices[ti-1];
        var th2=Math.max(2,Math.round(((prices[ti]-pMn)/pSp)*(tH-4)));
        var tx2=8+ti*tw;
        ctx.fillStyle=up2?'rgba(0,180,70,.5)':'rgba(180,0,30,.5)';
        ctx.fillRect(tx2,tY+tH-th2,Math.max(1,tw),th2);
      }
    }

    // Info racha
    ctx.font='8px monospace';
    ctx.fillStyle=streakColor?'rgba(0,200,80,.6)':'rgba(200,0,40,.6)';
    ctx.fillText('racha '+(streakColor?'▲':'▼')+' ×'+streak, cx, CHART_Y-30);
    ctx.font='7px monospace'; ctx.fillStyle='rgba(255,255,255,.2)';
    ctx.fillText('sin reversión', cx, CHART_Y-20);
  }

  ctx.textAlign='left';
}

function _forceDraw() {
  _fRaf = false;
  var cv = _fCanvas; if (!cv || !_fCtx) return;
  var W = cv.width||190, H = cv.height||308;
  if (W<10||H<10){W=190;H=308;cv.width=W;cv.height=H;}
  var ctx = _fCtx;
  var TAB_H = 22;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#050510'; ctx.fillRect(0,0,W,H);

  // ── PESTAÑAS ────────────────────────────────────────────────
  var tabs = [{id:'actual',lbl:'ACTUAL'},{id:'velas',lbl:'VELAS'}];
  var tw = Math.floor(W/tabs.length);
  tabs.forEach(function(t,i){
    var active = _fTab===t.id;
    ctx.fillStyle = active ? 'rgba(24,255,255,.12)' : 'rgba(255,255,255,.03)';
    ctx.fillRect(i*tw, 0, tw-1, TAB_H);
    ctx.strokeStyle = active ? '#18ffff' : 'rgba(255,255,255,.08)';
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(i*tw, TAB_H-1); ctx.lineTo(i*tw+tw-1, TAB_H-1); ctx.stroke();
    ctx.fillStyle = active ? '#18ffff' : 'rgba(255,255,255,.3)';
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(t.lbl, i*tw + tw/2, TAB_H-7);
  });
  // Separador inferior tabs
  ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,TAB_H); ctx.lineTo(W,TAB_H); ctx.stroke();

  // ── CONTENIDO ───────────────────────────────────────────────
  ctx.save();
  ctx.translate(0, TAB_H);
  var CH = H - TAB_H;
  var cc=_fClosedCandles, prices=_fPrices, n2=prices.length, c=_fCandle;
  if (_fTab==='actual') _drawActual(ctx, W, CH);
  else                  _drawVelas (ctx, W, CH);
  ctx.restore();

  // Click en pestañas — registrar handler una vez
  if (!cv._tabHandlerSet) {
    cv._tabHandlerSet = true;
    cv.addEventListener('click', function(e){
      var rect = cv.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      if (y <= TAB_H) {
        var idx = Math.floor(x / (cv.width/tabs.length));
        _fTab = tabs[idx] ? tabs[idx].id : _fTab;
        if(!_fRaf){_fRaf=true;requestAnimationFrame(_forceDraw);}
      }
    });
  }
}

function _forceRawTick(price, candle) {
  var now = Date.now();
  // Solo agregar si el precio cambió
  if (price !== _fLastPrice) {
    _fPrices.push(price);
    if (_fPrices.length > 80) _fPrices.shift();
    // Agregar al grupo de vela actual
    if (_fPriceGroups.length > 0) {
      _fPriceGroups[_fPriceGroups.length-1].push(price);
    }
    _fLastPrice = price;
    _fLastTs    = now;
    _fStale     = false;
  } else {
    // Precio igual — marcar como stale si lleva >3s sin cambio
    _fStale = (now - _fLastTs) > 3000;
  }
  if (candle) _fCandle = candle;
  if (!_fRaf) {
    _fRaf = true;
    requestAnimationFrame(_forceDraw);
  }
}

// Watchdog moved inside _ensureForce

function _drawAdvanced(isG, forceBase, upTicks, dnTicks, predDir, pct, conf, gap,
                       semaforo, semaCol, semaBg, semaMsg, rem, noContra) {
  var c = _fCandle;
  if (!c) return;

  // A — ventana dinámica
  var winN = _getTickWindow();
  var wp   = _fPrices.slice(-winN);
  var wUp = 0, wDn = 0;
  for (var wi=1;wi<wp.length;wi++){
    if (wp[wi]>wp[wi-1]) wUp++; else if (wp[wi]<wp[wi-1]) wDn++;
  }
  var wTotal  = wUp+wDn||1;
  var wBull   = Math.round(wUp/wTotal*100);
  var wBear   = 100-wBull;
  var wDir    = wUp>=wDn;
  var wGap    = Math.abs(wBull-wBear);
  var wConf   = wGap>=20?'ALTA':wGap>=10?'MEDIA':'BAJA';

  // B — sesión
  var sess      = _getSession(Date.now()/1000);
  var sf        = _sessionFactor(sess.name);
  var forceAdj  = parseFloat(Math.min(10, forceBase*sf).toFixed(1));

  // C — streak
  var streak = _calcStreak();
  var streakOk = streak.n < 2 || (streak.isG === wDir);

  // D — aceleración
  var accel = _calcAccel(c);

  // E — umbral adaptativo
  var spr    = _fCandle && _fCandle.realSpreadCount > 0
    ? (_fCandle.realSpreadSum / _fCandle.realSpreadCount) / (_avgSpread(_activeAsset)||1)
    : 1;
  var athresh = _adaptiveThreshold(_fThreshold, spr);
  var advAbove = (forceAdj/10) >= athresh;

  // F — win rate
  var wr = _getWinRate(_activeAsset);
  // guardar pred actual (se compara en closeCandle)
  if (wGap >= 10) _lastPredForWin = wDir;

  // G — divergencia
  var divR = _calcDivergence(isG, upTicks, dnTicks);

  // semáforo avanzado
  var goodConf = wGap >= 10;
  var goodTime = rem <= 4 && rem > 0;
  var aS, aSCol, aSBg, aSMsg;
  if (goodConf && advAbove && goodTime && noContra && !divR.div && streakOk) {
    aS='🟢'; aSCol='#00ff88'; aSBg='rgba(0,60,25,.9)';
    aSMsg = streak.n>=3 ? '¡ENTRAR! ×'+streak.n : '¡ENTRAR AHORA!';
  } else if (goodConf && advAbove && !goodTime && noContra && streakOk) {
    aS='🟡'; aSCol='#ffc400'; aSBg='rgba(40,30,0,.8)';
    aSMsg = 'ESPERAR '+(Math.ceil(rem-4)||'')+'s';
  } else if (divR.div) {
    aS='🟠'; aSCol='#ff9900'; aSBg='rgba(50,25,0,.8)'; aSMsg=divR.msg;
  } else if (!streakOk) {
    aS='🔴'; aSCol='#ff4444'; aSBg='rgba(50,0,10,.8)'; aSMsg='STREAK CONTRA';
  } else if (!goodConf || !noContra) {
    aS='🔴'; aSCol='#ff4444'; aSBg='rgba(50,0,10,.8)';
    aSMsg = !goodConf ? 'SEÑAL DÉBIL' : 'CONTRADICCIÓN';
  } else {
    aS='🟡'; aSCol='#ffc400'; aSBg='rgba(40,30,0,.8)';
    aSMsg = !advAbove ? 'FUERZA BAJA' : 'ESPERAR';
  }

  // ── Actualizar DOM avanzado ───────────────────────────────────
  var el = function(id){ return document.getElementById(id); };
  var aArr = el('cmd-adv-arrow'); var aLbl = el('cmd-adv-label');
  var aPct = el('cmd-adv-pct');   var aSem = el('cmd-adv-sema');
  if (aArr){ aArr.textContent=wDir?'▲':'▼'; aArr.style.color=wDir?'#00e676':'#ff1744'; }
  if (aLbl){ aLbl.textContent=wDir?'COMPRAR':'VENDER'; aLbl.style.color=wDir?'#00e676':'#ff1744'; }
  if (aPct){ aPct.textContent=(wDir?wBull:wBear)+'% · '+wConf+' ('+winN+'t)';
             aPct.style.color=wGap>=20?aSCol:wGap>=10?'#ffc400':'rgba(255,255,255,.35)'; }
  if (aSem){ aSem.textContent=aS+' '+aSMsg; aSem.style.background=aSBg;
             aSem.style.color=aSCol; aSem.style.border='1px solid '+aSCol+'88'; }

  var cSess=el('cadv-sess'), cStr=el('cadv-streak'), cAcc=el('cadv-accel');
  var cThr=el('cadv-thresh'), cWr=el('cadv-wr'), cDiv=el('cadv-div');
  if (cSess){ cSess.textContent=forceAdj+'  (×'+sf.toFixed(1)+' '+sess.name+')'; }
  if (cStr) { cStr.textContent=streak.n+(streak.isG?'🟢':'🔴')+(streakOk?'':' ✗');
              cStr.style.color=streakOk?'#18ffff':'#ff9900'; }
  if (cAcc) { cAcc.textContent=accel.toFixed(2)+'x'+(accel>=1.3?' 🔥':accel<=0.7?' 💤':'');
              cAcc.style.color=accel>=1.3?'#ff9100':accel<=0.7?'rgba(255,255,255,.4)':'#18ffff'; }
  if (cThr) { cThr.textContent=athresh.toFixed(2)+(spr>1.2?' ↑spr':''); }
  if (cWr)  { cWr.textContent=wr!==null?wr+'%':'sin datos';
              cWr.style.color=wr===null?'rgba(255,255,255,.3)':wr>=55?'#00e676':wr>=45?'#ffc400':'#ff4444'; }
  if (cDiv) { cDiv.textContent=divR.msg; cDiv.style.color=divR.div?'#ff9900':'#00e676'; }

  // ── Canvas avanzado — gráfico de velas cerradas con fuerza ajustada ──
  var acv = _fEl ? _fEl._advCanvas : null;
  if (!acv || _fCollapsed) return;
  var actx = acv.getContext('2d');
  if (!actx) return;

  var AW = Math.max(80, _fEl.offsetWidth||210);
  var AH = Math.max(60, acv.offsetHeight||80);
  acv.width = AW; acv.height = AH;
  actx.clearRect(0,0,AW,AH);
  actx.fillStyle='rgba(2,2,12,.95)'; actx.fillRect(0,0,AW,AH);

  var bars = _fClosedCandles.slice(-Math.min(20,_fBars));
  var nb   = bars.length;
  if (nb < 1) {
    actx.fillStyle='rgba(255,255,255,.3)'; actx.font='7px monospace';
    actx.textAlign='center'; actx.fillText('Sin velas aún',AW/2,AH/2);
    return;
  }

  var PAD=6, GW=AW-PAD*2, GH=AH-PAD*2-10;
  var bW  = Math.max(3, Math.floor(GW/nb)-1);

  // Barras: gris=fuerza base, borde=fuerza ajustada por sesión
  bars.forEach(function(bar,i){
    var bX  = PAD + i*(bW+1);
    var bH  = Math.max(2, Math.round((bar.force/10)*GH));
    var bY  = PAD+GH-bH;
    // Base semitransparente
    actx.fillStyle = bar.isG?'rgba(0,200,83,.35)':'rgba(213,0,0,.35)';
    actx.fillRect(bX,bY,bW,bH);
    // Fuerza ajustada — borde brillante
    var adjF = Math.min(10, bar.force*sf);
    var aH2  = Math.max(2, Math.round((adjF/10)*GH));
    var aY2  = PAD+GH-aH2;
    actx.strokeStyle = bar.isG?'rgba(0,255,100,.9)':'rgba(255,50,50,.9)';
    actx.lineWidth=1.5; actx.strokeRect(bX,aY2,bW,aH2);
  });

  // Línea de tendencia fuerza ajustada
  actx.strokeStyle='#18ffff'; actx.lineWidth=1.5; actx.setLineDash([]);
  actx.beginPath();
  bars.forEach(function(bar,i){
    var adjF = Math.min(10, bar.force*sf);
    var bX   = PAD+i*(bW+1)+bW/2;
    var bY   = PAD+GH-Math.round((adjF/10)*GH);
    i===0?actx.moveTo(bX,bY):actx.lineTo(bX,bY);
  });
  actx.stroke();

  // Streak indicator encima última barra
  if (streak.n>=2 && nb>0){
    var lb  = bars[nb-1];
    var lX  = PAD+(nb-1)*(bW+1)+bW/2;
    var lF  = Math.min(10,lb.force*sf);
    var lY  = PAD+GH-Math.round((lF/10)*GH)-7;
    actx.font='bold 8px monospace'; actx.textAlign='center';
    actx.fillStyle=streak.isG?'#00ff88':'#ff4444';
    actx.fillText(streak.n+(streak.isG?'▲':'▼'),lX,lY);
  }

  // Win rate + leyenda
  actx.font='6px monospace'; actx.textAlign='right';
  actx.fillStyle=wr!==null?(wr>=55?'#00e676':wr>=45?'#ffc400':'#ff4444'):'rgba(255,255,255,.3)';
  actx.fillText(wr!==null?'WR '+wr+'%':'—',AW-PAD,AH-2);
  actx.textAlign='left'; actx.fillStyle='rgba(255,255,255,.2)';
  actx.fillText(sess.name+' ×'+sf.toFixed(1),PAD,AH-2);
}
// ════════════════════════════════════════════════════════════════
// FUNCIONES PRO
// ════════════════════════════════════════════════════════════════

// PRO-A — Detectar patrón de vela
function _detectPattern(c) {
  if (!c) return { name:'—', bull:null, strength:0, emoji:'' };
  var body   = Math.abs(c.close - c.open);
  var range  = c.high - c.low || body || 0.00001;
  var br     = body / range;
  var isG    = c.close >= c.open;
  var wickT  = isG ? c.high - c.close : c.high - c.open;
  var wickB  = isG ? c.open - c.low   : c.close - c.low;
  var wtR    = wickT / range;
  var wbR    = wickB / range;

  // Doji — cuerpo muy pequeño
  if (br < 0.08) {
    if (wtR > 0.35 && wbR > 0.35) return { name:'Doji Cruz',  bull:null,  strength:2, emoji:'✝' };
    if (wtR > 0.55) return          { name:'Doji Lápida', bull:false, strength:3, emoji:'🪦' };
    if (wbR > 0.55) return          { name:'Doji Libélula',bull:true, strength:3, emoji:'🔔' };
    return                           { name:'Doji',        bull:null,  strength:1, emoji:'◆' };
  }
  // Marubozu — cuerpo enorme sin mechas
  if (br > 0.90) return { name: isG?'Marubozu ▲':'Marubozu ▼', bull:isG, strength:5, emoji: isG?'🟩':'🟥' };
  // Martillo / Estrella Fugaz
  if (wbR > 0.55 && wtR < 0.15 && br < 0.35) return { name:'Martillo', bull:true,  strength:4, emoji:'🔨' };
  if (wtR > 0.55 && wbR < 0.15 && br < 0.35) return { name:'Est.Fugaz', bull:false, strength:4, emoji:'💫' };
  // Spinning top — cuerpo medio con mechas equilibradas
  if (br < 0.30 && wtR > 0.25 && wbR > 0.25) return { name:'Spinning',  bull:null,  strength:1, emoji:'🌀' };
  // Vela de cuerpo grande con mecha contraria
  if (isG && wbR > 0.35 && br > 0.40) return { name:'Alcista Fuerte', bull:true,  strength:4, emoji:'💪' };
  if (!isG && wtR > 0.35 && br > 0.40) return { name:'Bajista Fuerte', bull:false, strength:4, emoji:'💪' };
  // Normal
  return { name: isG?'Alcista':'Bajista', bull:isG, strength:2, emoji: isG?'▲':'▼' };
}

// PRO-B — Detectar patrón multi-vela (últimas 3)
function _detectMultiPattern(candles) {
  if (!candles || candles.length < 2) return { name:'Esperando', emoji:'⏳', bull:null };
  var n = candles.length;
  var c0 = candles[n-1]; // actual / más reciente
  var c1 = candles[n-2]; // anterior
  var c2 = n >= 3 ? candles[n-3] : null;

  var g0 = c0.isG !== undefined ? c0.isG : c0.color==='G';
  var g1 = c1.isG !== undefined ? c1.isG : c1.color==='G';
  var g2 = c2 ? (c2.isG !== undefined ? c2.isG : c2.color==='G') : null;

  // Engulfing
  if (c0.str > c1.str * 1.3) {
    if (g0 && !g1) return { name:'Engulfing ▲', emoji:'🌊', bull:true };
    if (!g0 && g1) return { name:'Engulfing ▼', emoji:'🌊', bull:false };
  }
  // Tres seguidas mismo color
  if (c2 && g0===g1 && g1===g2) {
    return g0
      ? { name:'3 Alcistas', emoji:'🚀', bull:true }
      : { name:'3 Bajistas', emoji:'🔻', bull:false };
  }
  // Reversión: 2 opuestas + actual confirma cambio
  if (c2 && g2===g1 && g0!==g1) {
    return g0
      ? { name:'Reversión ▲', emoji:'↩️', bull:true }
      : { name:'Reversión ▼', emoji:'↩️', bull:false };
  }
  // Continuación
  if (g0===g1) return g0
    ? { name:'Continuación▲', emoji:'➡️', bull:true }
    : { name:'Continuación▼', emoji:'➡️', bull:false };

  return { name:'Indecisión', emoji:'↔️', bull:null };
}

// PRO-C — Score combinado 0-100
function _calcProScore(force, sessionFactor, streak, accel, gap, pattern, wr, noContra, divOk) {
  var s = 0;
  // Fuerza (0-25)
  s += Math.round((Math.min(10, force) / 10) * 25);
  // Sesión (0-10)
  s += Math.round((Math.min(1.2, sessionFactor) / 1.2) * 10);
  // Confianza ticks (0-20)
  s += Math.round((Math.min(30, gap) / 30) * 20);
  // Patrón (0-15)
  s += Math.round((pattern.strength / 5) * 15);
  // Win rate (0-15) — solo si hay datos
  if (wr !== null) s += Math.round((Math.max(0, wr - 40) / 40) * 15);
  else s += 7; // neutral si sin datos
  // Streak (0-5) — positivo si ≤2, penalizar streak largo contrario
  s += streak.n <= 2 ? 5 : Math.max(0, 5 - (streak.n - 2) * 2);
  // Aceleración (0-5)
  s += accel >= 1.3 ? 5 : accel >= 1.0 ? 3 : 1;
  // No contradicción (0-5)
  s += noContra ? 5 : 0;
  // Sin divergencia (bonus 0 o -10)
  if (!divOk) s = Math.max(0, s - 10);
  return Math.min(100, Math.max(0, s));
}

// PRO-D — Nivel de riesgo
function _calcRisk(score, gap, spread, accel, sessionName) {
  var risk = 0;
  if (score < 40)  risk += 3;
  else if (score < 60) risk += 2;
  else risk += 1;
  if (gap < 10) risk += 2;
  if (spread > 1.5) risk += 1;
  if (accel < 0.7 || accel > 2.5) risk += 1;
  if (sessionName === 'Off' || sessionName === 'Asia') risk += 1;
  if (risk <= 2) return { level:'BAJO',  color:'#00e676', bg:'rgba(0,60,25,.8)' };
  if (risk <= 4) return { level:'MEDIO', color:'#ffc400', bg:'rgba(40,30,0,.8)' };
  return              { level:'ALTO',  color:'#ff4444', bg:'rgba(50,0,10,.8)' };
}

// PRO-E — Historial de señales PRO (últimas 5)
var _proSignalLog = [];
try { chrome.storage.local.get(['cmd_pro_siglog'], function(r) {
  if (r.cmd_pro_siglog) _proSignalLog = r.cmd_pro_siglog;
}); } catch(e8) {}

function _proRecordSignal(predDir, score, patName, actualColor) {
  // actualColor = 'G' o 'R' — se rellena al cerrar vela
  _proSignalLog.push({ d: predDir?'G':'R', s: score, p: patName, a: actualColor||null, ts: Date.now() });
  if (_proSignalLog.length > 10) _proSignalLog.shift();
  try { chrome.storage.local.set({cmd_pro_siglog: _proSignalLog}); } catch(e8) {}
}

// Hook en closeCandle para marcar resultado de señal PRO
var _lastProPred = null;

// ── _drawPro: actualiza DOM del panel PRO ─────────────────────
function _drawPro(isG, forceBase, upTicks, dnTicks, predDir, pct, conf, gap,
                  semaforo, semaCol, semaBg, semaMsg, rem, noContra) {
  var c = _fCandle;
  if (!c) return;

  // PRO-A — patrón vela actual
  var pat = _detectPattern(c);

  // PRO-B — multi-vela
  var recentCandles = _fClosedCandles.slice(-2);
  // Añadir vela actual como objeto compatible
  recentCandles.push({ isG:isG, str:forceBase, color:isG?'G':'R' });
  var multiPat = _detectMultiPattern(recentCandles);

  // Sesión y factores de avanzado (replicar para PRO)
  var sess     = _getSession(Date.now()/1000);
  var sf       = _sessionFactor(sess.name);
  var forceAdj = parseFloat(Math.min(10, forceBase * sf).toFixed(1));
  var streak   = _calcStreak();
  var accel    = _calcAccel(c);
  var spr      = c.realSpreadCount > 0 ? (c.realSpreadSum / c.realSpreadCount) / (_avgSpread(_activeAsset)||1) : 1;
  var divR     = _calcDivergence(isG, upTicks, dnTicks);
  var wr       = _getWinRate(_activeAsset);

  // PRO-C — score combinado
  var score = _calcProScore(forceAdj, sf, streak, accel, gap, pat, wr, noContra, !divR.div);

  // PRO-D — riesgo
  var risk = _calcRisk(score, gap, spr, accel, sess.name);

  // Semáforo PRO — más exigente que avanzado
  var goodConf  = gap >= 10;
  var goodTime  = rem <= 4 && rem > 0;
  var goodScore = score >= 55;
  var pS, pSCol, pSBg, pSMsg;
  if (goodConf && goodScore && goodTime && noContra && !divR.div) {
    pS='🟢'; pSCol='#00ff88'; pSBg='rgba(0,60,25,.9)'; pSMsg='¡ENTRAR AHORA!';
  } else if (goodConf && goodScore && !goodTime && noContra) {
    pS='🟡'; pSCol='#ffc400'; pSBg='rgba(40,30,0,.8)'; pSMsg='ESPERAR '+(Math.ceil(rem-4)||'')+'s';
  } else if (divR.div) {
    pS='🟠'; pSCol='#ff9900'; pSBg='rgba(50,25,0,.8)'; pSMsg=divR.msg;
  } else if (!goodConf || !noContra) {
    pS='🔴'; pSCol='#ff4444'; pSBg='rgba(50,0,10,.8)';
    pSMsg = !goodConf ? 'SEÑAL DÉBIL' : 'CONTRADICCIÓN';
  } else {
    pS='🟡'; pSCol='#ffc400'; pSBg='rgba(40,30,0,.8)';
    pSMsg = !goodScore ? 'SCORE BAJO' : 'ESPERAR';
  }

  // ── Guardar señal PRO si hay confianza suficiente ─────────────
  if (goodConf && goodScore) _lastProPred = { dir: predDir, score: score, pat: pat.name };

  // ── DOM: score ring ───────────────────────────────────────────
  var el = function(id){ return document.getElementById(id); };
  var arc = el('cmd-pro-arc');
  var scoreNum = el('cmd-pro-score-num');
  if (arc) {
    var circ = 138.2;
    var offset = circ - (score / 100) * circ;
    arc.setAttribute('stroke-dashoffset', offset.toFixed(1));
    var scoreColor = score >= 70 ? '#00e676' : score >= 50 ? '#ffc400' : '#ff4444';
    arc.setAttribute('stroke', scoreColor);
    if (scoreNum) { scoreNum.textContent = score; scoreNum.style.color = scoreColor; }
  }

  // ── DOM: señal ────────────────────────────────────────────────
  var pArr = el('cmd-pro-arrow'), pLbl = el('cmd-pro-label'), pSem = el('cmd-pro-sema');
  if (pArr){ pArr.textContent=predDir?'▲':'▼'; pArr.style.color=predDir?'#00e676':'#ff1744'; }
  if (pLbl){ pLbl.textContent=predDir?'COMPRAR':'VENDER'; pLbl.style.color=predDir?'#00e676':'#ff1744'; }
  if (pSem){ pSem.textContent=pS+' '+pSMsg; pSem.style.background=pSBg;
             pSem.style.color=pSCol; pSem.style.border='1px solid '+pSCol+'88'; }

  // ── DOM: patrón + riesgo ──────────────────────────────────────
  var pPat = el('cpro-pat'), pRisk = el('cpro-risk');
  if (pPat) {
    pPat.textContent = pat.emoji + ' ' + pat.name;
    pPat.style.color = pat.bull===true ? '#00e676' : pat.bull===false ? '#ff4444' : '#ffc400';
  }
  if (pRisk) {
    pRisk.textContent = risk.level;
    pRisk.style.color = risk.color;
    pRisk.style.background = risk.bg;
    pRisk.style.padding = '1px 4px';
    pRisk.style.borderRadius = '3px';
  }

  // ── DOM: multi-vela ───────────────────────────────────────────
  var candlesForMulti = _fClosedCandles.slice(-2);
  var multiData = [
    candlesForMulti.length >= 2 ? candlesForMulti[candlesForMulti.length-2] : null,
    candlesForMulti.length >= 1 ? candlesForMulti[candlesForMulti.length-1] : null,
    { isG:isG, str:forceBase, color:isG?'G':'R' }
  ];
  var ids = ['2','1','0'];
  multiData.forEach(function(mc, i) {
    var barEl = el('cpm-bar'+ids[i]);
    var valEl = el('cpm-v'+ids[i]);
    if (!mc) { if(barEl) barEl.style.height='4px'; return; }
    var mcG  = mc.isG !== undefined ? mc.isG : mc.color==='G';
    var mcStr= mc.str || 5;
    var barH = Math.max(4, Math.round((mcStr/10)*18)) + 'px';
    if (barEl) {
      barEl.style.height = barH;
      barEl.style.background = mcG ? '#00e676' : '#ff1744';
    }
    if (valEl) {
      valEl.textContent = (mcG?'▲':'▼') + mcStr.toFixed(1);
      valEl.style.color = mcG ? '#00e676' : '#ff4444';
    }
  });
  var trendArr = el('cpm-trend-arrow'), trendLbl = el('cpm-trend-lbl');
  if (trendArr) { trendArr.textContent = multiPat.emoji; }
  if (trendLbl) {
    trendLbl.textContent = multiPat.name.replace('Continuación','Cont.').substring(0,9);
    trendLbl.style.color = multiPat.bull===true ? '#00e676' : multiPat.bull===false ? '#ff4444' : '#ffc400';
  }

  // ── DOM: historial señales ────────────────────────────────────
  var histRows = el('cmd-pro-hist-rows');
  if (histRows) {
    // Marcar resultado de la señal anterior con la vela que acaba de cerrar
    if (_proSignalLog.length > 0) {
      var last = _proSignalLog[_proSignalLog.length-1];
      // Si no tiene resultado y la vela cerró hace menos de 90s — llenar
      if (last.a === null && _fClosedCandles.length > 0) {
        var lc = _fClosedCandles[_fClosedCandles.length-1];
        last.a = lc.isG ? 'G' : 'R';
        try { chrome.storage.local.set({cmd_pro_siglog: _proSignalLog}); } catch(e8) {}
      }
    }
    var recent = _proSignalLog.slice(-5).reverse();
    if (recent.length === 0) {
      histRows.innerHTML = '<div style="font-family:monospace;font-size:7px;color:rgba(255,255,255,.2);padding:2px 3px;">Sin señales aún — esperando confianza suficiente</div>';
    } else {
      histRows.innerHTML = recent.map(function(sig) {
        var hit = sig.a !== null ? sig.d === sig.a : null;
        var res = hit === null ? '⏳' : hit ? '✅' : '❌';
        var dirTxt = sig.d === 'G' ? '▲ COMPRAR' : '▼ VENDER';
        var dirCol = sig.d === 'G' ? '#00e676' : '#ff4444';
        return '<div class="cph-row">' +
          '<span class="cph-res">' + res + '</span>' +
          '<span class="cph-dir" style="color:' + dirCol + '">' + dirTxt + '</span>' +
          '<span class="cph-score">' + sig.s + 'pts</span>' +
          '<span class="cph-pat">' + (sig.p||'').substring(0,8) + '</span>' +
          '</div>';
      }).join('');
    }
  }

  // Registrar señal si es nueva y hay confianza (debounce por 5s)
  if (goodConf && goodScore && _fCandle) {
    var now = Date.now();
    if (!_drawPro._lastLog || (now - _drawPro._lastLog) > 5000) {
      _drawPro._lastLog = now;
      _proRecordSignal(predDir, score, pat.name, null);
    }
  }
}
_drawPro._lastLog = 0;

// ════════════════════════════════════════════════════════════════
// INSTITUCIONAL — estructuras de datos
// ════════════════════════════════════════════════════════════════

// Acumulador de ticks con timestamp para análisis institucional
var _instTicks    = [];   // { price, ts } — rolling 500 ticks
var _instOBs      = [];   // order blocks detectados
var _instManipLog = [];   // spikes detectados
var _instSessVol  = { Asia:0, 'Overlap A/E':0, Europa:0, 'Overlap E/NY':0, NY:0, Off:0 };
var _instLastManip = null;
var _instLastPrice = null;

// Hook institucional integrado directamente en _forceRawTick
// (eliminado el wrapper para evitar problemas de referencia)

// ── INST-A: Detección de manipulación (spike + reversión) ─────
var _manipPrices = [];
function _instDetectManip(price, now) {
  _manipPrices.push({ p: price, ts: now });
  if (_manipPrices.length > 30) _manipPrices.shift();
  if (_manipPrices.length < 10) return;
  var n   = _manipPrices.length;
  var ref = _manipPrices[n - 10].p;
  var peak = price;
  var peakIdx = n - 1;
  for (var i = n - 9; i < n; i++) {
    if (Math.abs(_manipPrices[i].p - ref) > Math.abs(peak - ref)) {
      peak = _manipPrices[i].p;
      peakIdx = i;
    }
  }
  var move = Math.abs(peak - ref);
  var pctMove = ref > 0 ? move / ref : 0;
  // Spike: movimiento > 0.05% en < 5 ticks, luego reversión > 60%
  if (pctMove > 0.0005 && peakIdx < n - 3) {
    var afterPeak = _manipPrices.slice(peakIdx);
    var reversion = Math.abs(price - peak) / move;
    if (reversion > 0.55) {
      var dir = peak > ref ? 'UP' : 'DOWN';
      if (!_instLastManip || (now - _instLastManip.ts) > 8000) {
        _instLastManip = {
          dir: dir, pct: (pctMove * 100).toFixed(3),
          rev: Math.round(reversion * 100), ts: now,
          price: peak
        };
        _instManipLog.push(_instLastManip);
        if (_instManipLog.length > 5) _instManipLog.shift();
      }
    }
  }
}

// ── INST-B: Order blocks ──────────────────────────────────────
// Un OB es la última vela fuerte (str > 6) antes de un movimiento de 3+ velas
function _updateOrderBlocks() {
  if (_fClosedCandles.length < 4) return;
  var candles = _fClosedCandles;
  var n = candles.length;
  // Buscar vela fuerte seguida de 3 velas del color contrario
  for (var i = n - 4; i >= Math.max(0, n - 12); i--) {
    var c = candles[i];
    if (!c || c.str < 6) continue;
    var oppCount = 0;
    for (var j = i + 1; j < Math.min(i + 4, n); j++) {
      if (candles[j] && candles[j].isG !== c.isG) oppCount++;
    }
    if (oppCount >= 2) {
      // OB detectado
      var existing = _instOBs.find(function(ob){ return ob.idx === i; });
      if (!existing) {
        _instOBs.push({
          idx: i, isG: c.isG, str: c.str,
          age: n - i, // velas de edad
          ts: Date.now()
        });
        if (_instOBs.length > 5) _instOBs.shift();
      }
    }
  }
  // Invalidar OBs muy viejos (> 20 velas)
  _instOBs = _instOBs.filter(function(ob){ return (n - ob.idx) <= 20; });
  // Actualizar edad
  _instOBs.forEach(function(ob){ ob.age = n - ob.idx; });
}

// ── INST-C: S/R desde clusters de precio ─────────────────────
function _calcSRLevels(currentPrice) {
  if (_instTicks.length < 30) return [];
  var prices = _instTicks.map(function(t){ return t.price; });
  var mn = Math.min.apply(null, prices);
  var mx = Math.max.apply(null, prices);
  var range = mx - mn || 0.0001;
  // Dividir en 20 buckets y contar densidad
  var buckets = 20;
  var counts = new Array(buckets).fill(0);
  prices.forEach(function(p) {
    var idx = Math.min(buckets - 1, Math.floor((p - mn) / range * buckets));
    counts[idx]++;
  });
  // Encontrar picos locales (densidad > promedio * 1.4)
  var avg = prices.length / buckets;
  var levels = [];
  for (var i = 1; i < buckets - 1; i++) {
    if (counts[i] > avg * 1.4 && counts[i] >= counts[i-1] && counts[i] >= counts[i+1]) {
      var lvlPrice = mn + (i + 0.5) * (range / buckets);
      var strength = Math.min(5, Math.round(counts[i] / avg));
      var type = lvlPrice > currentPrice ? 'R' : 'S';
      levels.push({ price: lvlPrice, strength: strength, type: type, count: counts[i] });
    }
  }
  // Ordenar por proximidad al precio actual
  levels.sort(function(a, b){ return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice); });
  return levels.slice(0, 5);
}

// ── INST-D: Zonas de liquidez ─────────────────────────────────
function _calcLiqZones(currentPrice) {
  if (_instTicks.length < 40) return [];
  var prices = _instTicks.map(function(t){ return t.price; });
  var mn = Math.min.apply(null, prices);
  var mx = Math.max.apply(null, prices);
  var range = mx - mn || 0.0001;
  // 8 zonas más amplias — detectar acumulación
  var zones = 8;
  var counts = new Array(zones).fill(0);
  prices.forEach(function(p) {
    var idx = Math.min(zones - 1, Math.floor((p - mn) / range * zones));
    counts[idx]++;
  });
  var maxCount = Math.max.apply(null, counts);
  var result = [];
  counts.forEach(function(cnt, i) {
    var pct = maxCount > 0 ? cnt / maxCount : 0;
    if (pct > 0.3) {
      var lo = mn + i * (range / zones);
      var hi = lo + (range / zones);
      result.push({ lo: lo, hi: hi, pct: pct, cnt: cnt,
                    type: (lo + hi) / 2 > currentPrice ? 'R' : 'S' });
    }
  });
  return result.sort(function(a,b){ return b.pct - a.pct; }).slice(0, 4);
}

// ── _drawInst: actualizar DOM del panel INSTITUCIONAL ─────────
function _drawInst() {
  var el = function(id){ return document.getElementById(id); };
  var currentPrice = _instLastPrice || (_fCandle ? _fCandle.close : null);
  if (!currentPrice) {
    var alertEl = el('cmd-inst-alert');
    if (alertEl) alertEl.textContent = '🏦 Esperando precios...';
    return;
  }

  _updateOrderBlocks();

  // ── Alerta principal ──────────────────────────────────────────
  var alertEl = el('cmd-inst-alert');
  if (alertEl) {
    var srLevels = _calcSRLevels(currentPrice);
    var nearest  = srLevels[0];
    if (nearest) {
      var dist     = Math.abs(nearest.price - currentPrice);
      var distPct  = (dist / currentPrice * 100).toFixed(3);
      var touching = dist / currentPrice < 0.0005;
      if (touching) {
        alertEl.textContent  = (nearest.type==='R'?'⚠️ TOCANDO RESISTENCIA':'⚠️ TOCANDO SOPORTE');
        alertEl.style.color  = nearest.type==='R' ? '#ff4444' : '#00e676';
        alertEl.style.border = '1px solid ' + (nearest.type==='R' ? '#ff4444' : '#00e676');
        alertEl.style.background = nearest.type==='R' ? 'rgba(50,0,10,.7)' : 'rgba(0,50,20,.7)';
      } else {
        alertEl.textContent  = '🏦 ' + nearest.type + ' más cercano: ' + distPct + '% · ×' + nearest.strength;
        alertEl.style.color  = 'rgba(255,255,255,.7)';
        alertEl.style.border = '1px solid rgba(255,255,255,.1)';
        alertEl.style.background = 'rgba(255,255,255,.04)';
      }
    } else {
      alertEl.textContent = '🏦 Acumulando datos...';
      alertEl.style.color = 'rgba(255,255,255,.35)';
    }
  }

  // ── S/R levels ───────────────────────────────────────────────
  var srRows = el('cinst-sr-rows');
  var priceNow = el('cinst-price-now');
  if (priceNow) priceNow.textContent = currentPrice.toFixed(5);
  if (srRows) {
    var srLevels2 = _calcSRLevels(currentPrice);
    if (!srLevels2.length) {
      srRows.innerHTML = '<div style="font-family:monospace;font-size:7px;color:rgba(255,255,255,.2);padding:2px">Acumulando ticks...</div>';
    } else {
      srRows.innerHTML = srLevels2.map(function(lv) {
        var isR    = lv.type === 'R';
        var dot    = isR ? '#ff4444' : '#00e676';
        var dist   = ((lv.price - currentPrice) / currentPrice * 100).toFixed(3);
        var bars   = '█'.repeat(lv.strength) + '░'.repeat(5 - lv.strength);
        return '<div class="cinst-level" style="background:rgba(255,255,255,.03)">' +
          '<div class="cinst-lvl-dot" style="background:' + dot + '"></div>' +
          '<span class="cinst-lvl-price" style="color:' + dot + '">' + lv.price.toFixed(5) + '</span>' +
          '<span class="cinst-lvl-tag">' + lv.type + ' ' + bars + '</span>' +
          '<span class="cinst-lvl-dist" style="color:' + (parseFloat(dist)>0?'#ff9966':'#66ff99') + '">' + (parseFloat(dist)>0?'+':'') + dist + '%</span>' +
        '</div>';
      }).join('');
    }
  }

  // ── Zonas de liquidez ─────────────────────────────────────────
  var liqRows = el('cinst-liq-rows');
  if (liqRows) {
    var zones = _calcLiqZones(currentPrice);
    if (!zones.length) {
      liqRows.innerHTML = '<div style="font-family:monospace;font-size:7px;color:rgba(255,255,255,.2);padding:2px">Sin zonas aún</div>';
    } else {
      liqRows.innerHTML = zones.map(function(z) {
        var col = z.type==='R' ? 'rgba(255,68,68,' : 'rgba(0,230,118,';
        var pct = Math.round(z.pct * 100);
        return '<div class="cinst-zone" style="background:rgba(255,255,255,.04)">' +
          '<div class="cinst-zone-fill" style="width:' + pct + '%;background:' + col + '0.35)"></div>' +
          '<span class="cinst-zone-lbl">' + z.type + ' · ' + z.lo.toFixed(5) + '–' + z.hi.toFixed(5) + ' · ' + pct + '%</span>' +
        '</div>';
      }).join('');
    }
  }

  // ── Order blocks ──────────────────────────────────────────────
  var obRows = el('cinst-ob-rows');
  if (obRows) {
    if (!_instOBs.length) {
      obRows.innerHTML = '<div style="font-family:monospace;font-size:7px;color:rgba(255,255,255,.2);padding:2px">Sin OBs detectados — necesita velas fuertes seguidas de reversión</div>';
    } else {
      obRows.innerHTML = _instOBs.slice().reverse().map(function(ob) {
        var col  = ob.isG ? '#00e676' : '#ff4444';
        var bord = ob.isG ? '#00e676' : '#ff4444';
        var fresh = ob.age <= 3 ? '🔥' : ob.age <= 7 ? '⚡' : '·';
        return '<div class="cinst-ob" style="border-color:' + bord + '44">' +
          '<span class="cinst-ob-dir" style="color:' + col + '">' + (ob.isG?'▲':'▼') + ' F' + ob.str.toFixed(1) + '</span>' +
          '<span class="cinst-ob-range">hace ' + ob.age + ' velas</span>' +
          '<span class="cinst-ob-age">' + fresh + '</span>' +
        '</div>';
      }).join('');
    }
  }

  // ── Manipulación ──────────────────────────────────────────────
  var manipVal = el('cinst-manip-val');
  if (manipVal) {
    if (_instLastManip) {
      var age = Math.round((Date.now() - _instLastManip.ts) / 1000);
      var manipCol = _instLastManip.dir === 'UP' ? '#ff9900' : '#ff9900';
      manipVal.style.color = manipCol;
      manipVal.innerHTML =
        '<span style="color:#ff9900;font-weight:bold">⚠ SPIKE ' + _instLastManip.dir + '</span>' +
        ' · ' + _instLastManip.pct + '% · rev ' + _instLastManip.rev + '%' +
        '<br><span style="color:rgba(255,255,255,.3);font-size:6px">hace ' + age + 's · precio: ' + _instLastManip.price.toFixed(5) + '</span>';
    } else {
      manipVal.style.color = 'rgba(255,255,255,.3)';
      manipVal.textContent = _instTicks.length < 20 ? 'Acumulando datos...' : '✓ Sin manipulación detectada';
    }
  }

  // ── Sesiones institucionales ──────────────────────────────────
  var sessEl = el('cmd-inst-sessions');
  if (sessEl) {
    var sessNames = ['Asia','Overlap A/E','Europa','Overlap E/NY','NY','Off'];
    var shortNames = ['ASI','OVA','EUR','OVN','NY','OFF'];
    var sessCols  = ['#29b6f6','#ab47bc','#66bb6a','#ffa726','#ef5350','#546e7a'];
    var maxVol = Math.max.apply(null, sessNames.map(function(s){ return _instSessVol[s]||0; })) || 1;
    var currentSess = _getSession(Date.now()/1000);
    sessEl.innerHTML = sessNames.map(function(name, i) {
      var vol  = _instSessVol[name] || 0;
      var pct  = Math.max(4, Math.round(vol / maxVol * 40));
      var isCur = name === currentSess.name;
      return '<div class="cinst-sess-bar" style="' + (isCur?'border:1px solid '+sessCols[i]+'66;border-radius:2px;':'')+'">' +
        '<div class="cinst-sess-vol" style="height:' + pct + 'px;background:' + sessCols[i] + (isCur?';box-shadow:0 0 4px '+sessCols[i]:'') + '"></div>' +
        '<span class="cinst-sess-name" style="color:' + (isCur?sessCols[i]:'rgba(255,255,255,.3)') + '">' + shortNames[i] + '</span>' +
        '<span class="cinst-sess-name">' + (vol>999?Math.round(vol/100)/10+'k':vol) + '</span>' +
      '</div>';
    }).join('');
  }
}



// ════════════════════════════════════════════════════════════════
// OBSERVER — detecta el activo activo en el DOM de PocketOption
// Busca el símbolo seleccionado (ej. "#AAPL_otc", "EURUSD", etc.)
// ════════════════════════════════════════════════════════════════
var _observer = null;
var _lastPredDir = null;

function _readActiveAsset() {
  // Selectores conocidos de PocketOption / po.market
  var selectors = [
    '.symbol-select__name',
    '.chart-toolbar__asset-name',
    '.instrument-name',
    '.asset-name',
    '[class*="asset"] [class*="name"]',
    '[class*="symbol"] [class*="name"]',
    '[class*="instrument"] [class*="label"]',
    '.trading-chart-panel__asset-name',
    '.chart-panel__symbol',
    '.header__asset'
  ];
  for (var si = 0; si < selectors.length; si++) {
    var el = document.querySelector(selectors[si]);
    if (el && el.textContent && el.textContent.trim().length > 1) {
      return el.textContent.trim().replace(/\s+/g, '').toUpperCase();
    }
  }
  // Fallback: buscar en el título de la página
  var title = document.title || '';
  var m = title.match(/([A-Z]{3,}[\/_]?[A-Z]{0,3})/);
  if (m) return m[1].replace('/', '');
  return null;
}

function startObserver() {
  // Si ya hay un observer activo, no duplicar
  if (_observer) return;

  // Leer activo inmediatamente al arrancar
  var initial = _readActiveAsset();
  if (initial && initial !== _activeAsset) {
    _activeAsset = initial;
    log('Activo detectado: ' + _activeAsset);
    _pushState();
    sendMeta({ type: 'payout', value: _payout || 0, asset: _activeAsset });
  }

  // MutationObserver — detecta cambios en el DOM (cambio de activo)
  _observer = new MutationObserver(function() {
    var detected = _readActiveAsset();
    if (detected && detected !== _activeAsset) {
      _activeAsset = detected;
      _candles = {};           // resetear velas al cambiar activo
      _historyInit = false;
      log('Activo cambiado: ' + _activeAsset);
      _pushState();
      sendMeta({ type: 'payout', value: _payout || 0, asset: _activeAsset });
    }
  });

  _observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: false
  });

  // Polling de respaldo cada 3s — por si el observer falla
  var _assetPoll = setInterval(function() {
    if (!_enabled) { clearInterval(_assetPoll); return; }
    var detected = _readActiveAsset();
    if (detected && detected !== _activeAsset) {
      _activeAsset = detected;
      _candles = {};
      _historyInit = false;
      log('Activo (poll): ' + _activeAsset);
      _pushState();
    }
  }, 3000);
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if(msg.type==='enable'){
    _enabled=true;

    try{ chrome.storage.local.set({po_count_enabled:true}); }catch(e){}
    _activeAsset=null; _historyInit=false;
    if(msg.tf) _tf=msg.tf;
    startObserver(); _pushState();
    log('ACTIVADO ['+_tf+'s]');
    sendResponse({ok:true, asset:_activeAsset});
  } else if(msg.type==='disable'){
    _enabled=false;
    _stopClock();
    try{ chrome.storage.local.set({po_count_enabled:false}); }catch(e){}
    if(_observer){_observer.disconnect();_observer=null;}
    _candles={}; _tickTimes={}; _spreadHist={}; _historyInit=false;
    _pushState(); log('DESACTIVADO');
    sendResponse({ok:true});
  } else if(msg.type==='setTf'){
    _tf=msg.tf||60; _candles={};
    log('TF: '+_tf+'s'); sendResponse({ok:true});


  } else if(msg.type==='status'){
    _pushState();
    sendResponse({ok:true, enabled:_enabled, count:_candleCount, asset:_activeAsset,
                  tf:_tf, assets:Object.keys(_allAssets).length,
                  balance:_balance, payout:_payout,
                  openOptions:_openOptions.length, historyInit:_historyInit});
  }
  return true;
});

log('Content v6.0 listo — ISOLATED→MAIN via cmd-update');
// AUTO-ENABLE: respeta el estado guardado en storage
// IMPORTANTE: nada arranca hasta que storage responda
try {
  chrome.storage.local.get(['tf','po_count_enabled'], function(r) {
    if (r.tf) { _tf = r.tf; _candles = {}; log('TF restaurado: '+_tf+'s'); }
    // PO conteo
    var poEnabled = r.po_count_enabled !== undefined ? r.po_count_enabled : true;
    if (poEnabled) {
      _enabled = true;
      startObserver();
      _pushState();
      log('[CMD v6] Auto-enable activo — TF: '+_tf+'s');
    } else {
      _enabled = false;
      log('[CMD v6] PO conteo desactivado por configuración');
    }
  });
} catch(e) {
  // Fallback si storage falla — arrancar normal
  _enabled = true;
  startObserver();
  _pushState();
}

// ── Capturar predicción activa del index via CMD snapshot ─────
// El background inyecta window.__CMD_LATEST con executeScript
// Polling cada 2s para leer la predicción pendiente
setInterval(function() {
  try {
    // Leer __CMD_LATEST del MAIN world via CustomEvent
    document.dispatchEvent(new CustomEvent('cmd-req-pred', {}));
  } catch(e) {}
}, 2000);

// También capturar cuando llega el snapshot del background
document.addEventListener('cmd-bridge-data', function(evt) {
  if (!evt || !evt.detail) return;
  var cmd = evt.detail;
  // Si hay una predicción activa en el snapshot, guardarla
  if (cmd && cmd.pred && cmd.pred.dir) {
    _lastPredDir = cmd.pred.dir;
  }
});

log('Content v6.2 SENTIMIENTO ACTIVO');
console.log('%c CMD·AI v6.2 CARGADO ', 'background:#00e676;color:#000;font-size:14px;font-weight:bold');
// Crear overlay — reintentar hasta que el DOM de PO esté listo
(function _initForce() {
  if (document.body) {
    _ensureForce();
  } else {
    setTimeout(_initForce, 200);
  }
})();
// Segundo intento por si PO reemplaza el DOM al cargar
setTimeout(function() {
  if (!_fEl || !document.getElementById('cmd-force')) {
    _fEl = null; _fCanvas = null; _fCtx = null;
    _ensureForce();
  }
}, 2000);
setTimeout(function() {
  if (!_fEl || !document.getElementById('cmd-force')) {
    _fEl = null; _fCanvas = null; _fCtx = null;
    _ensureForce();
  }
}, 5000);
})();
