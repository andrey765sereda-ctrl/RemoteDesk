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
  const toast = document.querySelector('#toast');
  let apiBase = DEFAULT_API_URL;
  let toastTimeout;
  let pairingInProgress = false;

  apiInput.value = DEFAULT_API_URL;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function setStatus(kind, message) {
    statusIndicator.className = `status-indicator ${kind}`;
    statusText.textContent = message;
  }

  function setPairStatus(kind, message) {
    pairStatusIndicator.className = `status-indicator ${kind}`;
    pairStatusText.textContent = message;
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
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
        mode: 'cors'
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
    const formatted = [code.slice(0, 4), code.slice(4, 8), code.slice(8, 12)].filter(Boolean).join('-');
    pairCodeInput.value = formatted;
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
      showToast('Запрос отправлен на компьютер. Не закрывай эту страницу.');

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const state = await postApi('/api/pairing/client-status', {
          sessionId: claim.sessionId,
          clientToken: claim.clientToken,
        });
        if (state.status === 'approved') {
          setPairStatus('good', 'Сопряжение подтверждено на ПК. Передача экрана пока не включена.');
          showToast('ПК подтвердил запрос. Видеопоток будет добавлен следующим этапом.');
          return;
        }
        if (state.status === 'rejected') {
          setPairStatus('bad', 'Запрос отклонён на компьютере.');
          return;
        }
        if (state.status === 'expired') {
          setPairStatus('bad', 'Код истёк. Перезапусти RemoteDesk Host и введи новый код.');
          return;
        }
        setPairStatus('waiting', 'Ожидаем подтверждения на компьютере…');
      }
      setPairStatus('bad', 'Время ожидания истекло. Создай новый код на ПК.');
    } catch (error) {
      setPairStatus('bad', `Сопряжение не удалось: ${error.message || 'ошибка сети'}`);
      showToast(`Ошибка сопряжения: ${error.message || 'ошибка сети'}`);
    } finally {
      pairingInProgress = false;
      pairButton.disabled = false;
      pairButton.textContent = 'Запросить сопряжение';
    }
  });
})();
