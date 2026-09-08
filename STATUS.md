# Статус проекта

## Сделано

Локальный inference-appliance на Fastify + SQLite + SSE-консоль, слоистая
архитектура (api/domain/db/engine/telemetry), circuit breaker + retry для
движка, реальный клиент llama.cpp (OpenAI-совместимый SSE) наряду с
mock-движком для dev/test, опциональная bearer-авторизация,
`GET /internal/health`, 100 unit + 20 интеграционных тестов, CI, лицензия
MIT. Продакшн-комплект: systemd unit (проверен), `backup.sh` (проверен на
реальной БД), logrotate, полная документация деплоя/безопасности/
мониторинга и runbook'и (backup-restore, engine-restart, model-update).

## Осталось сделать

- Проверить на настоящем сервере с реальным llama.cpp (пока проверено
  только фейковым сервером с тем же контрактом).
- Логин для консоли, если включать `API_AUTH_ENABLED` (сейчас консоль
  не умеет слать `Authorization`).
- Шифрование бэкапов at rest.
- Валидация подписи/манифеста модели (сейчас — только checksum вручную).
- `deploy.yml` (auto-deploy) — нет целевого сервера/секретов.
- `src/db/seed.ts` (dev-данные) — было опционально, не делал.
