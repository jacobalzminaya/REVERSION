'use strict';
var _enabled = false;
var _tf      = 60;
var _poll    = null;

function $(id){ return document.getElementById(id); }
function set(id, txt, cls) {
  var el = $(id); if (!el) return;
  el.textContent = txt;
  if (cls) el.className = 'val ' + cls;
}

function findPOTab(cb) {
  chrome.tabs.query({}, function(tabs) {
    for (var i = 0; i < tabs.length; i++) {
      var u = (tabs[i].url||'').toLowerCase();
      if (u.includes('po.market') || u.includes('pocketoption')) { cb(tabs[i]); return; }
    }
    cb(null);
  });
}

function readCMD(tab, cb) {
  chrome.tabs.sendMessage(tab.id, {type:'status'}, function(r) {
    if (chrome.runtime.lastError || !r) return;
    cb(r);
  });
}

function render(r) {
  if (!r) return;
  _enabled = r.enabled || false;
  updateBtn();
  if (r.balance)  set('v-balance', '$' + parseFloat(r.balance).toFixed(2), 'green');
  if (r.payout)   set('v-payout',  r.payout + '%');
  if (r.asset)    set('v-asset',   r.asset, 'white');
  if (r.count != null) set('v-count', r.count + ' velas', 'cyan');
}

function updateBtn() {
  var btn = $('btn-toggle'), st = $('h-status');
  if (_enabled) {
    btn.className='btn stop'; btn.textContent='⏹ DETENER';
    if (st){ st.className='header-status on'; st.textContent='● ACTIVO'; }
  } else {
    btn.className='btn'; btn.textContent='▶ ACTIVAR';
    if (st){ st.className='header-status'; st.textContent='● INACTIVO'; }
  }
}

function startPoll() {
  if (_poll) clearInterval(_poll);
  _poll = setInterval(function() {
    if (document.hidden) return;
    findPOTab(function(tab) { if (tab) readCMD(tab, render); });
  }, 1500);
}

$('btn-toggle').addEventListener('click', function() {
  _enabled = !_enabled;
  updateBtn();
  findPOTab(function(tab) {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: _enabled ? 'enable' : 'disable', tf: _tf }, function(r) {
      if (chrome.runtime.lastError) return;
      if (r && r.asset) set('v-asset', r.asset, 'white');
    });
  });
  if (_enabled) startPoll(); else { if (_poll) clearInterval(_poll); _poll=null; }
});

document.querySelectorAll('.tf-btn').forEach(function(b) {
  b.addEventListener('click', function() {
    _tf = parseInt(this.dataset.tf);
    document.querySelectorAll('.tf-btn').forEach(function(x){ x.classList.remove('active'); });
    this.classList.add('active');
    findPOTab(function(tab) { if (tab) chrome.tabs.sendMessage(tab.id, {type:'setTf', tf:_tf}); });
    chrome.storage.local.set({tf:_tf});
  });
});

document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.local.get(['tf'], function(r) {
    if (r.tf) {
      _tf = r.tf;
      document.querySelectorAll('.tf-btn').forEach(function(b){ b.classList.remove('active'); });
      var el = document.querySelector('[data-tf="'+_tf+'"]');
      if (el) el.classList.add('active');
    }
  });
  updateBtn();
  findPOTab(function(tab) {
    if (!tab) { startPoll(); return; }
    readCMD(tab, function(r) {
      render(r);
      startPoll();
    });
  });
});