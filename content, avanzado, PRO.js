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
  var sioMatch = raw.match(/^(\d+)(\[[\s\S]*)/);
  if (sioMatch) payload = sioMatch[2];

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
      handleObjectMessage(parsed); return;
    }

    if (Array.isArray(parsed)) {
      if (parsed.length > 10 && Array.isArray(parsed[0]) && parsed[0].length >= 3) {
        handleCandleHistory(parsed); return;
      }
      processPriceArray(parsed);
    }
  } catch(e) {}
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
var _fMarkerX    = 0.5; // posición 0-1 del marcador en el historial
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

  var st = document.createElement('style');
  st.textContent = `
    #cmd-force {
      position:fixed; right:0; bottom:0;
      width:160px; height:120px;
      min-width:80px; min-height:50px;
      z-index:2147483647;
      background:rgba(2,2,12,.97);
      border:1px solid rgba(255,255,255,.12);
      border-radius:6px 0 0 0;
      display:flex; flex-direction:column;
      overflow:hidden; transition:height .25s ease;
    }
    #cmd-fhdr {
      display:flex; align-items:center; justify-content:space-between;
      padding:3px 7px; height:20px; flex-shrink:0;
      background:rgba(255,255,255,.05);
      border-bottom:1px solid rgba(255,255,255,.08);
      cursor:move; user-select:none;
    }
    #cmd-ftitle { font-family:monospace; font-size:7px; color:rgba(255,255,255,.3); letter-spacing:.06em; }
    #cmd-fsize  { font-family:monospace; font-size:7px; color:rgba(255,255,255,.15); }
    #cmd-fexpand {
      font-family:monospace; font-size:9px; color:#18ffff;
      background:rgba(24,255,255,.12); border:1px solid rgba(24,255,255,.3);
      border-radius:3px; padding:0 5px; cursor:pointer; line-height:14px; flex-shrink:0;
    }
    #cmd-fexpand:hover { background:rgba(24,255,255,.25); }
    /* ── PESTAÑAS ─────────────────────────────────────────────── */
    #cmd-ftabs {
      display:flex; flex-shrink:0; height:18px;
      border-bottom:1px solid rgba(255,255,255,.08);
    }
    .cmd-tab {
      flex:1; font-family:monospace; font-size:7px; font-weight:bold;
      cursor:pointer; border:none; background:transparent;
      color:rgba(255,255,255,.3); letter-spacing:.05em;
    }
    .cmd-tab.active { color:#18ffff; background:rgba(24,255,255,.1); border-bottom:2px solid #18ffff; }
    .cmd-tab:hover  { background:rgba(255,255,255,.06); color:rgba(255,255,255,.7); }
    /* ── PANEL BÁSICO ─────────────────────────────────────────── */
    #cmd-panel-basic { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
    #cmd-panel-basic.hidden { display:none; }
    /* señal DOM — solo en colapsado */
    #cmd-fsignal {
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:4px 6px; flex-shrink:0; gap:2px; min-height:90px;
    }
    #cmd-fsignal.hidden { display:none; }
    #cmd-fsig-arrow { font-size:28px; line-height:1; text-align:center; }
    #cmd-fsig-label { font-family:monospace; font-size:11px; font-weight:bold; text-align:center; }
    #cmd-fsig-pct   { font-family:monospace; font-size:8px; text-align:center; color:rgba(255,255,255,.5); }
    #cmd-fsemaforo  {
      font-family:monospace; font-size:8px; font-weight:bold; text-align:center;
      padding:2px 6px; border-radius:4px; margin-top:2px; width:calc(100% - 12px);
    }
    /* canvas básico — solo en expandido */
    #cmd-fcanvas { display:block; width:100%; flex:1; min-height:0; }
    #cmd-fslider {
      display:flex; align-items:center; gap:4px;
      padding:2px 7px; height:18px; flex-shrink:0;
      border-top:1px solid rgba(255,255,255,.06); background:rgba(0,0,0,.2);
    }
    #cmd-fslider span { font-family:monospace; font-size:7px; color:rgba(255,255,255,.25); white-space:nowrap; }
    #cmd-fslider input { flex:1; accent-color:#18ffff; height:2px; cursor:pointer; }
    #cmd-fslider-val { font-family:monospace; font-size:7px; color:#18ffff; min-width:18px; text-align:right; }
    /* ── PANEL AVANZADO ───────────────────────────────────────── */
    #cmd-panel-adv { display:none; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
    #cmd-panel-adv.visible { display:flex; }
    /* señal compacta avanzada */
    #cmd-adv-top {
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:3px 5px; flex-shrink:0; gap:1px; min-height:76px;
    }
    #cmd-adv-arrow { font-size:22px; line-height:1; text-align:center; }
    #cmd-adv-label { font-family:monospace; font-size:10px; font-weight:bold; text-align:center; }
    #cmd-adv-pct   { font-family:monospace; font-size:7px; text-align:center; color:rgba(255,255,255,.5); }
    #cmd-adv-sema  {
      font-family:monospace; font-size:7px; font-weight:bold; text-align:center;
      padding:2px 4px; border-radius:3px; width:calc(100% - 10px);
    }
    /* grid de métricas */
    #cmd-adv-grid {
      display:grid; grid-template-columns:1fr 1fr;
      gap:2px; padding:2px 4px; flex-shrink:0;
    }
    .cadv-cell {
      background:rgba(255,255,255,.04); border-radius:3px; padding:2px 3px;
      font-family:monospace;
    }
    .cadv-lbl { font-size:6px; color:rgba(255,255,255,.3); display:block; }
    .cadv-val { font-size:8px; color:#18ffff; font-weight:bold; display:block; }
    /* canvas avanzado */
    #cmd-adv-canvas { display:block; width:100%; flex:1; min-height:60px; }
    /* ── PANEL PRO ───────────────────────────────────────────── */
    #cmd-panel-pro { display:none; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
    #cmd-panel-pro.visible { display:flex; }
    /* score ring + señal compacta */
    #cmd-pro-top {
      display:flex; align-items:center; justify-content:space-between;
      padding:5px 7px; flex-shrink:0; gap:4px;
    }
    #cmd-pro-score-wrap {
      position:relative; width:52px; height:52px; flex-shrink:0;
    }
    #cmd-pro-score-svg { position:absolute; top:0; left:0; width:52px; height:52px; }
    #cmd-pro-score-num {
      position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
      font-family:monospace; font-size:13px; font-weight:bold; color:#fff; text-align:center; line-height:1;
    }
    #cmd-pro-score-lbl {
      position:absolute; bottom:2px; left:0; right:0;
      font-family:monospace; font-size:6px; text-align:center; color:rgba(255,255,255,.35);
    }
    #cmd-pro-signal {
      flex:1; display:flex; flex-direction:column; align-items:center; gap:1px;
    }
    #cmd-pro-arrow { font-size:20px; line-height:1; text-align:center; }
    #cmd-pro-label { font-family:monospace; font-size:10px; font-weight:bold; text-align:center; }
    #cmd-pro-sema  {
      font-family:monospace; font-size:7px; font-weight:bold; text-align:center;
      padding:2px 5px; border-radius:3px; width:100%;
    }
    /* patrón + riesgo */
    #cmd-pro-meta {
      display:flex; gap:3px; padding:0 5px 4px; flex-shrink:0;
    }
    #cmd-pro-pattern, #cmd-pro-risk {
      flex:1; background:rgba(255,255,255,.04); border-radius:3px; padding:2px 4px;
      font-family:monospace;
    }
    #cmd-pro-pattern .cp-lbl, #cmd-pro-risk .cp-lbl {
      font-size:6px; color:rgba(255,255,255,.3); display:block;
    }
    #cmd-pro-pattern .cp-val, #cmd-pro-risk .cp-val {
      font-size:8px; font-weight:bold; display:block;
    }
    /* multi-vela */
    #cmd-pro-multi {
      display:flex; gap:2px; padding:0 5px 4px; flex-shrink:0; align-items:flex-end;
    }
    .cpm-cell {
      flex:1; background:rgba(255,255,255,.04); border-radius:3px; padding:2px 3px;
      font-family:monospace; text-align:center;
    }
    .cpm-bar-wrap { height:20px; display:flex; align-items:flex-end; justify-content:center; margin-bottom:2px; }
    .cpm-bar { width:10px; border-radius:2px 2px 0 0; }
    .cpm-lbl { font-size:6px; color:rgba(255,255,255,.25); display:block; }
    .cpm-val { font-size:7px; font-weight:bold; display:block; }
    /* historial señales */
    #cmd-pro-hist {
      flex-shrink:0; padding:0 5px 3px;
    }
    #cmd-pro-hist-lbl { font-family:monospace; font-size:6px; color:rgba(255,255,255,.25); margin-bottom:2px; }
    #cmd-pro-hist-rows { display:flex; flex-direction:column; gap:1px; }
    .cph-row {
      display:flex; align-items:center; gap:3px;
      font-family:monospace; font-size:7px; padding:1px 3px;
      background:rgba(255,255,255,.03); border-radius:2px;
    }
    .cph-res { font-size:9px; }
    .cph-dir { flex:1; }
    .cph-score { color:rgba(255,255,255,.35); }
    .cph-pat { color:rgba(255,255,255,.25); font-size:6px; }
    /* canvas PRO */
    #cmd-pro-canvas { display:none; width:100%; flex:1; min-height:50px; }
    /* ── RESIZE HANDLES ───────────────────────────────────────── */
    #cmd-fres-l  { position:absolute; left:0; top:10px; bottom:10px; width:5px; cursor:w-resize; z-index:2; }
    #cmd-fres-t  { position:absolute; left:10px; right:10px; top:0; height:5px; cursor:n-resize; z-index:2; }
    #cmd-fres-tl { position:absolute; left:0; top:0; width:10px; height:10px; cursor:nw-resize; z-index:3; }
    #cmd-fres-tr { position:absolute; right:0; top:0; width:10px; height:10px; cursor:ne-resize; z-index:3; }
    #cmd-fres-bl { position:absolute; left:0; bottom:0; width:10px; height:10px; cursor:sw-resize; z-index:3; }
    #cmd-fres-br { position:absolute; right:0; bottom:0; width:10px; height:10px; cursor:se-resize; z-index:3;
                   background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.2) 50%); }
    #cmd-fres-r  { position:absolute; right:0; top:10px; bottom:10px; width:5px; cursor:e-resize; z-index:2; }
    #cmd-fres-b  { position:absolute; left:10px; right:10px; bottom:0; height:5px; cursor:s-resize; z-index:2; }
  `;
  document.head.appendChild(st);

  var d = document.createElement('div');
  d.id = 'cmd-force';
  d.innerHTML =
    /* header */
    '<div id="cmd-fhdr">' +
      '<span id="cmd-ftitle">CMD·AI</span>' +
      '<span id="cmd-fsize"></span>' +
      '<button id="cmd-fexpand" title="Mostrar/ocultar">▼</button>' +
    '</div>' +
    /* pestañas */
    '<div id="cmd-ftabs">' +
      '<button class="cmd-tab active" id="cmd-tab-basic">BÁSICO</button>' +
      '<button class="cmd-tab"        id="cmd-tab-adv"  >AVANZADO</button>' +
      '<button class="cmd-tab"        id="cmd-tab-pro"  >⭐PRO</button>' +
    '</div>' +
    /* ── panel básico ── */
    '<div id="cmd-panel-basic">' +
      /* señal DOM — visible solo en modo colapsado */
      '<div id="cmd-fsignal">' +
        '<div id="cmd-fsig-arrow"></div>' +
        '<div id="cmd-fsig-label"></div>' +
        '<div id="cmd-fsig-pct"></div>' +
        '<div id="cmd-fsemaforo"></div>' +
      '</div>' +
      /* canvas — visible solo en modo expandido */
      '<canvas id="cmd-fcanvas" style="display:none"></canvas>' +
      '<div id="cmd-fslider" style="display:none">' +
        '<span>Ticks</span>' +
        '<input type="range" id="cmd-fbars" min="6" max="40" step="1" value="15">' +
        '<span id="cmd-fslider-val">15</span>' +
      '</div>' +
    '</div>' +
    /* ── panel avanzado ── */
    '<div id="cmd-panel-adv">' +
      /* señal compacta siempre visible */
      '<div id="cmd-adv-top">' +
        '<div id="cmd-adv-arrow"></div>' +
        '<div id="cmd-adv-label"></div>' +
        '<div id="cmd-adv-pct"></div>' +
        '<div id="cmd-adv-sema"></div>' +
      '</div>' +
      /* grid métricas siempre visible */
      '<div id="cmd-adv-grid">' +
        '<div class="cadv-cell"><span class="cadv-lbl">Fuerza×sesión</span><span class="cadv-val" id="cadv-sess">—</span></div>' +
        '<div class="cadv-cell"><span class="cadv-lbl">Streak</span><span class="cadv-val" id="cadv-streak">—</span></div>' +
        '<div class="cadv-cell"><span class="cadv-lbl">Aceleración</span><span class="cadv-val" id="cadv-accel">—</span></div>' +
        '<div class="cadv-cell"><span class="cadv-lbl">Umbral adapt.</span><span class="cadv-val" id="cadv-thresh">—</span></div>' +
        '<div class="cadv-cell"><span class="cadv-lbl">Win rate</span><span class="cadv-val" id="cadv-wr">—</span></div>' +
        '<div class="cadv-cell"><span class="cadv-lbl">Divergencia</span><span class="cadv-val" id="cadv-div">—</span></div>' +
      '</div>' +
      /* canvas avanzado — visible solo en expandido */
      '<canvas id="cmd-adv-canvas" style="display:none"></canvas>' +
    '</div>' +
    /* ── panel PRO ── */
    '<div id="cmd-panel-pro">' +
      /* score ring + señal */
      '<div id="cmd-pro-top">' +
        '<div id="cmd-pro-score-wrap">' +
          '<svg id="cmd-pro-score-svg" viewBox="0 0 52 52"><circle cx="26" cy="26" r="22" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4"/><circle id="cmd-pro-arc" cx="26" cy="26" r="22" fill="none" stroke="#18ffff" stroke-width="4" stroke-linecap="round" stroke-dasharray="138.2" stroke-dashoffset="138.2" transform="rotate(-90 26 26)"/></svg>' +
          '<div id="cmd-pro-score-num">—</div>' +
          '<div id="cmd-pro-score-lbl">SCORE</div>' +
        '</div>' +
        '<div id="cmd-pro-signal">' +
          '<div id="cmd-pro-arrow"></div>' +
          '<div id="cmd-pro-label"></div>' +
          '<div id="cmd-pro-sema"></div>' +
        '</div>' +
      '</div>' +
      /* patrón + riesgo */
      '<div id="cmd-pro-meta">' +
        '<div id="cmd-pro-pattern"><span class="cp-lbl">Patrón</span><span class="cp-val" id="cpro-pat">—</span></div>' +
        '<div id="cmd-pro-risk"><span class="cp-lbl">Riesgo</span><span class="cp-val" id="cpro-risk">—</span></div>' +
      '</div>' +
      /* mini velas multi-vela */
      '<div id="cmd-pro-multi">' +
        '<div class="cpm-cell" id="cpm-c2"><div class="cpm-bar-wrap"><div class="cpm-bar" id="cpm-bar2" style="height:8px;background:rgba(255,255,255,.15)"></div></div><span class="cpm-lbl">−2</span><span class="cpm-val" id="cpm-v2">—</span></div>' +
        '<div class="cpm-cell" id="cpm-c1"><div class="cpm-bar-wrap"><div class="cpm-bar" id="cpm-bar1" style="height:8px;background:rgba(255,255,255,.15)"></div></div><span class="cpm-lbl">−1</span><span class="cpm-val" id="cpm-v1">—</span></div>' +
        '<div class="cpm-cell" id="cpm-c0" style="border:1px solid rgba(24,255,255,.3)"><div class="cpm-bar-wrap"><div class="cpm-bar" id="cpm-bar0" style="height:8px;background:rgba(255,255,255,.15)"></div></div><span class="cpm-lbl">actual</span><span class="cpm-val" id="cpm-v0">—</span></div>' +
        '<div class="cpm-cell" id="cpm-trend" style="background:rgba(24,255,255,.06)"><div style="height:20px;display:flex;align-items:center;justify-content:center;font-size:16px" id="cpm-trend-arrow">?</div><span class="cpm-lbl">patrón</span><span class="cpm-val" id="cpm-trend-lbl">—</span></div>' +
      '</div>' +
      /* historial señales */
      '<div id="cmd-pro-hist">' +
        '<div id="cmd-pro-hist-lbl">ÚLTIMAS SEÑALES</div>' +
        '<div id="cmd-pro-hist-rows"></div>' +
      '</div>' +
      /* canvas PRO expandido */
      '<canvas id="cmd-pro-canvas"></canvas>' +
    '</div>' +
    /* resize handles */
    '<div id="cmd-fres-l"></div><div id="cmd-fres-t"></div>' +
    '<div id="cmd-fres-r"></div><div id="cmd-fres-b"></div>' +
    '<div id="cmd-fres-tl"></div><div id="cmd-fres-tr"></div>' +
    '<div id="cmd-fres-bl"></div><div id="cmd-fres-br"></div>';
  document.body.appendChild(d);

  _fEl     = d;
  _fCanvas = d.querySelector('#cmd-fcanvas');
  _fCtx    = _fCanvas ? _fCanvas.getContext('2d') : null;
  var _advCanvas = d.querySelector('#cmd-adv-canvas');
  console.log('%c CMD·AI OVERLAY CREADO ', 'background:#18ffff;color:#000;font-size:12px');

  // ── LÓGICA DE PESTAÑAS ────────────────────────────────────────
  var _advMode  = false;
  var _proMode  = false;
  var _tabBasic = d.querySelector('#cmd-tab-basic');
  var _tabAdv   = d.querySelector('#cmd-tab-adv');
  var _tabPro   = d.querySelector('#cmd-tab-pro');
  var _panBasic = d.querySelector('#cmd-panel-basic');
  var _panAdv   = d.querySelector('#cmd-panel-adv');
  var _panPro   = d.querySelector('#cmd-panel-pro');

  // Estilo especial para tab PRO
  if (_tabPro) {
    _tabPro.style.color = '#ffd700';
    _tabPro.style.background = 'rgba(255,215,0,.07)';
  }

  function _switchTab(mode) { // 'basic' | 'adv' | 'pro'
    _advMode = mode === 'adv';
    _proMode = mode === 'pro';
    _tabBasic.classList.toggle('active', mode === 'basic');
    _tabAdv.classList.toggle('active',   mode === 'adv');
    if (_tabPro) _tabPro.classList.toggle('active', mode === 'pro');
    _panBasic.classList.toggle('hidden',  mode !== 'basic');
    _panAdv.classList.toggle('visible',   mode === 'adv');
    if (_panPro) _panPro.classList.toggle('visible', mode === 'pro');
    if (mode === 'adv'  && d.offsetWidth < 210) d.style.width = '210px';
    if (mode === 'pro'  && d.offsetWidth < 210) d.style.width = '210px';
    try { chrome.storage.local.set({cmd_tab_mode: mode}); } catch(e2) {}
    if (!_fRaf) { _fRaf = true; requestAnimationFrame(_forceDraw); }
  }

  _tabBasic.addEventListener('click', function(e){ e.stopPropagation(); _switchTab('basic'); });
  _tabAdv.addEventListener('click',   function(e){ e.stopPropagation(); _switchTab('adv');   });
  if (_tabPro) _tabPro.addEventListener('click', function(e){ e.stopPropagation(); _switchTab('pro'); });

  // Restaurar tab guardado
  try { chrome.storage.local.get(['cmd_tab_mode', 'cmd_adv_mode'], function(r) {
    if (r.cmd_tab_mode) _switchTab(r.cmd_tab_mode);
    else if (r.cmd_adv_mode) _switchTab('adv'); // compatibilidad con versión anterior
  }); } catch(e3) {}

  // Exponer al scope externo para que _forceDraw pueda leer _advMode/_proMode y los canvas
  _fEl._advMode    = function(){ return _advMode; };
  _fEl._proMode    = function(){ return _proMode; };
  _fEl._advCanvas  = _advCanvas;
  _fEl._proCanvas  = d.querySelector('#cmd-pro-canvas');

  // Cargar posición y tamaño guardados
  try { chrome.storage.local.get(['fpos','force_collapsed'], function(r) {
    if (r.fpos) {
      if (r.fpos.r != null) d.style.right  = r.fpos.r + 'px';
      if (r.fpos.b != null) d.style.bottom = r.fpos.b + 'px';
      if (r.fpos.w)         d.style.width  = r.fpos.w + 'px';
      // Solo restaurar altura si estaba expandido
      if (r.fpos.h && !_fCollapsed) d.style.height = r.fpos.h + 'px';
    }
    if (r.force_collapsed != null) _fCollapsed = r.force_collapsed;
    _applyCollapsedSize();
  }); } catch(ex) {
    _applyCollapsedSize();
  }

  // ── Botón expandir/colapsar ───────────────────────────────────
  var expandBtn = d.querySelector('#cmd-fexpand');
  if (expandBtn) {
    expandBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _fCollapsed = !_fCollapsed;
      try { chrome.storage.local.set({force_collapsed: _fCollapsed}); } catch(ex2) {}
      _applyCollapsedSize();
    });
  }

  function _savePos() {
    try { chrome.storage.local.set({fpos:{
      r: parseInt(d.style.right)  || 0,
      b: parseInt(d.style.bottom) || 0,
      w: d.offsetWidth,
      h: _fCollapsed ? 380 : d.offsetHeight  // guardar altura expandida
    }}); } catch(ex) {}
    var sz = d.querySelector('#cmd-fsize');
    if (sz) sz.textContent = d.offsetWidth + '×' + d.offsetHeight;
  }

  // ── DRAG (mover arriba/abajo y lateral) ──────────────────────
  var hdr = d.querySelector('#cmd-fhdr');
  var _drag = false, _dsx = 0, _dsy = 0, _dsr = 0, _dsb = 0;
  hdr.addEventListener('mousedown', function(e) {
    if (e.target.tagName === 'BUTTON') return;
    _drag = true;
    _dsx  = e.clientX;
    _dsy  = e.clientY;
    _dsr  = parseInt(d.style.right)  || 0;
    _dsb  = parseInt(d.style.bottom) || 0;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!_drag) return;
    var dx = e.clientX - _dsx;
    var dy = e.clientY - _dsy;
    var nr = Math.max(0, _dsr - dx);
    var nb = Math.max(0, _dsb - dy);
    d.style.right  = nr + 'px';
    d.style.bottom = nb + 'px';
  });
  document.addEventListener('mouseup', function() {
    if (!_drag) return;
    _drag = false;
    _savePos();
  });

  // ── RESIZE desde el borde izquierdo ──────────────────────────
  var resL = d.querySelector('#cmd-fres-l');
  var _resL = false, _rLsx = 0, _rLsw = 0;
  resL.addEventListener('mousedown', function(e) {
    _resL = true; _rLsx = e.clientX; _rLsw = d.offsetWidth;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if (!_resL) return;
    var nw = Math.max(80, _rLsw + (_rLsx - e.clientX));
    d.style.width = nw + 'px';
  });
  document.addEventListener('mouseup', function() {
    if (!_resL) return; _resL = false; _savePos();
  });

  // ── RESIZE desde el borde superior ───────────────────────────
  var resT = d.querySelector('#cmd-fres-t');
  var _resT = false, _rTsy = 0, _rTsh = 0;
  resT.addEventListener('mousedown', function(e) {
    _resT = true; _rTsy = e.clientY; _rTsh = d.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if (!_resT) return;
    var nh = Math.max(200, _rTsh + (_rTsy - e.clientY));
    d.style.height = nh + 'px';
  });
  document.addEventListener('mouseup', function() {
    if (!_resT) return; _resT = false; _savePos();
  });

  // ── RESIZE esquina superior izquierda (ancho + alto) ─────────
  var resTL = d.querySelector('#cmd-fres-tl');
  var _rTL = false, _rTLsx = 0, _rTLsy = 0, _rTLsw = 0, _rTLsh = 0;
  resTL.addEventListener('mousedown', function(e) {
    _rTL = true; _rTLsx = e.clientX; _rTLsy = e.clientY;
    _rTLsw = d.offsetWidth; _rTLsh = d.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if (!_rTL) return;
    var nw = Math.max(80,  _rTLsw + (_rTLsx - e.clientX));
    var nh = Math.max(200, _rTLsh + (_rTLsy - e.clientY));
    d.style.width = nw + 'px'; d.style.height = nh + 'px';
  });
  document.addEventListener('mouseup', function() {
    if (!_rTL) return; _rTL = false; _savePos();
  });

  // Umbral — arrastrar dentro del canvas
  var TOP_OFF = 20, BOT_OFF = 20;
  function _yToThresh(clientY) {
    var rect = _fCanvas.getBoundingClientRect();
    var relY = clientY - rect.top;
    var bH   = rect.height - TOP_OFF - BOT_OFF;
    return 1 - Math.max(0, Math.min(1, (relY - TOP_OFF) / bH));
  }
  // Canvas interaction — bottom 40% = marker drag, top 60% = threshold drag
  function _canvasRelX(clientX) {
    var rect = _fCanvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }
  function _isMarkerZone(clientY) {
    var rect = _fCanvas.getBoundingClientRect();
    return clientY > rect.top + rect.height * 0.62;
  }
  _fCanvas.style.cursor = 'crosshair';
  _fCanvas.addEventListener('mousedown', function(e) {
    if (_isMarkerZone(e.clientY)) {
      // Drag marcador horizontal
      _fDragMarker = true;
      _fMarkerX = _canvasRelX(e.clientX);
    } else {
      // Drag umbral vertical
      _fDragging = true;
      _fThreshold = _yToThresh(e.clientY);
    }
    if (!_fRaf) { _fRaf=true; requestAnimationFrame(_forceDraw); }
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (_fDragMarker) {
      _fMarkerX = _canvasRelX(e.clientX);
      if (!_fRaf) { _fRaf=true; requestAnimationFrame(_forceDraw); }
    }
    if (_fDragging) {
      _fThreshold = _yToThresh(e.clientY);
      if (!_fRaf) { _fRaf=true; requestAnimationFrame(_forceDraw); }
    }
  });
  document.addEventListener('mouseup', function() {
    if (_fDragMarker) {
      _fDragMarker = false;
      try { chrome.storage.local.set({force_marker:_fMarkerX}); } catch(ex) {}
    }
    if (_fDragging) {
      _fDragging = false;
      try { chrome.storage.local.set({force_threshold:_fThreshold}); } catch(ex) {}
    }
  });

  // ── RESIZE borde derecho ─────────────────────────────────────
  var resR = d.querySelector('#cmd-fres-r');
  var _resR = false, _rRsx = 0, _rRsw = 0, _rRsr = 0;
  resR.addEventListener('mousedown', function(e) {
    _resR=true; _rRsx=e.clientX; _rRsw=d.offsetWidth; _rRsr=parseInt(d.style.right)||0;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if(!_resR) return;
    var diff = e.clientX - _rRsx; // moving right = smaller (anchored right)
    var nw = Math.max(80, _rRsw - diff);
    var nr = Math.max(0, _rRsr + diff);
    d.style.width = nw+'px'; d.style.right = nr+'px';
  });
  document.addEventListener('mouseup', function() { if(!_resR) return; _resR=false; _savePos(); });

  // ── RESIZE borde inferior ─────────────────────────────────────
  var resB = d.querySelector('#cmd-fres-b');
  var _resB = false, _rBsy = 0, _rBsh = 0, _rBsb = 0;
  resB.addEventListener('mousedown', function(e) {
    _resB=true; _rBsy=e.clientY; _rBsh=d.offsetHeight; _rBsb=parseInt(d.style.bottom)||0;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if(!_resB) return;
    var diff = e.clientY - _rBsy;
    var nh = Math.max(200, _rBsh - diff);
    var nb = Math.max(0, _rBsb + diff);
    d.style.height = nh+'px'; d.style.bottom = nb+'px';
  });
  document.addEventListener('mouseup', function() { if(!_resB) return; _resB=false; _savePos(); });

  // ── RESIZE esquina inferior derecha ──────────────────────────
  var resBR = d.querySelector('#cmd-fres-br');
  var _rBR=false, _rBRsx=0, _rBRsy=0, _rBRsw=0, _rBRsh=0, _rBRsr=0, _rBRsb=0;
  resBR.addEventListener('mousedown', function(e) {
    _rBR=true; _rBRsx=e.clientX; _rBRsy=e.clientY;
    _rBRsw=d.offsetWidth; _rBRsh=d.offsetHeight;
    _rBRsr=parseInt(d.style.right)||0; _rBRsb=parseInt(d.style.bottom)||0;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if(!_rBR) return;
    var dx=e.clientX-_rBRsx, dy=e.clientY-_rBRsy;
    d.style.width  = Math.max(80,  _rBRsw - dx) + 'px';
    d.style.height = Math.max(200, _rBRsh - dy) + 'px';
    d.style.right  = Math.max(0, _rBRsr + dx) + 'px';
    d.style.bottom = Math.max(0, _rBRsb + dy) + 'px';
  });
  document.addEventListener('mouseup', function() { if(!_rBR) return; _rBR=false; _savePos(); });

  // ── RESIZE esquina inferior izquierda ─────────────────────────
  var resBL = d.querySelector('#cmd-fres-bl');
  var _rBL=false, _rBLsx=0, _rBLsy=0, _rBLsw=0, _rBLsh=0, _rBLsb=0;
  resBL.addEventListener('mousedown', function(e) {
    _rBL=true; _rBLsx=e.clientX; _rBLsy=e.clientY;
    _rBLsw=d.offsetWidth; _rBLsh=d.offsetHeight; _rBLsb=parseInt(d.style.bottom)||0;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if(!_rBL) return;
    var dx=e.clientX-_rBLsx, dy=e.clientY-_rBLsy;
    d.style.width  = Math.max(80,  _rBLsw + dx) + 'px';
    d.style.height = Math.max(200, _rBLsh - dy) + 'px';
    d.style.bottom = Math.max(0, _rBLsb + dy) + 'px';
  });
  document.addEventListener('mouseup', function() { if(!_rBL) return; _rBL=false; _savePos(); });

  // ── RESIZE esquina superior derecha ──────────────────────────
  var resTR = d.querySelector('#cmd-fres-tr');
  var _rTR=false, _rTRsx=0, _rTRsy=0, _rTRsw=0, _rTRsh=0, _rTRsr=0;
  resTR.addEventListener('mousedown', function(e) {
    _rTR=true; _rTRsx=e.clientX; _rTRsy=e.clientY;
    _rTRsw=d.offsetWidth; _rTRsh=d.offsetHeight; _rTRsr=parseInt(d.style.right)||0;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', function(e) {
    if(!_rTR) return;
    var dx=e.clientX-_rTRsx, dy=e.clientY-_rTRsy;
    d.style.width  = Math.max(80,  _rTRsw - dx) + 'px';
    d.style.height = Math.max(200, _rTRsh - dy) + 'px';
    d.style.right  = Math.max(0, _rTRsr + dx) + 'px';
  });
  document.addEventListener('mouseup', function() { if(!_rTR) return; _rTR=false; _savePos(); });

  // ── SLIDER de ticks visibles ──────────────────────────────────
  var slEl  = d.querySelector('#cmd-fbars');
  var slVal = d.querySelector('#cmd-fslider-val');
  if (slEl) {
    slEl.value = _fBars;
    if (slVal) slVal.textContent = _fBars;
    slEl.addEventListener('input', function() {
      _fBars = parseInt(this.value) || 15;
      if (slVal) slVal.textContent = _fBars;
      try { chrome.storage.local.set({force_bars:_fBars}); } catch(ex) {}
      if (!_fRaf) { _fRaf=true; requestAnimationFrame(_forceDraw); }
    });
  }

  _savePos();

  // Dibujar inmediatamente el estado inicial
  setTimeout(function() {
    if (!_fRaf) { _fRaf = true; requestAnimationFrame(_forceDraw); }
  }, 100);
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

