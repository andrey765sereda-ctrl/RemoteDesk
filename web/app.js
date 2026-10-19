(() => {
  'use strict';
  const DEFAULT_API_URL = 'https://remotedesk-api.andrey-765-sereda.workers.dev';
  const $ = selector => document.querySelector(selector);
  const apiInput = $('#api-url');
  const saveButton = $('#save-url');
  const checkButton = $('#check-button');
  const statusText = $('#status-text');
  const statusIndicator = $('#status-indicator');
  const pairCodeInput = $('#pair-code');
  const pairButton = $('#pair-button');
  const pairStatusText = $('#pair-status-text');
  const pairStatusIndicator = $('#pair-status-indicator');
  const controlCard = $('#control-card');
  const controlsArea = $('#controls-area');
  const controlStatusText = $('#control-status-text');
  const controlStatusIndicator = $('#control-status-indicator');
  const disconnectButton = $('#disconnect-button');
  const touchpad = $('#touchpad');
  const textToType = $('#text-to-type');
  const toast = $('#toast');
  const streamUrlInput = $('#stream-url');
  const streamFrame = $('#stream-frame');
  const streamPlaceholder = $('#stream-placeholder');
  const streamStatus = $('#stream-status');
  const inputStatusDetail = $('#input-status-detail');
  let apiBase = DEFAULT_API_URL;
  let toastTimer = 0;
  let pairingInProgress = false;
  let controlSocket = null;
  let controlAuthenticated = false;
  let hostConnected = false;
  let hostSocketConnected = false;
  let inputReady = false;
  let inputStatusReceived = false;
  let commandCounter = 0;
  const commandKinds = new Map();
  let padPointerId = null;
  let padLastX = 0;
  let padLastY = 0;
  let padStartAt = 0;
  let padMoved = false;
  let pendingDx = 0;
  let pendingDy = 0;
  let padFrame = 0;
  const heldUi = new Set();

  apiInput.value = DEFAULT_API_URL;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  }
  function setStatus(indicator, element, kind, message) {
    indicator.className = `status-indicator ${kind}`;
    element.textContent = message;
  }
  function setControlReady(ready, message) {
    hostConnected = ready;
    controlCard.dataset.ready = ready ? 'true' : 'false';
    controlsArea.querySelectorAll('button, textarea').forEach(element => { element.disabled = !ready; });
    disconnectButton.disabled = !controlAuthenticated;
    setStatus(controlStatusIndicator, controlStatusText, ready ? 'good' : (controlAuthenticated ? 'waiting' : 'idle'), message);
  }
  function validateApiUrl(raw) {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('Для API требуется HTTPS');
    return parsed.origin;
  }
  async function postApi(path, body) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store', mode: 'cors',
      });
    } catch (cause) {
      throw new Error(`${path}: ошибка сети/CORS (${cause?.message || cause}). Проверь URL Worker и интернет.`);
    }
    let data = {};
    try { data = await response.json(); } catch { /* non-JSON response */ }
    if (!response.ok) throw new Error(`${path}: ${data.message || data.error || `HTTP ${response.status}`}`);
    return data;
  }
  function makeWebSocketUrl() {
    const url = new URL('/api/control/socket', apiBase);
    url.protocol = 'wss:';
    return url.toString();
  }

  saveButton.addEventListener('click', () => {
    try {
      apiBase = validateApiUrl(apiInput.value.trim());
      setStatus(statusIndicator, statusText, 'idle', 'Адрес применён — не проверено');
      showToast('Адрес Cloudflare Worker применён.');
    } catch (error) { showToast(error.message || 'Неверный URL API'); }
  });

  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    setStatus(statusIndicator, statusText, 'waiting', 'Проверяем API…');
    try {
      const response = await fetch(`${apiBase}/api/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.status !== 'ok') throw new Error('API вернул неожиданный ответ');
      setStatus(statusIndicator, statusText, 'good', `API доступен · ${data.version || 'OK'}`);
    } catch (error) {
      setStatus(statusIndicator, statusText, 'bad', `Ошибка API: ${error.message || error}`);
      showToast('Не удалось проверить Cloudflare Worker.');
    } finally { checkButton.disabled = false; }
  });

  pairCodeInput.addEventListener('input', () => {
    const code = pairCodeInput.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 12);
    pairCodeInput.value = [code.slice(0, 4), code.slice(4, 8), code.slice(8, 12)].filter(Boolean).join('-');
  });

  pairButton.addEventListener('click', async () => {
    if (pairingInProgress) return;
    const pairCode = pairCodeInput.value.replace(/[^A-F0-9]/gi, '').toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(pairCode)) {
      setStatus(pairStatusIndicator, pairStatusText, 'bad', 'Введи все 12 символов кода');
      return;
    }
    pairingInProgress = true;
    pairButton.disabled = true;
    pairButton.textContent = 'Запрашиваем…';
    setStatus(pairStatusIndicator, pairStatusText, 'waiting', 'Отправляем запрос Windows Host…');
    try {
      const claim = await postApi('/api/pairing/claim', { pairCode });
      const deadline = Date.now() + 5 * 60 * 1000;
      setStatus(pairStatusIndicator, pairStatusText, 'waiting', 'Подтверди запрос в терминале Windows…');
      while (Date.now() < deadline) {
        await sleep(1500);
        const state = await postApi('/api/pairing/client-status', { sessionId: claim.sessionId, clientToken: claim.clientToken });
        if (state.status === 'approved') {
          setStatus(pairStatusIndicator, pairStatusText, 'good', 'Сопряжение подтверждено');
          controlCard.hidden = false;
          await connectControlSocket(claim.sessionId, claim.clientToken);
          pairButton.textContent = 'Устройство сопряжено';
          pairButton.disabled = true;
          return;
        }
        if (state.status === 'rejected') throw new Error('Запрос отклонён на компьютере.');
        if (state.status === 'expired') throw new Error('Сессия истекла. Перезапусти Host и возьми новый код.');
      }
      throw new Error('Истекло время ожидания подтверждения.');
    } catch (error) {
      setStatus(pairStatusIndicator, pairStatusText, 'bad', error.message || 'Сопряжение не удалось');
      showToast(error.message || 'Сопряжение не удалось');
      pairButton.disabled = false;
      pairButton.textContent = 'Запросить сопряжение';
    } finally { pairingInProgress = false; }
  });

  function connectControlSocket(sessionId, clientToken) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let authenticated = false;
      const ws = new WebSocket(makeWebSocketUrl());
      controlSocket = ws;
      hostSocketConnected = false;
      inputReady = false;
      inputStatusReceived = false;
      inputStatusDetail.textContent = 'Подключение WebSocket управления…';
      setControlReady(false, 'Открываем защищённый канал управления…');
      const timer = setTimeout(() => {
        if (!finished) { finished = true; try { ws.close(); } catch {} reject(new Error('Worker не подтвердил WebSocket за 15 секунд. Обнови Worker и проверь его логи.')); }
      }, 15000);
      const fail = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error);
      };
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', role: 'client', sessionId, clientToken }));
      });
      ws.addEventListener('message', event => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'auth_ok') {
          authenticated = true;
          controlAuthenticated = true;
          if (!finished) { finished = true; clearTimeout(timer); resolve(); }
          setControlReady(false, 'Канал авторизован. Ожидаем Windows Host…');
        } else if (data.type === 'hostConnected') {
          hostSocketConnected = true;
          setControlReady(hostSocketConnected && inputReady, inputReady ? 'Управление подключено' : 'Host подключён; проверяем Windows input API…');
          if (!inputStatusReceived) inputStatusDetail.textContent = 'Ожидаем подтверждение, что Windows может отправлять ввод…';
        } else if (data.type === 'inputStatus') {
          inputStatusReceived = true;
          inputReady = data.ok === true;
          inputStatusDetail.textContent = data.ok ? `Windows input API готов: ${data.message || 'OK'}` : `Windows input API недоступен: ${data.message || 'неизвестная ошибка'}`;
          setControlReady(hostSocketConnected && inputReady, !hostSocketConnected ? 'Host не подключён' : (inputReady ? 'Управление подключено' : 'Ввод Windows не готов'));
          if (!data.ok) showToast(`Не удалось инициализировать ввод Windows: ${data.message || 'ошибка'}`);
          else if (hostSocketConnected) showToast('Управление подключено. Проверь курсор кнопкой ниже.');
        } else if (data.type === 'hostOffline' || data.type === 'hostDisconnected') {
          hostSocketConnected = false;
          inputReady = false;
          inputStatusReceived = false;
          inputStatusDetail.textContent = 'Host не подключён. Перезапусти RemoteDesk Host.';
          setControlReady(false, 'Host не подключён. Перезапусти RemoteDesk Host.');
        } else if (data.type === 'clientDisconnected') {
          showToast('Сессия управления прервана.');
        } else if (data.type === 'ack') {
          const kind = commandKinds.get(String(data.id || '')) || 'command';
          commandKinds.delete(String(data.id || ''));
          if (data.ok === false) {
            inputStatusDetail.textContent = `Команда ${kind} не выполнена на Windows: ${data.message || 'ошибка'}`;
            showToast(`Команда не выполнена: ${data.message || 'ошибка'}`);
          } else if (kind !== 'move' || inputStatusDetail.textContent.startsWith('Тестовая команда отправлена')) {
            inputStatusDetail.textContent = `Команда ${kind} выполнена на Windows.`;
          }
        } else if (data.type === 'error') {
          if (!authenticated) fail(new Error(`Worker отклонил управление: ${data.message || 'auth error'}`));
          else showToast(`Ошибка управления: ${data.message || 'unknown'}`);
        }
      });
      ws.addEventListener('error', () => fail(new Error('Не удалось открыть WSS к Worker. Проверь, что новая версия Worker развёрнута.')));
      ws.addEventListener('close', () => {
        if (!authenticated) fail(new Error('WebSocket закрылся до авторизации.'));
        controlSocket = null;
        controlAuthenticated = false;
        hostSocketConnected = false;
        inputReady = false;
        inputStatusReceived = false;
        setControlReady(false, 'Канал управления закрыт');
      });
    });
  }

  function sendCommand(command) {
    if (!controlSocket || controlSocket.readyState !== WebSocket.OPEN || !hostConnected) return false;
    const id = `${Date.now()}-${++commandCounter}`;
    commandKinds.set(id, String(command.action || 'command'));
    while (commandKinds.size > 160) commandKinds.delete(commandKinds.keys().next().value);
    try {
      controlSocket.send(JSON.stringify({ type: 'control', id, command }));
      return true;
    } catch (error) {
      showToast(`Не удалось отправить команду: ${error.message || error}`);
      return false;
    }
  }

  // Relative-motion trackpad. Each message is bounded by both the browser and the Host.
  function flushPointerDelta() {
    padFrame = 0;
    const dx = Math.max(-180, Math.min(180, Math.round(pendingDx)));
    const dy = Math.max(-180, Math.min(180, Math.round(pendingDy)));
    pendingDx -= dx;
    pendingDy -= dy;
    if (dx || dy) sendCommand({ action: 'move', dx, dy });
    if ((Math.abs(pendingDx) >= 1 || Math.abs(pendingDy) >= 1) && !padFrame) padFrame = requestAnimationFrame(flushPointerDelta);
  }
  touchpad.addEventListener('pointerdown', event => {
    if (!hostConnected) return;
    event.preventDefault();
    padPointerId = event.pointerId;
    padLastX = event.clientX;
    padLastY = event.clientY;
    padStartAt = performance.now();
    padMoved = false;
    pendingDx = 0; pendingDy = 0;
    touchpad.classList.add('active');
    try { touchpad.setPointerCapture(event.pointerId); } catch { /* Safari may not expose capture in all modes */ }
  });
  touchpad.addEventListener('pointermove', event => {
    if (padPointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - padLastX;
    const dy = event.clientY - padLastY;
    padLastX = event.clientX; padLastY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) padMoved = true;
    pendingDx += dx * 2.0;
    pendingDy += dy * 2.0;
    if (!padFrame) padFrame = requestAnimationFrame(flushPointerDelta);
  });
  function endPadPointer(event) {
    if (padPointerId !== event.pointerId) return;
    const wasMoved = padMoved;
    const elapsed = performance.now() - padStartAt;
    padPointerId = null;
    touchpad.classList.remove('active');
    if (padFrame) { cancelAnimationFrame(padFrame); padFrame = 0; }
    flushPointerDelta();
    if (!wasMoved && elapsed < 600) sendCommand({ action: 'click', button: 'left' });
  }
  touchpad.addEventListener('pointerup', endPadPointer);
  touchpad.addEventListener('pointercancel', endPadPointer);
  touchpad.addEventListener('contextmenu', event => event.preventDefault());

  document.querySelectorAll('[data-click-button]').forEach(button => {
    button.addEventListener('click', () => sendCommand({ action: 'click', button: button.dataset.clickButton }));
  });
  $('#test-control').addEventListener('click', () => {
    if (sendCommand({ action: 'move', dx: 18, dy: 8 })) {
      inputStatusDetail.textContent = 'Тестовая команда отправлена; ждём подтверждение от Windows…';
    } else {
      showToast('Управление ещё не готово. Сначала проверь статус Host и Windows input API.');
    }
  });
  document.querySelectorAll('[data-wheel]').forEach(button => {
    button.addEventListener('click', () => sendCommand({ action: 'wheel', deltaY: Number(button.dataset.wheel) }));
  });
  document.querySelectorAll('[data-hold-button]').forEach(button => {
    const name = button.dataset.holdButton;
    const release = () => { if (!heldUi.delete(`button:${name}`)) return; sendCommand({ action: 'buttonUp', button: name }); button.classList.remove('held'); };
    button.addEventListener('pointerdown', event => { event.preventDefault(); if (sendCommand({ action: 'buttonDown', button: name })) { heldUi.add(`button:${name}`); button.classList.add('held'); } });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    window.addEventListener('pointerup', release);
  });
  document.querySelectorAll('[data-key-click]').forEach(button => {
    button.addEventListener('click', () => sendCommand({ action: 'key', key: button.dataset.keyClick, phase: 'click' }));
  });
  document.querySelectorAll('[data-key-hold]').forEach(button => {
    const key = button.dataset.keyHold;
    const token = `key:${key}`;
    const release = () => { if (!heldUi.delete(token)) return; sendCommand({ action: 'key', key, phase: 'up' }); button.classList.remove('held'); };
    button.addEventListener('pointerdown', event => { event.preventDefault(); if (sendCommand({ action: 'key', key, phase: 'down' })) { heldUi.add(token); button.classList.add('held'); } });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    window.addEventListener('pointerup', release);
  });
  $('#send-text').addEventListener('click', () => {
    const value = textToType.value;
    if (!value) { showToast('Введи текст для отправки на Windows.'); return; }
    if (value.length > 500) { showToast('Максимум 500 символов за отправку.'); return; }
    if (sendCommand({ action: 'text', text: value })) { textToType.value = ''; showToast('Текст отправлен на ПК.'); }
  });
  $('#release-inputs').addEventListener('click', () => {
    sendCommand({ action: 'releaseAll' });
    heldUi.clear();
    document.querySelectorAll('.held').forEach(element => element.classList.remove('held'));
    showToast('Отправлена команда отпустить все клавиши и кнопки.');
  });
  disconnectButton.addEventListener('click', () => disconnectControl(true));

  function disconnectControl(showStatus) {
    if (controlSocket && controlSocket.readyState === WebSocket.OPEN) {
      try { controlSocket.send(JSON.stringify({ type: 'control', id: `${Date.now()}-${++commandCounter}`, command: { action: 'releaseAll' } })); } catch {}
      try { controlSocket.close(1000, 'user disconnected'); } catch {}
    }
    controlSocket = null;
    controlAuthenticated = false;
    hostSocketConnected = false;
    inputReady = false;
    inputStatusReceived = false;
    setControlReady(false, showStatus ? 'Управление отключено' : 'Канал управления закрыт');
    heldUi.clear();
    document.querySelectorAll('.held').forEach(element => element.classList.remove('held'));
  }

  $('#stream-load').addEventListener('click', () => {
    let url;
    try { url = new URL(streamUrlInput.value.trim()); }
    catch { showToast('Введи полный HTTPS URL MediaMTX через Tailscale Serve.'); return; }
    const localHttpAllowed = location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttpAllowed) {
      showToast('GitHub Pages работает через HTTPS. Для встроенного видео используй HTTPS-адрес Tailscale Serve, а не локальный http://192.168…');
      streamStatus.textContent = 'Для мобильного интернета требуется HTTPS-адрес Tailscale Serve.';
      return;
    }
    if (url.username || url.password) { showToast('Не вставляй логин и пароль в URL видео.'); return; }
    url.searchParams.set('autoplay', 'true');
    url.searchParams.set('muted', 'true');
    url.searchParams.set('playsInline', 'true');
    url.searchParams.set('controls', 'true');
    streamPlaceholder.hidden = true;
    streamFrame.hidden = false;
    streamFrame.src = url.toString();
    $('#stream-load').disabled = true;
    $('#stream-stop').disabled = false;
    streamStatus.textContent = 'Загружаем встроенный плеер MediaMTX… Если видео не появится, проверь Tailscale и WebRTC UDP 8189.';
  });
  $('#stream-stop').addEventListener('click', () => {
    streamFrame.src = 'about:blank';
    streamFrame.hidden = true;
    streamPlaceholder.hidden = false;
    $('#stream-load').disabled = false;
    $('#stream-stop').disabled = true;
    streamStatus.textContent = 'Трансляция остановлена.';
  });
  streamFrame.addEventListener('load', () => {
    if (!streamFrame.hidden && streamFrame.src && streamFrame.src !== 'about:blank') {
      streamStatus.textContent = 'Страница MediaMTX загружена. Если изображение чёрное, проверь наличие потока и ICE-кандидат Tailscale IP.';
    }
  });

  setControlReady(false, 'Сначала выполни сопряжение');
  controlCard.hidden = false;
  window.setInterval(() => {
    if (controlSocket && controlSocket.readyState === WebSocket.OPEN) {
      try { controlSocket.send(JSON.stringify({ type: 'ping' })); } catch { /* closed concurrently */ }
    }
  }, 20000);
  window.addEventListener('pagehide', () => {
    if (controlSocket && controlSocket.readyState === WebSocket.OPEN) {
      try { controlSocket.send(JSON.stringify({ type: 'control', id: `${Date.now()}-${++commandCounter}`, command: { action: 'releaseAll' } })); } catch {}
    }
  });
})();
