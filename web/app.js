(() => {
  const DEFAULT_API_URL = 'https://remotedesk-api.andrey-765-sereda.workers.dev';
  const apiInput = document.querySelector('#api-url');
  const saveButton = document.querySelector('#save-url');
  const checkButton = document.querySelector('#check-button');
  const statusText = document.querySelector('#status-text');
  const statusIndicator = document.querySelector('#status-indicator');
  const pairCodeInput = document.querySelector('#pair-code');
  const pairButton = document.querySelector('#pair-button');
  const pairStatusText = document.querySelector('#pair-status-text');
  const pairStatusIndicator = document.querySelector('#pair-status-indicator');
  const screenFrame = document.querySelector('#screen-frame');
  const screenPlaceholder = document.querySelector('#screen-placeholder');
  const screenStatusText = document.querySelector('#screen-status-text');
  const screenStatusIndicator = document.querySelector('#screen-status-indicator');
  const disconnectButton = document.querySelector('#disconnect-button');
  const toast = document.querySelector('#toast');

  let apiBase = DEFAULT_API_URL;
  let toastTimeout;
  let pairingInProgress = false;
  let activePeerConnection = null;
  let activeDataChannel = null;
  let latestFrameUrl = null;
  let firstFrameResolver = null;
  let firstFrameRejecter = null;
  let frameBuffers = new Map();

  apiInput.value = DEFAULT_API_URL;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function setStatus(kind, message) {
    statusIndicator.className = `status-indicator ${kind}`;
    statusText.textContent = message;
  }

  function setPairStatus(kind, message) {
    pairStatusIndicator.className = `status-indicator ${kind}`;
    pairStatusText.textContent = message;
  }

  function setScreenStatus(kind, message) {
    screenStatusIndicator.className = `status-indicator ${kind}`;
    screenStatusText.textContent = message;
  }

  function validateApiUrl(raw) {
    const parsed = new URL(raw);
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocal) throw new Error('HTTPS required');
    return parsed.origin;
  }

  async function postApi(path, body) {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      mode: 'cors',
    });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(data.message || data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  saveButton.addEventListener('click', () => {
    const raw = apiInput.value.trim().replace(/\/$/, '');
    if (!raw) {
      apiBase = '';
      showToast('Введи URL Cloudflare Worker.');
      return;
    }
    try {
      apiBase = validateApiUrl(raw);
      setStatus('idle', 'Адрес применён — не проверено');
      showToast('Адрес API применён для этой вкладки.');
    } catch {
      showToast('Укажи корректный HTTPS URL Worker.');
    }
  });

  checkButton.addEventListener('click', async () => {
    if (!apiBase) {
      showToast('Сначала укажи URL Worker и нажми «Применить адрес».');
      return;
    }
    checkButton.disabled = true;
    checkButton.textContent = 'Проверяем…';
    setStatus('idle', 'Проверяем доступность API…');
    try {
      const response = await fetch(`${apiBase}/api/health`, {
        method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store', mode: 'cors'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.status !== 'ok') throw new Error('Unexpected response');
      setStatus('good', `API доступен · ${data.version || 'версия неизвестна'}`);
      showToast('Cloudflare Worker отвечает.');
    } catch (error) {
      setStatus('bad', 'Не удалось подключиться к API');
      showToast(`Ошибка проверки: ${error.message || 'сетевая ошибка'}`);
    } finally {
      checkButton.disabled = false;
      checkButton.textContent = 'Проверить API';
    }
  });

  pairCodeInput.addEventListener('input', () => {
    const code = pairCodeInput.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 12);
    pairCodeInput.value = [code.slice(0, 4), code.slice(4, 8), code.slice(8, 12)].filter(Boolean).join('-');
  });

  pairButton.addEventListener('click', async () => {
    if (pairingInProgress) return;
    if (!apiBase) {
      showToast('Сначала укажи URL Worker и нажми «Применить адрес».');
      return;
    }
    const pairCode = pairCodeInput.value.replace(/[^A-F0-9]/gi, '').toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(pairCode)) {
      setPairStatus('bad', 'Код должен содержать 12 символов A–F и 0–9');
      showToast('Проверь код в окне RemoteDesk Host на Windows.');
      return;
    }

    pairingInProgress = true;
    pairButton.disabled = true;
    pairButton.textContent = 'Запрашиваем…';
    setPairStatus('waiting', 'Отправляем запрос на сопряжение…');
    try {
      const claim = await postApi('/api/pairing/claim', { pairCode });
      setPairStatus('waiting', 'Запрос отправлен. Подтверди его в терминале Windows.');
      showToast('Запрос отправлен на компьютер. Подтверди его в Windows.');

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const state = await postApi('/api/pairing/client-status', {
          sessionId: claim.sessionId,
          clientToken: claim.clientToken,
        });
        if (state.status === 'approved') {
          setPairStatus('good', 'Сопряжение подтверждено. Подключаем защищённый канал…');
          await startScreenPreview(claim.sessionId, claim.clientToken);
          pairButton.textContent = 'Сопряжение подтверждено';
          pairButton.disabled = true;
          return;
        }
        if (state.status === 'rejected') {
          setPairStatus('bad', 'Запрос отклонён на компьютере.');
          return;
        }
        if (state.status === 'expired') {
          setPairStatus('bad', 'Сессия истекла. Перезапусти RemoteDesk Host и создай новый код.');
          return;
        }
        setPairStatus('waiting', 'Ожидаем подтверждения на компьютере…');
      }
      setPairStatus('bad', 'Время ожидания истекло. Создай новый код на ПК.');
    } catch (error) {
      setPairStatus('bad', `Подключение не удалось: ${error.message || 'ошибка сети'}`);
      setScreenStatus('bad', 'Не удалось начать предпросмотр');
      showToast(`Ошибка подключения: ${error.message || 'ошибка сети'}`);
    } finally {
      pairingInProgress = false;
      if (pairButton.textContent !== 'Сопряжение подтверждено') {
        pairButton.disabled = false;
        pairButton.textContent = 'Запросить сопряжение';
      }
    }
  });

  async function waitForIceGatheringComplete(pc, timeoutMs = 25000) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(() => finish(new Error('Истекло время сбора ICE-кандидатов')), timeoutMs);
      pc.addEventListener('icegatheringstatechange', check);
      check();
    });
  }

  async function waitForHostOffer(sessionId, clientToken, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await postApi('/api/rtc/client-offer', { sessionId, clientToken });
      if (state.status === 'ready' && typeof state.description === 'string') {
        try { return JSON.parse(state.description); }
        catch { throw new Error('Cloudflare вернул некорректное WebRTC-предложение'); }
      }
      await sleep(1500);
    }
    throw new Error('Windows Host не прислал WebRTC-предложение за отведённое время');
  }

  async function startScreenPreview(sessionId, clientToken) {
    disconnectScreen(false);
    setScreenStatus('waiting', 'Создаём защищённое WebRTC-соединение…');
    disconnectButton.disabled = true;
    // STUN-only direct P2P mode. No TURN relay and no TURN credentials are used.
    const rtcConfiguration = {
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
      iceTransportPolicy: 'all'
    };
    setScreenStatus('waiting', 'Режим STUN-only: пытаемся установить прямое WebRTC-соединение без ретранслятора…');
    const pc = new RTCPeerConnection(rtcConfiguration);
    activePeerConnection = pc;
    let firstFrameResolve;
    let firstFrameReject;
    const firstFrame = new Promise((resolve, reject) => {
      firstFrameResolve = resolve;
      firstFrameReject = reject;
    });
    firstFrameResolver = firstFrameResolve;
    firstFrameRejecter = firstFrameReject;
    // Register a rejection handler immediately in case signaling fails before the first-frame wait begins.
    firstFrame.catch(() => {});

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connecting') setScreenStatus('waiting', 'Соединяем устройства…');
      if (state === 'connected') setScreenStatus('waiting', 'Канал установлен. Ожидаем первый кадр…');
      if (state === 'failed') {
        setScreenStatus('bad', 'WebRTC не подключился. Включён STUN-only режим: проверь кандидаты ICE и сетевые ограничения.');
        if (firstFrameRejecter) firstFrameRejecter(new Error('WebRTC-соединение завершилось ошибкой'));
      }
      if (state === 'disconnected') setScreenStatus('waiting', 'Связь временно потеряна…');
      if (state === 'closed') setScreenStatus('idle', 'Просмотр отключён');
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.info('[RemoteDesk] ICE state:', state);
      if (state === 'checking') setScreenStatus('waiting', 'Проверяем сетевые маршруты ICE…');
      if (state === 'connected' || state === 'completed') setScreenStatus('waiting', 'Сетевой ICE-канал установлен. Ожидаем DataChannel…');
      if (state === 'disconnected') setScreenStatus('waiting', 'ICE временно отключён. Проверяем восстановление…');
      if (state === 'failed') setScreenStatus('bad', 'ICE failed: прямой маршрут не найден. TURN отключён; проверь Wi-Fi/мобильную сеть и Windows Firewall.');
    };
    pc.onicecandidateerror = event => {
      console.warn('[RemoteDesk] ICE candidate error:', event.errorCode, event.errorText, event.url);
    };
    pc.ondatachannel = event => {
      const channel = event.channel;
      if (channel.label !== 'screen-frames') {
        channel.close();
        return;
      }
      activeDataChannel = channel;
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        disconnectButton.disabled = false;
        setScreenStatus('waiting', 'Получаем изображение рабочего стола…');
      };
      channel.onclose = () => setScreenStatus('idle', 'Канал просмотра закрыт');
      channel.onerror = () => setScreenStatus('bad', 'Ошибка канала изображения');
      channel.onmessage = event => consumeFrameChunk(event.data);
    };

    try {
      const offer = await waitForHostOffer(sessionId, clientToken);
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      await postApi('/api/rtc/client-answer', {
        sessionId,
        clientToken,
        description: JSON.stringify(pc.localDescription),
      });
      setScreenStatus('waiting', 'Ответ отправлен Windows. Устанавливаем канал изображения…');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Не получен первый кадр за 45 секунд')), 45000);
        firstFrame.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      setScreenStatus('good', 'Экран подключён · режим только просмотра');
      showToast('Изображение Windows получено. Управление вводом пока выключено.');
    } catch (error) {
      disconnectScreen(false);
      throw error;
    }
  }

  function consumeFrameChunk(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 9) return;
    const packet = new Uint8Array(data);
    const view = new DataView(data);
    const frameId = view.getUint32(0, false);
    const chunkIndex = view.getUint16(4, false);
    const chunkCount = view.getUint16(6, false);
    if (chunkCount < 1 || chunkCount > 512 || chunkIndex >= chunkCount) return;

    let frame = frameBuffers.get(frameId);
    if (!frame) {
      frame = { count: chunkCount, parts: new Array(chunkCount), received: 0, bytes: 0 };
      frameBuffers.set(frameId, frame);
    }
    if (frame.count !== chunkCount || frame.parts[chunkIndex]) return;
    const part = packet.slice(8);
    frame.parts[chunkIndex] = part;
    frame.received += 1;
    frame.bytes += part.byteLength;

    while (frameBuffers.size > 3) {
      const oldestId = frameBuffers.keys().next().value;
      frameBuffers.delete(oldestId);
    }
    if (frame.received !== frame.count) return;

    const jpeg = new Uint8Array(frame.bytes);
    let offset = 0;
    for (const chunk of frame.parts) {
      jpeg.set(chunk, offset);
      offset += chunk.byteLength;
    }
    frameBuffers.delete(frameId);
    if (latestFrameUrl) URL.revokeObjectURL(latestFrameUrl);
    latestFrameUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
    screenFrame.src = latestFrameUrl;
    screenFrame.hidden = false;
    screenPlaceholder.hidden = true;
    if (firstFrameResolver) {
      firstFrameResolver();
      firstFrameResolver = null;
      firstFrameRejecter = null;
    }
  }

  function disconnectScreen(showStatus = true) {
    frameBuffers.clear();
    if (activeDataChannel) {
      try { activeDataChannel.close(); } catch { /* already closed */ }
      activeDataChannel = null;
    }
    if (activePeerConnection) {
      try { activePeerConnection.close(); } catch { /* already closed */ }
      activePeerConnection = null;
    }
    firstFrameResolver = null;
    if (firstFrameRejecter) {
      firstFrameRejecter(new Error('Предпросмотр отключён'));
      firstFrameRejecter = null;
    }
    if (latestFrameUrl) {
      URL.revokeObjectURL(latestFrameUrl);
      latestFrameUrl = null;
    }
    screenFrame.removeAttribute('src');
    screenFrame.hidden = true;
    screenPlaceholder.hidden = false;
    disconnectButton.disabled = true;
    if (showStatus) setScreenStatus('idle', 'Просмотр отключён');
  }

  disconnectButton.addEventListener('click', () => {
    disconnectScreen(true);
    setPairStatus('idle', 'Просмотр отключён на этом iPhone. Для нового сеанса создай новый код на Windows.');
    pairCodeInput.value = '';
    pairButton.disabled = false;
    pairButton.textContent = 'Запросить сопряжение';
    showToast('Просмотр отключён на iPhone. Останови Host на Windows, чтобы закрыть его сторону.');
  });

  window.addEventListener('pagehide', () => disconnectScreen(false));
})();
