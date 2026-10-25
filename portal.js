(() => {
  'use strict';
  const RPC_BASE = String(window.PORTAL_RPC_BASE || '').replace(/\/+$/, '');
  const ANON_KEY = String(window.PORTAL_ANON_KEY || '');
  const SESSION_KEY = 'fanshunPortalSession';
  const $ = (id) => document.getElementById(id);
  const state = { profile: null, token: '' };

  function rpc(name, payload = {}) {
    if (!RPC_BASE) return Promise.reject(new Error('入口接口尚未配置'));
    return fetch(`${RPC_BASE}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify(payload)
    }).then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.message || data?.error || `请求失败（HTTP ${response.status}）`);
      return data || {};
    });
  }

  function setError(message) {
    const el = $('loginError');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function showLogin() {
    $('loginView').hidden = false;
    $('redirectView').hidden = true;
  }

  function showRedirect(profile) {
    $('loginView').hidden = true;
    $('redirectView').hidden = false;
    $('redirectHint').textContent = profile?.name ? `${profile.name}，正在打开你的工作页面…` : '正在打开你的工作页面…';
  }

  function writeSessionCookie(token) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = token
      ? `${SESSION_KEY}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
      : `${SESSION_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  }

  function saveToken(token) {
    state.token = token || '';
    try { if (token) localStorage.setItem(SESSION_KEY, token); else localStorage.removeItem(SESSION_KEY); } catch { }
    try { writeSessionCookie(token || ''); } catch { }
  }

  function readToken() {
    try {
      const stored = localStorage.getItem(SESSION_KEY) || '';
      if (stored) return stored;
    } catch { }
    try {
      const match = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(SESSION_KEY + '='));
      if (!match) return '';
      const token = decodeURIComponent(match.slice(SESSION_KEY.length + 1));
      if (token) {
        try { localStorage.setItem(SESSION_KEY, token); } catch { }
      }
      return token;
    } catch { return ''; }
  }

  function saveLegacyAccess(profile) {
    const code = String(profile?.legacyCode || '');
    if (!code) throw new Error('当前人员还没有可用的工作页面访问凭据');
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    try {
      if (profile.legacyRole === 'employee') {
        localStorage.setItem('fanshipWorkEmployeeCode', code);
        document.cookie = `fanshipWorkEmployeeCode=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      } else {
        localStorage.setItem(`shipmentBoardAccessCode:${profile.legacyRole}`, code);
      }
      document.cookie = `fanshipLegacyCode=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch { }
  }

  function destinationFor(profile) {
    const mobile = window.matchMedia('(max-width: 900px)').matches
      || /iPhone|iPod|Android|Mobile|MicroMessenger/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) <= 900);
    const appBase = location.hostname === '127.0.0.1'
      || location.hostname === 'localhost'
      || location.hostname.endsWith('.tcloudbaseapp.com')
      ? '/fanshun/'
      : '/';
    const withMode = (fileName, mode) => {
      const url = new URL(`${appBase}${fileName}`, location.origin);
      if (mode) url.searchParams.set('mode', mode);
      if (mobile) url.searchParams.set('view', 'mobile');
      return url.toString();
    };
    if (profile.defaultRoom === 'warehouse' || profile.legacyRole === 'user') return withMode('index.html', 'user');
    if (profile.defaultRoom === 'admin' || profile.defaultRoom === 'quality' || profile.legacyRole === 'admin') return withMode('index.html', 'admin');
    return withMode('work.html', '');
  }

  function enter(profile) {
    saveLegacyAccess(profile);
    try { localStorage.setItem('fanshunPortalProfile', JSON.stringify(profile || {})); } catch { }
    showRedirect(profile);
    window.location.replace(destinationFor(profile));
  }

  async function loadSession(token) {
    const result = await rpc('app_session_info', { p_session: token });
    if (!result.ok) throw new Error(result.error || '会话已失效');
    saveToken(token);
    enter(result.profile);
  }

  async function bindFromUrl() {
    const token = new URLSearchParams(location.search).get('bind');
    if (!token) return false;
    const result = await rpc('app_bind_device', { p_bind_token: token, p_device_label: navigator.userAgent.slice(0, 160) });
    if (!result.ok) throw new Error(result.error || '绑定链接已失效');
    saveToken(result.sessionToken);
    history.replaceState(null, '', location.pathname);
    enter(result.profile);
    return true;
  }

  async function initialize() {
    if (await bindFromUrl()) return;
    const token = readToken();
    if (token) {
      try { await loadSession(token); return; } catch { saveToken(''); }
    }
    showLogin();
  }

  const accessCodeField = $('accessCode');
  const accessKeypad = $('accessKeypad');
  const accessKeypadKeys = $('accessKeypadKeys');
  const accessKeypadModeLabel = $('accessKeypadModeLabel');
  let accessKeypadMode = 'upper';
  const keypadLayouts = {
    digits: ['1','2','3','4','5','6','7','8','9','0','-'],
    upper: ['Q','W','E','R','T','Y','U','I','O','P','A','S','D','F','G','H','J','K','L','Z','X','C','V','B','N','M','-'],
    lower: ['q','w','e','r','t','y','u','i','o','p','a','s','d','f','g','h','j','k','l','z','x','c','v','b','n','m','-']
  };
  const keypadModeNames = { digits: '数字', upper: '大写', lower: '小写' };

  function renderAccessKeypad() {
    if (!accessKeypadKeys) return;
    accessKeypadModeLabel.textContent = keypadModeNames[accessKeypadMode] || '大写';
    accessKeypadKeys.innerHTML = keypadLayouts[accessKeypadMode].map((key) => `<button type="button" data-access-key="${key}">${key}</button>`).join('');
  }

  function openAccessKeypad() {
    if (!accessKeypad) return;
    accessKeypad.hidden = false;
    renderAccessKeypad();
  }

  function appendAccessKey(key) {
    if (!accessCodeField) return;
    accessCodeField.value += key;
  }

  if (accessCodeField) {
    accessCodeField.addEventListener('click', () => accessCodeField.focus());
    accessCodeField.closest('.field')?.addEventListener('click', () => accessCodeField.focus());
  }
  $('accessKeypadToggle')?.addEventListener('click', openAccessKeypad);
  $('accessKeypadClose')?.addEventListener('click', () => { if (accessKeypad) accessKeypad.hidden = true; });
  document.querySelectorAll('[data-keypad-mode]').forEach((button) => button.addEventListener('click', () => {
    accessKeypadMode = button.dataset.keypadMode || 'upper';
    renderAccessKeypad();
  }));
  accessKeypadKeys?.addEventListener('click', (event) => {
    const key = event.target.closest('[data-access-key]')?.dataset.accessKey;
    if (key != null) appendAccessKey(key);
  });
  $('accessKeypadBackspace')?.addEventListener('click', () => {
    if (accessCodeField) accessCodeField.value = accessCodeField.value.slice(0, -1);
  });
  $('accessKeypadClear')?.addEventListener('click', () => {
    if (accessCodeField) accessCodeField.value = '';
  });
  if (window.navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches) {
    const toggle = $('accessKeypadToggle');
    if (toggle) toggle.textContent = '系统键盘打不开？用屏幕键盘';
  }

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('accessCode').value.trim();
    if (!code) return;
    setError('');
    const button = $('loginButton');
    button.disabled = true;
    button.textContent = '正在登录…';
    try {
      const result = await rpc('app_login_with_code', { p_code: code, p_device_label: navigator.userAgent.slice(0, 160) });
      if (!result.ok) throw new Error(result.error || '访问码不正确');
      saveToken(result.sessionToken);
      $('accessCode').value = '';
      enter(result.profile);
    } catch (error) {
      setError(error.message || '登录失败，请稍后再试');
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  });

  initialize().catch((error) => {
    setError(error.message || '工作台初始化失败');
    showLogin();
  });
})();