// Watchdog — si rAF se congela, forzar redibujado
setInterval(function() {
  if (_fRaf) {
    _fRaf = false; // desbloquear
  }
  // Redibujar siempre que haya datos, aunque no lleguen ticks nuevos
  if (_fCanvas && _fCandle && !_fRaf) {
    _fRaf = true;
    requestAnimationFrame(_forceDraw);
  }
}, 1000);

function _forceDraw() {
  _fRaf = false;
  var cv = _fCanvas;

  // Siempre calcular datos para actualizar panel DOM
  var prices = _fPrices;
  var n      = prices.length;
  var c      = _fCandle;

  // Si no hay datos suficientes — limpiar panel y salir si canvas oculto
  if (n < 2 || !c) {
    var sigArrow0 = document.getElementById('cmd-fsig-arrow');
    var sigLabel0 = document.getElementById('cmd-fsig-label');
    if (sigArrow0) { sigArrow0.textContent = '—'; sigArrow0.style.color = 'rgba(255,255,255,.3)'; }
    if (sigLabel0) { sigLabel0.textContent = 'Esperando...'; sigLabel0.style.color = 'rgba(255,255,255,.3)'; }
    if (_fCollapsed || !cv || !_fCtx) return;
  }

  // Si canvas no disponible y colapsado, solo actualizamos DOM (que se hace más abajo)
  var canDraw = cv && _fCtx && !_fCollapsed;

  // Tamaño real del canvas — usar el contenedor padre
  var parent = _fEl;
  var W = (parent ? parent.offsetWidth  : 160) || 160;
  var H = (parent ? parent.offsetHeight : 380) - 20 || 360; // -20 por el header
  W = Math.max(80, W);
  H = Math.max(150, H);
  if (canDraw) {
    cv.width  = W;
    cv.height = H;
  }

  var ctx = canDraw ? _fCtx : null;

  if (ctx) { ctx.clearRect(0, 0, W, H); }

  // Fondo
  if (ctx) {
    ctx.fillStyle = 'rgba(2,2,12,.95)';
    ctx.fillRect(0, 0, W, H);
  }

  // Indicador de datos congelados
  if (_fStale) {
    if (ctx) {
      ctx.fillStyle = 'rgba(255,196,0,.15)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,196,0,.9)';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SIN DATOS', W/2, H/2 - 6);
      ctx.fillText('⏸', W/2, H/2 + 10);
      ctx.textAlign = 'left';
    }
    return;
  }

  if (n < 2 || !c) {
    if (ctx) {
      // Mensaje de espera visible
      ctx.fillStyle = 'rgba(24,255,255,.5)';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Esperando', W/2, H/2 - 12);
      ctx.fillText('precios...', W/2, H/2 + 2);
      ctx.fillStyle = 'rgba(255,255,255,.2)';
      ctx.font = '8px monospace';
      ctx.fillText('Activa el bridge', W/2, H/2 + 18);
      ctx.textAlign = 'left';
    }
    return;
  }

  // ── Calcular deltas ────────────────────────────────────────────
  var deltas = [];
  for (var i = 1; i < n; i++) deltas.push(prices[i] - prices[i-1]);
  var maxD  = Math.max.apply(null, deltas.map(Math.abs)) || 0.00001;
  var last5 = deltas.slice(-5);
  var sumD  = last5.reduce(function(s,v){return s+v;},0);
  var prev5 = deltas.slice(-10,-5);
  var sumP  = prev5.length ? prev5.reduce(function(s,v){return s+v;},0) : 0;
  var pressure = Math.max(-1, Math.min(1, sumD / (maxD * 3)));

  // Vela actual
  var isG    = c.close >= c.open;
  var body   = Math.abs(c.close - c.open);
  var range  = c.high - c.low || body || 0.00001;
  var br     = body / range;
  var elapsed= Math.max(0.1, (Date.now() - c.firstTs) / 1000);
  var f1     = br * 3.5;
  var f2     = Math.min(1.25, (c.ticks / (_tf * 0.8)) * 1.25);
  var force  = Math.min(10, f1 + f2);  // 0-10
  var forceN = force / 10;             // 0-1 normalizado

  // Fuerza del tick anterior (últimos 5 ticks atrás)
  var prevForce = 0;
  if (deltas.length >= 6) {
    var prevD = deltas.slice(-6,-1);
    var prevMaxD = Math.max.apply(null, prevD.map(Math.abs)) || 0.00001;
    prevForce = Math.min(1, Math.abs(prevD.reduce(function(s,v){return s+v;},0)) / (prevMaxD * 3));
  }

  // ── Layout vertical ───────────────────────────────────────────
  var PAD    = 6;
  var BAR_X  = 14;
  var BAR_W  = W - 28;
  var TOP    = 142;
  var BOT    = 130;
  var BAR_H  = H - TOP - BOT;

  // ── PREDICCIÓN SIGUIENTE VELA — calculada de ticks reales ─────
  var _upTicks = 0, _dnTicks = 0;
  for (var _ti = 1; _ti < prices.length; _ti++) {
    if (prices[_ti] > prices[_ti-1]) _upTicks++;
    else if (prices[_ti] < prices[_ti-1]) _dnTicks++;
  }
  var _total  = _upTicks + _dnTicks || 1;
  var _bPct   = Math.round(_upTicks / _total * 100);
  var _rPct   = 100 - _bPct;
  var _domUp  = _upTicks >= _dnTicks;
  var _gap    = Math.abs(_bPct - _rPct);

  // Confirmar con vela anterior
  var _prevConf = 0;
  if (_fClosedCandles.length >= 1) {
    var _lc = _fClosedCandles[_fClosedCandles.length-1];
    _prevConf = _lc.isG === _domUp ? (_domUp?1:-1) : (_domUp?-1:1);
  }

  var _conf    = _gap >= 20 ? 'ALTA' : _gap >= 10 ? 'MEDIA' : 'BAJA';
  var _predDir = _domUp;
  var _pct     = _predDir ? _bPct : _rPct;

  // ── SEMÁFORO — cuándo entrar ──────────────────────────────────
  // Condiciones:
  // 🟢 ENTRAR: confianza >= MEDIA + fuerza supera umbral + ≤4s restantes + no contradice
  // 🟡 ESPERAR: confianza MEDIA/ALTA pero aún no es el momento (>4s) o fuerza baja
  // 🔴 NO ENTRAR: confianza BAJA o contradice vela anterior
  var _prog    = Math.min(1, elapsed / _tf);
  var _rem     = Math.max(0, _tf - elapsed);
  var _semaforo, _semaCol, _semaBg, _semaMsg;

  var aboveThresh = forceN >= _fThreshold; // precalcular para semáforo y canvas

  var _goodConf  = _gap >= 10;                    // MEDIA o ALTA
  var _goodForce = aboveThresh;                    // supera umbral
  var _goodTime  = _rem <= 4 && _rem > 0;         // últimos 4s de la vela
  var _noContra  = _prevConf !== (_predDir?-1:1); // no contradice

  if (_goodConf && _goodForce && _goodTime && _noContra) {
    _semaforo = '🟢';
    _semaCol  = '#00ff88';
    _semaBg   = 'rgba(0,60,25,.9)';
    _semaMsg  = '¡ENTRAR AHORA!';
  } else if (_goodConf && _goodForce && !_goodTime && _noContra) {
    _semaforo = '🟡';
    _semaCol  = '#ffc400';
    _semaBg   = 'rgba(40,30,0,.8)';
    _semaMsg  = 'ESPERAR ' + Math.ceil(_rem - 4) + 's más';
  } else if (!_goodConf || !_noContra) {
    _semaforo = '🔴';
    _semaCol  = '#ff4444';
    _semaBg   = 'rgba(50,0,10,.8)';
    _semaMsg  = !_goodConf ? 'SEÑAL DÉBIL' : 'CONTRADICCIÓN';
  } else {
    _semaforo = '🟡';
    _semaCol  = '#ffc400';
    _semaBg   = 'rgba(40,30,0,.8)';
    _semaMsg  = !_goodForce ? 'FUERZA BAJA' : 'ESPERAR';
  }

  // ── Actualizar panel de señal DOM (siempre visible) ────────────
  (function() {
    var sigArrow = document.getElementById('cmd-fsig-arrow');
    var sigLabel = document.getElementById('cmd-fsig-label');
    var sigPct   = document.getElementById('cmd-fsig-pct');
    var sigSema  = document.getElementById('cmd-fsemaforo');
    if (sigArrow) { sigArrow.textContent = _predDir ? '▲' : '▼';
                    sigArrow.style.color  = _predDir ? '#00e676' : '#ff1744'; }
    if (sigLabel) { sigLabel.textContent = _predDir ? 'COMPRAR' : 'VENDER';
                    sigLabel.style.color  = _predDir ? '#00e676' : '#ff1744'; }
    if (sigPct)   { sigPct.textContent   = _pct + '% · ' + _conf;
                    sigPct.style.color    = _gap >= 20 ? _semaCol : _gap >= 10 ? '#ffc400' : 'rgba(255,255,255,.35)'; }
    if (sigSema)  { sigSema.textContent  = _semaforo + ' ' + _semaMsg;
                    sigSema.style.background = _semaBg;
                    sigSema.style.color      = _semaCol;
                    sigSema.style.border     = '1px solid ' + _semaCol + '88'; }
  })();

  // Panel avanzado — actualizar DOM siempre, antes del return por canvas colapsado
  if (_fEl && _fEl._advMode && _fEl._advMode()) {
    _drawAdvanced(isG, force, _upTicks, _dnTicks, _predDir, _pct, _conf, _gap,
      _semaforo, _semaCol, _semaBg, _semaMsg, _rem, _noContra);
  }
  if (_fEl && _fEl._proMode && _fEl._proMode()) {
    _drawPro(isG, force, _upTicks, _dnTicks, _predDir, _pct, _conf, _gap,
      _semaforo, _semaCol, _semaBg, _semaMsg, _rem, _noContra);
  }

  // Si está colapsado, no dibujar canvas
  if (!ctx) return;

  // ── DISPLAY ───────────────────────────────────────────────────
  // Fondo predicción
  ctx.fillStyle = _predDir ? 'rgba(0,35,15,.7)' : 'rgba(35,0,8,.7)';
  ctx.fillRect(0, 0, W, TOP - 2);

  // Flecha grande
  ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = _predDir ? '#00e676' : '#ff1744';
  ctx.fillText(_predDir ? '▲' : '▼', W/2, 33);

  // COMPRAR / VENDER
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = _predDir ? '#00e676' : '#ff1744';
  ctx.fillText(_predDir ? 'COMPRAR' : 'VENDER', W/2, 48);

  // Porcentaje + confianza
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = _gap >= 20 ? _semaCol : _gap >= 10 ? '#ffc400' : 'rgba(255,255,255,.3)';
  ctx.fillText(_pct + '% · ' + _conf, W/2, 61);

  // Confirmación anterior
  if (_fClosedCandles.length >= 1) {
    ctx.font = '7px monospace';
    ctx.fillStyle = _prevConf === (_predDir?1:-1) ? 'rgba(0,230,118,.7)'
                  : _prevConf === 0 ? 'rgba(255,255,255,.25)' : 'rgba(255,196,0,.8)';
    ctx.fillText(_prevConf===(_predDir?1:-1) ? '✓ anterior confirma'
               : _prevConf===0 ? '· neutral' : '⚠ anterior contradice', W/2, 73);
  }

  // ── SEMÁFORO ──────────────────────────────────────────────────
  // Fondo semáforo
  ctx.fillStyle = _semaBg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(4, 78, W-8, 30, 6) : ctx.rect(4, 78, W-8, 30);
  ctx.fill();
  ctx.strokeStyle = _semaCol; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(4, 78, W-8, 30, 6) : ctx.rect(4, 78, W-8, 30);
  ctx.stroke();

  // Emoji + mensaje
  ctx.font = '13px monospace'; ctx.textAlign = 'center';
  ctx.fillText(_semaforo, 18, 98);
  ctx.font = 'bold 9px monospace'; ctx.fillStyle = _semaCol;
  ctx.fillText(_semaMsg, W/2 + 6, 98);

  // Cuenta regresiva si hay tiempo
  if (_goodConf && _goodForce && _noContra && _rem > 0) {
    ctx.font = '7px monospace'; ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText(_rem.toFixed(0) + 's restantes', W/2, 113);
  }

  // Separador
  ctx.strokeStyle = _semaCol + '55'; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(0, TOP-2); ctx.lineTo(W, TOP-2); ctx.stroke();

  // Fuerza actual
  ctx.font = '7px monospace'; ctx.fillStyle = force>=7?'#00e676':force>=5?'#ffc400':'#ff5252';
  ctx.fillText('F'+force.toFixed(1)+' · '+_upTicks+'↑ '+_dnTicks+'↓', W/2, TOP+10);

  // ── Barra vertical de fuerza ──────────────────────────────────
  // Fondo
  ctx.fillStyle = 'rgba(255,255,255,.06)';
  ctx.fillRect(BAR_X, TOP, BAR_W, BAR_H);

  // Relleno — crece desde abajo hacia arriba
  var fillH   = Math.round(forceN * BAR_H);
  var fillY   = TOP + BAR_H - fillH;
  var grad    = ctx.createLinearGradient(0, fillY + fillH, 0, fillY);
  if (isG) {
    grad.addColorStop(0, 'rgba(0,160,70,.5)');
    grad.addColorStop(0.6, 'rgba(0,210,90,.85)');
    grad.addColorStop(1, 'rgba(0,255,110,1)');
  } else {
    grad.addColorStop(0, 'rgba(160,0,0,.5)');
    grad.addColorStop(0.6, 'rgba(210,0,0,.85)');
    grad.addColorStop(1, 'rgba(255,50,50,1)');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(BAR_X, fillY, BAR_W, fillH);

  // ── Líneas de referencia horizontales ────────────────────────
  // F10 = tope, F7 = fuerte, F5 = medio, F3 = débil
  var refs = [{v:0.7,lbl:'7',col:'rgba(0,255,100,.5)'},{v:0.5,lbl:'5',col:'rgba(255,196,0,.4)'},{v:0.3,lbl:'3',col:'rgba(255,100,100,.35)'}];
  refs.forEach(function(r) {
    var ry = TOP + BAR_H - Math.round(r.v * BAR_H);
    ctx.strokeStyle = r.col; ctx.lineWidth = 1; ctx.setLineDash([3,2]);
    ctx.beginPath(); ctx.moveTo(BAR_X, ry); ctx.lineTo(BAR_X + BAR_W, ry); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = r.col; ctx.font = '7px monospace'; ctx.textAlign = 'right';
    ctx.fillText(r.lbl, BAR_X - 2, ry + 3);
  });
  ctx.textAlign = 'left';

  // ── Marcador fuerza ANTERIOR — línea amarilla ─────────────────
  if (prevForce > 0) {
    var prevY = TOP + BAR_H - Math.round(prevForce * BAR_H);
    ctx.strokeStyle = 'rgba(255,196,0,.8)'; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(BAR_X, prevY); ctx.lineTo(BAR_X + BAR_W, prevY); ctx.stroke();
    // Triángulo lateral derecho
    ctx.fillStyle = 'rgba(255,196,0,.9)';
    ctx.beginPath();
    ctx.moveTo(BAR_X + BAR_W + 1, prevY - 4);
    ctx.lineTo(BAR_X + BAR_W + 1, prevY + 4);
    ctx.lineTo(BAR_X + BAR_W + 6, prevY);
    ctx.fill();
  }

  // ── Marcador fuerza ACTUAL — línea brillante ──────────────────
  var curY = TOP + BAR_H - Math.round(forceN * BAR_H);
  ctx.strokeStyle = isG ? 'rgba(0,255,100,1)' : 'rgba(255,60,60,1)';
  ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(BAR_X, curY); ctx.lineTo(BAR_X + BAR_W, curY); ctx.stroke();
  // Círculo izquierdo
  ctx.beginPath(); ctx.arc(BAR_X, curY, 4, 0, Math.PI * 2);
  ctx.fillStyle = isG ? '#00ff64' : '#ff3232'; ctx.fill();

  // ── Línea de UMBRAL — arrastrable por el usuario ────────────
  var threshY = TOP + BAR_H - Math.round(_fThreshold * BAR_H);
  var threshF = (_fThreshold * 10).toFixed(1);
  aboveThresh = forceN >= _fThreshold; // ya declarada antes del semáforo
  // Fondo de zona activa (por encima del umbral)
  if (aboveThresh && fillH > 0) {
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(BAR_X, fillY, BAR_W, Math.min(fillH, threshY - fillY > 0 ? threshY - fillY : 0));
  }
  // Línea del umbral — blanca brillante, más gruesa
  ctx.strokeStyle = aboveThresh ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.4)';
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(BAR_X - 2, threshY); ctx.lineTo(BAR_X + BAR_W + 2, threshY); ctx.stroke();
  // Triángulo izquierdo — asa de drag
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath();
  ctx.moveTo(BAR_X - 2, threshY - 5);
  ctx.lineTo(BAR_X - 2, threshY + 5);
  ctx.lineTo(BAR_X - 8, threshY);
  ctx.fill();
  // Etiqueta del umbral — fondo para legibilidad
  var lblTxt = 'U' + threshF;
  ctx.font = 'bold 8px monospace';
  var lblW = ctx.measureText(lblTxt).width + 4;
  ctx.fillStyle = aboveThresh ? 'rgba(0,180,80,.9)' : 'rgba(120,120,120,.7)';
  ctx.fillRect(BAR_X + BAR_W - lblW - 1, threshY - 9, lblW + 2, 11);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'right';
  ctx.fillText(lblTxt, BAR_X + BAR_W, threshY - 1);
  ctx.textAlign = 'left';
  // Indicador ✓ o ✗ si supera el umbral
  ctx.font      = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = aboveThresh ? '#00e676' : 'rgba(255,255,255,.2)';
  ctx.fillText(aboveThresh ? '✓' : '✗', W/2, threshY - 12);
  ctx.textAlign = 'left';

  // ── Flecha de tendencia vs anterior ──────────────────────────
  var diff = forceN - prevForce;
  var arrowTxt = Math.abs(diff) > 0.05 ? (diff > 0 ? '↑' : '↓') : '→';
  ctx.font      = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = diff > 0.05 ? '#00e676' : diff < -0.05 ? '#ff4444' : 'rgba(255,255,255,.4)';
  ctx.fillText(arrowTxt, W/2, H - 30);

  // ── Progreso vela y tiempo restante ──────────────────────────
  var prog = Math.min(1, elapsed / _tf);
  var rem  = Math.max(0, Math.round(_tf - elapsed));
  // Barra progreso horizontal
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  ctx.fillRect(BAR_X, H - 18, BAR_W, 4);
  ctx.fillStyle = isG ? 'rgba(0,200,83,.7)' : 'rgba(213,0,0,.7)';
  ctx.fillRect(BAR_X, H - 18, Math.round(prog * BAR_W), 4);
  // Tiempo
  ctx.font      = '8px monospace';
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.textAlign = 'center';
  ctx.fillText(rem + 's', W/2, H - 6);
  ctx.textAlign = 'left';

  // ── HISTORIAL DE TICKS — barras grandes con fuerza clara ────────
  // Zona inferior — altura generosa para distinguir claramente
  var HIST_H   = Math.min(120, Math.floor(H * 0.35));
  var HIST_BOT = H - 6;
  var HIST_TOP = HIST_BOT - HIST_H;
  var histN    = Math.min(_fBars, n);  // controlado por slider
  var histBW   = Math.max(4, Math.floor(BAR_W / histN) - 1);
  var histGap  = Math.max(1, Math.floor((BAR_W - histBW * histN) / Math.max(histN - 1, 1)));

  // Fuerza de cada tick = magnitud del movimiento de precio
  var histF = [];
  for (var hfi = n - histN; hfi < n; hfi++) {
    if (hfi <= 0) { histF.push(0); continue; }
    histF.push(Math.abs(prices[hfi] - prices[hfi-1]));
  }
  var histMax = Math.max.apply(null, histF) || 0.00001;
  var histAvg = histF.reduce(function(s,v){return s+v;},0) / histN;

  // Fondo zona
  ctx.fillStyle = 'rgba(255,255,255,.04)';
  ctx.fillRect(BAR_X, HIST_TOP, BAR_W, HIST_H);

  // Barras — altura muy diferenciada para ver claramente cuál es más fuerte
  for (var hi = 0; hi < histN; hi++) {
    var pidx  = n - histN + hi;
    var hIsUp = pidx > 0 ? prices[pidx] >= prices[pidx-1] : true;
    var hF    = histF[hi] / histMax; // 0-1 relativo al máximo

    // Altura: mínimo 3px, máximo HIST_H-2. Escala cuadrática para exagerar diferencias
    var hBH = Math.max(3, Math.round(Math.pow(hF, 0.6) * (HIST_H - 4)));
    var hBX = BAR_X + hi * (histBW + histGap);
    var hBY = HIST_BOT - hBH;

    // Color: sólido para barras fuertes, semitransparente para débiles
    // Esto hace MUY visible la diferencia de fuerza
    if (hF >= 0.75) {
      // Fuerte — color puro brillante
      ctx.fillStyle = hIsUp ? '#00e676' : '#ff1744';
    } else if (hF >= 0.45) {
      // Media — color moderado
      ctx.fillStyle = hIsUp ? 'rgba(0,200,83,.75)' : 'rgba(255,23,68,.75)';
    } else {
      // Débil — apagado, casi gris
      ctx.fillStyle = hIsUp ? 'rgba(0,150,60,.35)' : 'rgba(200,0,40,.35)';
    }
    ctx.fillRect(hBX, hBY, histBW, hBH);

    // La barra más fuerte tiene borde brillante blanco + número encima
    if (histF[hi] >= histMax * 0.95) {
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hBX, hBY, histBW, hBH);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('↑', hBX + histBW/2, hBY - 2);
    }

    // La barra más débil tiene indicador
    if (histF[hi] <= histMax * 0.15 && histF[hi] > 0) {
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      ctx.fillRect(hBX, HIST_BOT - 2, histBW, 2);
    }
  }

  // Línea de promedio — referencia visual clave
  var hAvgH = Math.max(2, Math.round(Math.pow(histAvg/histMax, 0.6) * (HIST_H - 4)));
  var hAvgY = HIST_BOT - hAvgH;
  ctx.strokeStyle = 'rgba(255,255,255,.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(BAR_X, hAvgY); ctx.lineTo(BAR_X + BAR_W, hAvgY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('avg', BAR_X + 1, hAvgY - 2);

  // Separadores de vela — línea blanca vertical
  if (_fPriceGroups && _fPriceGroups.length > 1) {
    var tickCount = 0;
    for (var gi = 0; gi < _fPriceGroups.length - 1; gi++) {
      tickCount += _fPriceGroups[gi].length;
      var posFromEnd = n - tickCount;
      var histIdx    = histN - posFromEnd;
      if (histIdx > 0 && histIdx < histN) {
        var sx = BAR_X + histIdx * (histBW + histGap) - histGap/2;
        ctx.strokeStyle = 'rgba(255,255,255,.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(sx, HIST_TOP); ctx.lineTo(sx, HIST_BOT); ctx.stroke();
        // Triángulo en la parte superior
        ctx.fillStyle = 'rgba(255,255,255,.7)';
        ctx.beginPath();
        ctx.moveTo(sx - 4, HIST_TOP); ctx.lineTo(sx + 4, HIST_TOP); ctx.lineTo(sx, HIST_TOP + 6);
        ctx.fill();
      }
    }
  }

  // ── COMPARACIÓN VELA ANTERIOR vs ACTUAL ──────────────────────
  // Usar los mismos ticksUp/ticksDown calculados arriba (_upTicks/_dnTicks)
  var ticksUp  = _upTicks;
  var ticksDown= _dnTicks;
  var totalTicks = _total;
  var bullPct  = _bPct;
  var bearPct  = _rPct;
  var dominantUp = _predDir;

  var CMP_H   = 52;
  var CMP_BOT = HIST_TOP - 6;
  var CMP_TOP = CMP_BOT - CMP_H;

  if (CMP_TOP > TOP + BAR_H + 10) {
    ctx.fillStyle = 'rgba(255,255,255,.03)';
    ctx.fillRect(BAR_X, CMP_TOP, BAR_W, CMP_H);

    // ── Barra de presión real: % ticks alcistas vs bajistas ────
    // Esta es la métrica correcta — no la fuerza sino la dirección
    var barZone2 = CMP_H - 22;
    var halfW2   = Math.floor(BAR_W / 2) - 2;

    // Barra COMPRADORA (izquierda)
    var bullH = Math.max(3, Math.round((bullPct / 100) * barZone2));
    ctx.fillStyle = bullPct > 55 ? '#00e676' : bullPct > 45 ? 'rgba(0,200,83,.6)' : 'rgba(0,150,60,.3)';
    ctx.fillRect(BAR_X, CMP_BOT - bullH, halfW2, bullH);
    ctx.fillStyle = bullPct > 50 ? '#00e676' : 'rgba(255,255,255,.3)';
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(bullPct + '%', BAR_X + halfW2/2, CMP_BOT - bullH - 2);
    ctx.font = '7px monospace';
    ctx.fillText('▲', BAR_X + halfW2/2, CMP_BOT + 7);

    // Barra VENDEDORA (derecha)
    var bearH = Math.max(3, Math.round((bearPct / 100) * barZone2));
    var bearX = BAR_X + halfW2 + 4;
    ctx.fillStyle = bearPct > 55 ? '#ff1744' : bearPct > 45 ? 'rgba(213,0,0,.6)' : 'rgba(150,0,30,.3)';
    ctx.fillRect(bearX, CMP_BOT - bearH, halfW2, bearH);
    ctx.fillStyle = bearPct > 50 ? '#ff1744' : 'rgba(255,255,255,.3)';
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(bearPct + '%', bearX + halfW2/2, CMP_BOT - bearH - 2);
    ctx.font = '7px monospace';
    ctx.fillText('▼', bearX + halfW2/2, CMP_BOT + 7);

    // Etiqueta central con veredicto claro
    var midX2 = BAR_X + BAR_W/2;
    var dominanceGap = Math.abs(bullPct - bearPct);
    var verdict, vColor;
    if (dominanceGap >= 15) {
      verdict = dominantUp ? '▲▲' : '▼▼';
      vColor  = dominantUp ? '#00ff88' : '#ff3333';
    } else if (dominanceGap >= 7) {
      verdict = dominantUp ? '▲' : '▼';
      vColor  = dominantUp ? '#00e676' : '#ff1744';
    } else {
      verdict = '≈';
      vColor  = 'rgba(255,255,255,.4)';
    }
    ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = vColor;
    ctx.fillText(verdict, midX2, CMP_TOP + 12);

    // Etiqueta superior
    ctx.font = '6px monospace'; ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillText('PRESIÓN ' + ticksUp + '↑ ' + ticksDown + '↓', midX2, CMP_TOP - 1);
    ctx.textAlign = 'left';
  }


  // ── MARCADOR VERTICAL MOVIBLE ─────────────────────────────────
  if (_fMarkerX != null && typeof HIST_TOP !== 'undefined') {
    var mkX = BAR_X + Math.round(_fMarkerX * BAR_W);
    // Línea cian brillante
    ctx.strokeStyle = '#18ffff'; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(mkX, HIST_TOP); ctx.lineTo(mkX, HIST_BOT); ctx.stroke();
    // Zona activa a la derecha
    var mkRight = BAR_X + BAR_W - mkX;
    if (mkRight > 2) {
      ctx.fillStyle = 'rgba(24,255,255,.08)';
      ctx.fillRect(mkX, HIST_TOP, mkRight, HIST_H);
    }
    // Handle superior — círculo
    ctx.beginPath(); ctx.arc(mkX, HIST_TOP + 6, 5, 0, Math.PI*2);
    ctx.fillStyle = '#18ffff'; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke();
    // Handle inferior — triángulo
    ctx.fillStyle = '#18ffff'; ctx.beginPath();
    ctx.moveTo(mkX-5, HIST_BOT-2); ctx.lineTo(mkX+5, HIST_BOT-2); ctx.lineTo(mkX, HIST_BOT+5);
    ctx.fill();
    // Etiqueta
    var mkTick = Math.round(_fMarkerX * histN);
    ctx.fillStyle = '#18ffff'; ctx.font = 'bold 7px monospace';
    ctx.textAlign = mkX > BAR_X + BAR_W/2 ? 'right' : 'left';
    ctx.fillText((histN - mkTick) + 't', mkX + (mkX > BAR_X + BAR_W/2 ? -4 : 4), HIST_TOP + 16);
  }

  ctx.textAlign = 'left';
}

