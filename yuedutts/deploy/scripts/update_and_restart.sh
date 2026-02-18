#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
REQ_FILE="${ROOT_DIR}/app/requirements.txt"
PID_FILE="${ROOT_DIR}/.uvicorn-18080.pid"
LOG_FILE="${ROOT_DIR}/uvicorn-18080.log"
HOST="${UVICORN_HOST:-0.0.0.0}"
PORT="${UVICORN_PORT:-18080}"
APP="${UVICORN_APP:-app.main:app}"
RELOAD="${UVICORN_RELOAD:-0}"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "missing python in ${VENV_DIR}, please create .venv first" >&2
  exit 1
fi

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "requirements file not found: ${REQ_FILE}" >&2
  exit 1
fi

echo "[1/3] updating dependencies in .venv"
"${VENV_DIR}/bin/python" -m pip install -U pip
"${VENV_DIR}/bin/python" -m pip install -r "${REQ_FILE}"

echo "[2/3] stopping old uvicorn"
if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
    kill "${old_pid}" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "${old_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${PID_FILE}"
fi

pkill -f "${VENV_DIR}/bin/python -m uvicorn ${APP}" >/dev/null 2>&1 || true
# Best effort: kill any process still listening on target port.
if command -v ss >/dev/null 2>&1; then
  port_pids="$(ss -ltnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $NF}' | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)"
  if [[ -n "${port_pids}" ]]; then
    kill ${port_pids} >/dev/null 2>&1 || true
    sleep 1
    kill -9 ${port_pids} >/dev/null 2>&1 || true
  fi
fi

echo "[3/3] starting uvicorn"
cd "${ROOT_DIR}"
uvicorn_args=(--host "${HOST}" --port "${PORT}")
if [[ "${RELOAD}" == "1" ]]; then
  uvicorn_args+=(--reload)
fi

setsid "${VENV_DIR}/bin/python" -m uvicorn "${APP}" "${uvicorn_args[@]}" >"${LOG_FILE}" 2>&1 < /dev/null &
new_pid="$!"
echo "${new_pid}" > "${PID_FILE}"

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "service started: http://127.0.0.1:${PORT} pid=${new_pid}"
    exit 0
  fi
  sleep 1
done

echo "service failed to become healthy, check ${LOG_FILE}" >&2
exit 1
