(() => {
  const apiInput = document.querySelector('#api-url');
  const saveButton = document.querySelector('#save-url');
  const checkButton = document.querySelector('#check-button');
  const statusText = document.querySelector('#status-text');
  const statusIndicator = document.querySelector('#status-indicator');
  const toast = document.querySelector('#toast');
  let apiBase = '';
  let toastTimeout;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function setStatus(kind, message) {
    statusIndicator.className = `status-indicator ${kind}`;
    statusText.textContent = message;
  }

  saveButton.addEventListener('click', () => {
    const raw = apiInput.value.trim().replace(/\/$/, '');
    if (!raw) {
      apiBase = '';
      showToast('Введи URL Cloudflare Worker.');
      return;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        throw new Error('HTTPS required');
      }
      apiBase = parsed.origin;
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
      showToast('Cloudflare Worker отвечает. Windows Host пока проверяется отдельно.');
    } catch (error) {
      setStatus('bad', 'Не удалось подключиться к API');
      showToast(`Ошибка проверки: ${error.message || 'сетевая ошибка'}`);
    } finally {
      checkButton.disabled = false;
      checkButton.textContent = 'Проверить API';
    }
  });
})();
