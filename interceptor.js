// CMD Bridge Interceptor v4.1 — document_start MAIN world
// Intercepta WS + mantiene window.CMD para el popup
'use strict';
(function() {
  
  // Prevenir doble inyección
  if (window.__CMD_INTERCEPTOR_LOADED__) {
    console.log('[CMD Interceptor] Ya cargado, saltando...');
    return;
  }
  window.__CMD_INTERCEPTOR_LOADED__ = true;

  // ── WebSocket hook ────────────────────────────────────────────
  var _OrigWS = window.WebSocket;
  if (!_OrigWS) {
    console.error('[CMD Interceptor] WebSocket no disponible');
    return;
  }

  function CmdWS(url, protocols) {
    var ws = protocols ? new _OrigWS(url, protocols) : new _OrigWS(url);
    
    // Detectar cualquier dominio de Pocket Option
    var isPO = url && (
      url.indexOf('po.market') >= 0 || 
      url.indexOf('pocketoption') >= 0 ||
      url.indexOf('trading') >= 0
    );
    
    if (isPO) {
      console.log('[CMD Interceptor] WS interceptado:', url.substring(0, 50));
      
      ws.addEventListener('message', function(evt) {
        try {
          var raw = evt.data;
          
          // Manejar Blob
          if (raw instanceof Blob) {
            var fr = new FileReader();
            fr.onload = function() {
              var txt = fr.result;
              window.CMD.lastWsRaw = txt.substring(0, 500);
              document.dispatchEvent(new CustomEvent('cmd-ws-message', { 
                detail: { data: txt, url: url, timestamp: Date.now() } 
              }));
            };
            fr.onerror = function() {
              console.error('[CMD Interceptor] Error leyendo Blob');
            };
            fr.readAsText(raw);
            return;
          }
          
          // Manejar ArrayBuffer
          if (raw instanceof ArrayBuffer) {
            try {
              raw = new TextDecoder().decode(raw);
            } catch(e) {
              console.error('[CMD Interceptor] Error decodificando ArrayBuffer:', e);
              return;
            }
          }
          
          // String normal
          raw = String(raw);
          window.CMD.lastWsRaw = raw.substring(0, 500);
          document.dispatchEvent(new CustomEvent('cmd-ws-message', { 
            detail: { data: raw, url: url, timestamp: Date.now() } 
          }));
          
        } catch(e) {
          console.error('[CMD Interceptor] Error en message handler:', e);
        }
      });
      
      // También interceptar errores
      ws.addEventListener('error', function(evt) {
        console.warn('[CMD Interceptor] WS Error en', url);
      });
    }
    
    return ws;
  }

  CmdWS.prototype  = _OrigWS.prototype;
  CmdWS.CONNECTING = _OrigWS.CONNECTING;
  CmdWS.OPEN       = _OrigWS.OPEN;
  CmdWS.CLOSING    = _OrigWS.CLOSING;
  CmdWS.CLOSED     = _OrigWS.CLOSED;
  
  // Preservar propiedades adicionales
  Object.defineProperty(window, 'WebSocket', {
    value: CmdWS,
    writable: true,
    configurable: true
  });

  // ── window.CMD: objeto central leído por el popup ─────────────
  window.CMD = {
    enabled     : false,
    balance     : null,
    payout      : null,
    asset       : null,
    openOptions : 0,
    candleCount : 0,
    liveTick    : null,
    lastCandle  : null,
    lastWsRaw   : null,
    initialized : true,
    version     : '4.1'
  };

  // ── Recibir actualizaciones desde el content script (ISOLATED) ─
  document.addEventListener('cmd-update', function(evt) {
    if (!evt.detail) return;
    var d = evt.detail;
    
    try {
      if (d.type === 'state') {
        window.CMD.enabled     = d.enabled;
        window.CMD.balance     = d.balance;
        window.CMD.payout      = d.payout;
        window.CMD.asset       = d.asset;
        window.CMD.openOptions = d.openOptions;
        window.CMD.candleCount = d.candleCount;
      } else if (d.type === 'liveTick') {
        window.CMD.liveTick = d.data;
      } else if (d.type === 'lastCandle') {
        window.CMD.lastCandle  = d.data;
        window.CMD.candleCount = d.candleCount;
      }
    } catch(e) {
      console.error('[CMD Interceptor] Error procesando cmd-update:', e);
    }
  });

  // Notificar que está listo
  document.dispatchEvent(new CustomEvent('cmd-interceptor-ready', { 
    detail: { version: '4.1', timestamp: Date.now() } 
  }));
  
  console.log('[CMD Interceptor v4.1] Listo — window.CMD inicializado');
})();