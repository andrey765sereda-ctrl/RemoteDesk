# Быстрый запуск RemoteDesk (текущая конфигурация)

## Видеопоток

На сайте уже настроен MediaMTX URL:

`https://flygribbpc.tail28d1f0.ts.net/remotedesk`

Плеер автоматически открывается встроенно на странице GitHub Pages. Чтобы WebRTC видео работало через мобильный интернет, Tailscale должен быть подключён на Windows и iPhone. OBS должен публиковать поток в MediaMTX path `remotedesk` (WHIP URL на Windows обычно `http://127.0.0.1:8889/remotedesk/whip`). Конфигурация MediaMTX должна объявлять Tailscale IP `100.95.87.21` в `webrtcAdditionalHosts` и слушать UDP 8189.

## Worker

Worker API: `https://remotedesk-api.andrey-765-sereda.workers.dev`. После изменения Worker:

```powershell
cd D:\Projects\RemoteDesk\worker
npm.cmd install
npm.cmd run typecheck
npx.cmd wrangler deploy
```

## Host

```powershell
cd D:\Projects\RemoteDesk\windows-host
$env:REMOTEDESK_API_URL = \"https://remotedesk-api.andrey-765-sereda.workers.dev\"
cargo run
```

Введите новый код сопряжения на сайте и подтвердите его в терминале Windows. Управление доступно только в подтверждённой сессии.

## Обновление GitHub Pages

Скопируй архив поверх локального проекта, но не удаляй `.git`. Затем:

```powershell
cd D:\Projects\RemoteDesk
git add -A
git status
git commit -m \"Preconfigure inline MediaMTX viewer\"
git push origin main
```

Перед коммитом проверь, что `windows-host/target/` и `worker/node_modules/` не включены. Дождись успешного GitHub Actions.
