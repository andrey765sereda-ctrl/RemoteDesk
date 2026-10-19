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
  let firstFrameResolver = null;
  let firstFrameRejecter = null;

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
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        mode: 'cors',
      });
    } catch (cause) {
      const detail = cause && cause.message ? cause.message : String(cause || 'network error');
      throw new Error(`${path}: не удалось выполнить запрос (${detail}). Проверь интернет, адрес API и CORS.`);
    }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(`${path}: ${data.message || data.error || `HTTP ${response.status}`}`);
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
      const detail = error && error.message ? error.message : 'ошибка сети';
      setPairStatus('bad', `Подключение не удалось: ${detail}`);
      setScreenStatus('bad', `Не удалось начать предпросмотр: ${detail}`);
      showToast(`Ошибка подключения: ${detail}`);
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
        console.info('[RemoteDesk] ICE gathering state:', pc.iceGatheringState);
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(() => finish(new Error(`Истекло время сбора ICE-кандидатов; состояние=${pc.iceGatheringState}`)), timeoutMs);
      pc.addEventListener('icegatheringstatechange', check);
      check();
    });
  }

  function summarizeSdpCandidates(sdp) {
    const lines = String(sdp || '').split(/\r?\n/).filter(line => line.startsWith('a=candidate:'));
    const count = type => lines.filter(line => line.includes(` typ ${type}`)).length;
    return `host=${count('host')}, srflx=${count('srflx')}, relay=${count('relay')}, total=${lines.length}`;
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
    setScreenStatus('waiting', 'Создаём защищённый WebRTC-видеоканал…');
    disconnectButton.disabled = true;

    // Direct peer-to-peer transport only; deliberately no TURN server is configured.
    const rtcConfiguration = {
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
      iceTransportPolicy: 'all'
    };
    setScreenStatus('waiting', 'Режим STUN-only: устанавливаем прямое соединение…');
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
    firstFrame.catch(() => {});

    const markVideoReady = () => {
      if (screenFrame.videoWidth <= 0 || screenFrame.videoHeight <= 0) return;
      setScreenStatus('good', `H.264-видеопоток · ${screenFrame.videoWidth}×${screenFrame.videoHeight}`);
      disconnectButton.disabled = false;
      if (firstFrameResolver) {
        const resolve = firstFrameResolver;
        firstFrameResolver = null;
        firstFrameRejecter = null;
        resolve();
      }
    };

    screenFrame.autoplay = true;
    screenFrame.playsInline = true;
    screenFrame.muted = true;
    screenFrame.controls = true;
    screenFrame.onloadeddata = markVideoReady;
    screenFrame.onplaying = markVideoReady;

    pc.ontrack = event => {
      if (event.track.kind !== 'video') return;
      console.info('[RemoteDesk] Remote video track received:', event.track.kind, event.track.id);
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      screenFrame.srcObject = stream;
      screenFrame.hidden = false;
      screenPlaceholder.hidden = true;
      screenFrame.play().catch(error => {
        console.warn('[RemoteDesk] Video autoplay was blocked; use the play control on the video:', error);
        setScreenStatus('waiting', 'Видеопоток получен. Нажми ▶ на видео, если Safari не начал воспроизведение автоматически.');
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connecting') setScreenStatus('waiting', 'Соединяем устройства…');
      if (state === 'connected' && screenFrame.videoWidth === 0) {
        setScreenStatus('waiting', 'Канал установлен. Ожидаем первый H.264-кадр…');
      }
      if (state === 'failed') {
        setScreenStatus('bad', 'WebRTC не подключился. STUN-only не использует ретранслятор; проверь ICE и сетевые ограничения.');
        if (firstFrameRejecter) firstFrameRejecter(new Error('WebRTC-соединение завершилось ошибкой'));
      }
      if (state === 'disconnected') setScreenStatus('waiting', 'Связь временно потеряна…');
      if (state === 'closed') setScreenStatus('idle', 'Просмотр отключён');
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.info('[RemoteDesk] ICE state:', state);
      if (state === 'checking') setScreenStatus('waiting', 'Проверяем сетевые маршруты ICE…');
      if (state === 'connected' || state === 'completed') setScreenStatus('waiting', 'Сетевой канал установлен. Ожидаем H.264-видеопоток…');
      if (state === 'disconnected') setScreenStatus('waiting', 'ICE временно отключён. Проверяем восстановление…');
      if (state === 'failed') setScreenStatus('bad', 'ICE failed: прямой маршрут не найден. TURN выключен; проверь сеть и Windows Firewall.');
    };
    pc.onicecandidateerror = event => {
      console.warn('[RemoteDesk] ICE candidate error:', event.errorCode, event.errorText, event.url);
    };

    let stage = 'получение WebRTC-предложения от Windows';
    try {
      console.info('[RemoteDesk] Stage:', stage);
      const offer = await waitForHostOffer(sessionId, clientToken);
      if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || !offer.sdp.length) {
        throw new Error('Worker вернул некорректное WebRTC-предложение: ожидался объект {type:"offer", sdp:"…"}');
      }
      if (!offer.sdp.toLowerCase().includes('h264')) {
        throw new Error('Windows Host не предложил кодек H.264. Проверь версию windows-host.');
      }
      console.info('[RemoteDesk] Offer received:', { type: offer.type, sdpLength: offer.sdp.length, candidates: summarizeSdpCandidates(offer.sdp) });

      stage = 'применение WebRTC-предложения';
      setScreenStatus('waiting', 'Применяем предложение H.264…');
      await pc.setRemoteDescription(offer);

      stage = 'выбор H.264 для видеопотока';
      const receiverCapabilities = window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities
        ? RTCRtpReceiver.getCapabilities('video')
        : null;
      const h264Codecs = receiverCapabilities && receiverCapabilities.codecs
        ? receiverCapabilities.codecs.filter(codec => {
            const mime = String(codec.mimeType || '').toLowerCase();
            return mime === 'video/h264';
          })
        : [];
      if (!h264Codecs.some(codec => String(codec.mimeType || '').toLowerCase() === 'video/h264')) {
        throw new Error('Этот браузер не объявил поддержку H.264 через WebRTC. Открой RemoteDesk в Safari на iPhone.');
      }
      const videoTransceiver = pc.getTransceivers().find(transceiver => transceiver.receiver && transceiver.receiver.track.kind === 'video');
      if (videoTransceiver && typeof videoTransceiver.setCodecPreferences === 'function') {
        videoTransceiver.setCodecPreferences(h264Codecs);
      } else {
        console.warn('[RemoteDesk] setCodecPreferences is not available; browser codec preference will be used.');
      }

      stage = 'создание WebRTC-ответа';
      const answer = await pc.createAnswer();
      if (!answer || answer.type !== 'answer' || typeof answer.sdp !== 'string') {
        throw new Error('Браузер не создал корректный WebRTC-ответ');
      }

      stage = 'установка локального WebRTC-ответа';
      await pc.setLocalDescription(answer);

      stage = 'сбор ICE-кандидатов iPhone';
      setScreenStatus('waiting', 'Собираем сетевые маршруты iPhone…');
      await waitForIceGatheringComplete(pc);
      const localDescription = pc.localDescription;
      if (!localDescription || localDescription.type !== 'answer' || !localDescription.sdp) {
        throw new Error('Браузер не предоставил локальный SDP-ответ после ICE gathering');
      }
      if (!localDescription.sdp.toLowerCase().includes('h264')) {
        throw new Error('Ответ Safari не содержит согласованный H.264-кодек.');
      }
      console.info('[RemoteDesk] Local H.264 answer ready:', { type: localDescription.type, sdpLength: localDescription.sdp.length, candidates: summarizeSdpCandidates(localDescription.sdp) });

      stage = 'отправка WebRTC-ответа через Cloudflare Worker';
      setScreenStatus('waiting', 'Отправляем ответ на Windows…');
      await postApi('/api/rtc/client-answer', {
        sessionId,
        clientToken,
        description: JSON.stringify(localDescription),
      });
      console.info('[RemoteDesk] WebRTC H.264 answer published to Worker');

      stage = 'ожидание первого H.264-кадра';
      setScreenStatus('waiting', 'Ответ отправлен. Ожидаем первый H.264-кадр…');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Первый видеокадр не появился за 60 секунд; connection=${pc.connectionState}, ICE=${pc.iceConnectionState}, video=${screenFrame.videoWidth}x${screenFrame.videoHeight}`)), 60000);
        firstFrame.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      setScreenStatus('good', `Экран подключён · H.264 · ${screenFrame.videoWidth}×${screenFrame.videoHeight} · только просмотр`);
      showToast('H.264-видео Windows получено. Управление вводом пока выключено.');
    } catch (error) {
      const detail = error && error.message ? error.message : String(error || 'неизвестная ошибка');
      console.error('[RemoteDesk] Preview failed at stage:', stage, error);
      disconnectScreen(false);
      throw new Error(`${stage}: ${detail}`);
    }
  }

  function disconnectScreen(showStatus = true) {
    if (activePeerConnection) {
      try { activePeerConnection.close(); } catch { /* already closed */ }
      activePeerConnection = null;
    }
    firstFrameResolver = null;
    if (firstFrameRejecter) {
      firstFrameRejecter(new Error('Предпросмотр отключён'));
      firstFrameRejecter = null;
    }
    screenFrame.pause();
    screenFrame.srcObject = null;
    screenFrame.onloadeddata = null;
    screenFrame.onplaying = null;
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
