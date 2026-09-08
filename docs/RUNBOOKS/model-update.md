# Runbook: updating the model

Applies to `ENGINE_MODE=llama-cpp` deployments. Swapping a model file is
the one place CLAUDE.md non-negotiable #12 ("fail closed on ... unsafe
model manifests") is entirely operator-enforced today - `power-node`
itself does not (yet - see `docs/ARCHITECTURE.md`'s follow-ups) validate
what llama.cpp loads. Follow this procedure rather than replacing the
live model file in place.

## 1. Download and verify

```bash
sudo -u llama-cpp mkdir -p /opt/llama-cpp/models/staging
cd /opt/llama-cpp/models/staging
sudo -u llama-cpp curl -fL -o new-model.gguf "<source URL>"

# verify against a checksum YOU obtained from the model's original,
# trusted source - not one shipped alongside the download itself.
echo "<expected-sha256>  new-model.gguf" | sudo -u llama-cpp sha256sum -c -
```

**Do not proceed past a checksum mismatch.** Re-download from the
original source; if it mismatches again, treat the file as untrusted and
do not load it.

## 2. Validate on a side port before touching production

Run a second, temporary llama.cpp instance on a different port so the
live one keeps serving traffic during validation:

```bash
sudo -u llama-cpp /opt/llama-cpp/server \
  --host 127.0.0.1 --port 8091 \
  -m /opt/llama-cpp/models/staging/new-model.gguf \
  -c 4096 -t 8 &
STAGING_PID=$!

sleep 5
curl -s http://127.0.0.1:8091/health

# one real prompt end to end, exactly the shape power-node sends
curl -s http://127.0.0.1:8091/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local-model","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":32,"stream":false}'

kill "$STAGING_PID"
```

Confirm the response is coherent output, not an error body or empty
`choices`. Record the model file, its checksum, and the llama.cpp build
version somewhere durable (a deployment log, a comment in your infra
repo) - this is your record for the rollback step below and for
`docs/MONITORING.md`'s "record model and engine version" note.

## 3. Switch

Use a symlink so the switch (and rollback) is a single atomic operation,
not a file copy that could be interrupted mid-write:

```bash
sudo -u llama-cpp mv /opt/llama-cpp/models/staging/new-model.gguf /opt/llama-cpp/models/
sudo -u llama-cpp ln -sfn /opt/llama-cpp/models/new-model.gguf /opt/llama-cpp/models/current.gguf.new
sudo -u llama-cpp mv -T /opt/llama-cpp/models/current.gguf.new /opt/llama-cpp/models/current.gguf

sudo systemctl restart llama-cpp.service
```

(If `llama-cpp.service`'s `ExecStart` already points at
`current.gguf` per the example unit, this is the only restart needed -
`power-node.service` itself never needs to restart for a model change,
per [`engine-restart.md`](engine-restart.md).)

## 4. Verify in production

```bash
curl -s http://127.0.0.1:8090/health
curl -s http://127.0.0.1:8080/internal/health   # engine.ready: true, circuitState: "closed"
```

Then one real generation through the actual application, not just the
engine directly:

```bash
curl -s -N -X POST http://127.0.0.1:8080/generate \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(cat /proc/sys/kernel/random/uuid)" \
  -d '{"prompt":"Say hello in one sentence.","maxTokens":32}'
```

Confirm the SSE stream ends in `run.completed` with coherent `output`,
not `run.failed`.

## 5. Rollback

If validation in step 2 fails, simply don't proceed to step 3 - the live
model was never touched.

If a problem surfaces only after step 3 (production traffic reveals an
issue validation didn't catch), the previous model file is still on disk
(you only moved the *new* one into place) - swap the symlink back:

```bash
sudo -u llama-cpp ln -sfn /opt/llama-cpp/models/<previous-model-filename>.gguf /opt/llama-cpp/models/current.gguf.new
sudo -u llama-cpp mv -T /opt/llama-cpp/models/current.gguf.new /opt/llama-cpp/models/current.gguf
sudo systemctl restart llama-cpp.service
curl -s http://127.0.0.1:8090/health
```

Keep at least the last known-good model file on disk at all times for
exactly this reason - do not delete a previous model until its
replacement has run in production for a reasonable soak period.