// ════════════════════════════════════════════════════════════════
// FUNCIONES AVANZADAS A–G
// ════════════════════════════════════════════════════════════════

// A — Ventana dinámica de ticks
function _getTickWindow() {
  return _tf <= 60 ? 20 : _tf <= 300 ? 35 : 50;
}

// B — Factor sesión de mercado
function _sessionFactor(sessionName) {
  var m = { 'Asia':0.7, 'Overlap A/E':0.85, 'Europa':0.95,
            'Overlap E/NY':1.2, 'NY':1.0, 'Off':0.5 };
  return m[sessionName] || 1.0;
}

// C — Streak de velas consecutivas del mismo color
function _calcStreak() {
  if (!_fClosedCandles.length) return { n:0, isG:true };
  var last = _fClosedCandles[_fClosedCandles.length-1];
  var streak = 1;
  for (var i = _fClosedCandles.length - 2; i >= 0; i--) {
    if (_fClosedCandles[i].isG === last.isG) streak++;
    else break;
  }
  return { n:streak, isG:last.isG };
}

// D — Aceleración al cierre de vela
function _calcAccel(candle) {
  if (!candle || !_fPrices || _fPrices.length < 8) return 1.0;
  var n   = _fPrices.length;
  var h1  = _fPrices.slice(-Math.ceil(n * 0.35));
  var h2  = _fPrices.slice(0, Math.floor(n * 0.65));
  var s1 = 0, s2 = 0;
  for (var i=1;i<h1.length;i++) s1 += Math.abs(h1[i]-h1[i-1]);
  for (var j=1;j<h2.length;j++) s2 += Math.abs(h2[j]-h2[j-1]);
  var spd1 = s1 / Math.max(1, h1.length-1);
  var spd2 = s2 / Math.max(1, h2.length-1);
  return spd2 > 0 ? parseFloat((spd1/spd2).toFixed(2)) : 1.0;
}

// E — Umbral adaptativo por spread
function _adaptiveThreshold(base, spreadMult) {
  if (spreadMult <= 1.0) return base;
  if (spreadMult <= 1.5) return Math.min(0.95, base + 0.08);
  return Math.min(0.95, base + 0.18);
}

// F — Win rate
var _winLog = {};
try { chrome.storage.local.get(['cmd_winlog'], function(r) {
  if (r.cmd_winlog) _winLog = r.cmd_winlog;
}); } catch(e9) {}

function _recordWin(asset, predDir, actualColor) {
  if (!asset) return;
  if (!_winLog[asset]) _winLog[asset] = [];
  _winLog[asset].push({ p: predDir ? 'G' : 'R', a: actualColor });
  if (_winLog[asset].length > 50) _winLog[asset].shift();
  try { chrome.storage.local.set({cmd_winlog: _winLog}); } catch(e9) {}
}

function _getWinRate(asset) {
  var log = asset && _winLog[asset];
  if (!log || log.length < 3) return null;
  var hits = log.filter(function(e){ return e.p === e.a; }).length;
  return Math.round(hits / log.length * 100);
}

// G — Divergencia presión vs dirección de vela
function _calcDivergence(isGreenCandle, upTicks, dnTicks) {
  var total   = upTicks + dnTicks || 1;
  var bullPct = upTicks / total;
  if (isGreenCandle && bullPct < 0.42) return { div:true,  msg:'DIV↓ en verde' };
  if (!isGreenCandle && bullPct > 0.58) return { div:true, msg:'DIV↑ en roja'  };
  return { div:false, msg:'OK' };
}

// Última predicción para win rate
var _lastPredForWin = null;

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
