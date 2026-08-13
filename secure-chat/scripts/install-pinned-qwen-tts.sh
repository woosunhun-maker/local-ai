#!/bin/zsh
set -euo pipefail

# IMPORTANT: Run only after the user approves the pinned external download.
readonly PRIVATE_ROOT="/Users/hun/PrivateAI"
readonly KERNEL_LOCK_HELPER="/Users/hun/Documents/로컬ai/secure-chat/scripts/kernel-lock.zsh"
readonly TTS_INSTALL_LOCK="${PRIVATE_ROOT}/tmp/qwen-tts-install.lock"
readonly RUNTIME_ROOT="${PRIVATE_ROOT}/runtime/tts"
readonly MODEL_ROOT="${PRIVATE_ROOT}/models/tts"
readonly PRIVATE_TMP="${PRIVATE_ROOT}/tmp/tts"
readonly INSTALL_NAME="qwen3-tts-1.7b-6bit-5fac1de"
readonly RUNTIME_PATH="${RUNTIME_ROOT}/${INSTALL_NAME}"
readonly VENV_PATH="${RUNTIME_PATH}/venv"
readonly MODEL_PATH="${MODEL_ROOT}/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit-1c6c0ff"
readonly PYTHON_BIN="/opt/homebrew/opt/python@3.11/bin/python3.11"
readonly PYTHON_VERSION="3.11.15"
readonly SANDBOX_EXECUTABLE="/usr/bin/sandbox-exec"
readonly WORKER_SOURCE="/Users/hun/Documents/로컬ai/secure-chat/scripts/tts-worker.py"
readonly WORKER_SHA256="8251cbbb05812b3c549b97664ec8205b61160119cadd70bc15830bbd65ccf797"
readonly SANDBOX_PROFILE_SOURCE="/Users/hun/Documents/로컬ai/secure-chat/scripts/deny-network.sb"
readonly SANDBOX_PROFILE_SHA256="aa8c0c3d0e784654f2102d38156fcb130dbf652d42559a6a2ae83432952ff4ea"
readonly INSTALL_SANDBOX_PROFILE="/Users/hun/Documents/로컬ai/secure-chat/scripts/install-network.sb"
readonly INSTALL_SANDBOX_PROFILE_SHA256="08bc56e7cbde583bbb61f7d79d9bc526d2c9c17cd3b31bcb4d419a2842bce14d"
readonly MLX_AUDIO_REVISION="5fac1de4e29a38e3d1e73b9ad94ae2dae616d151"
readonly MODEL_REVISION="1c6c0ff58c43afa8df571facde2efa077efd85e2"
readonly MODEL_REPOSITORY="mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit"
readonly HUGGINGFACE_HUB_VERSION="1.26.0"
readonly RUNTIME_MANIFEST="${PRIVATE_ROOT}/config/tts-runtime.json"

if [[ ! -f "$KERNEL_LOCK_HELPER" ]]; then
  print -u2 "커널 잠금 도우미를 찾지 못했습니다."
  exit 1
fi
source "$KERNEL_LOCK_HELPER"
if ! local_ai_kernel_lock_acquire "$TTS_INSTALL_LOCK"; then
  print -u2 "다른 TTS 설치 작업이 실행 중이거나 잠금 경계가 안전하지 않습니다."
  exit 1
fi

stage_runtime=""
stage_model=""
manifest_temp=""
created_runtime=0
created_model=0
installation_complete=0

cleanup() {
  local exit_code=$?
  if [[ -n "$stage_runtime" && "$stage_runtime" == "${RUNTIME_ROOT}/.install-"* && -d "$stage_runtime" ]]; then
    /bin/rm -rf -- "$stage_runtime"
  fi
  if [[ -n "$stage_model" && "$stage_model" == "${MODEL_ROOT}/.install-"* && -d "$stage_model" ]]; then
    /bin/rm -rf -- "$stage_model"
  fi
  if [[ -n "$manifest_temp" && "$manifest_temp" == "${PRIVATE_ROOT}/config/.tts-runtime."* && -f "$manifest_temp" ]]; then
    /bin/rm -f -- "$manifest_temp"
  fi
  if (( exit_code != 0 && installation_complete == 0 )); then
    if (( created_runtime == 1 )) && [[ -d "$RUNTIME_PATH" ]]; then /bin/rm -rf -- "$RUNTIME_PATH"; fi
    if (( created_model == 1 )) && [[ -d "$MODEL_PATH" ]]; then /bin/rm -rf -- "$MODEL_PATH"; fi
  fi
  return $exit_code
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

if [[ ! -x "$PYTHON_BIN" || ! -x "$SANDBOX_EXECUTABLE" || ! -f "$WORKER_SOURCE" || ! -f "$SANDBOX_PROFILE_SOURCE" || ! -f "$INSTALL_SANDBOX_PROFILE" ]]; then
  print -u2 "고정 TTS 실행 파일을 찾지 못했습니다."
  exit 1
fi
if [[ "$($PYTHON_BIN -c 'import platform; print(platform.python_version())')" != "$PYTHON_VERSION" ]]; then
  print -u2 "승인된 Python ${PYTHON_VERSION}과 설치된 버전이 다릅니다."
  exit 1
fi
if [[ "$(/usr/bin/shasum -a 256 "$WORKER_SOURCE" | /usr/bin/awk '{print $1}')" != "$WORKER_SHA256" ]]; then
  print -u2 "고정 TTS worker 해시가 달라 설치를 중단했습니다."
  exit 1
fi
if [[ "$(/usr/bin/shasum -a 256 "$SANDBOX_PROFILE_SOURCE" | /usr/bin/awk '{print $1}')" != "$SANDBOX_PROFILE_SHA256" ]]; then
  print -u2 "고정 TTS sandbox profile 해시가 달라 설치를 중단했습니다."
  exit 1
fi
if [[ "$(/usr/bin/shasum -a 256 "$INSTALL_SANDBOX_PROFILE" | /usr/bin/awk '{print $1}')" != "$INSTALL_SANDBOX_PROFILE_SHA256" ]]; then
  print -u2 "고정 TTS install sandbox profile 해시가 달라 설치를 중단했습니다."
  exit 1
fi
if [[ -e "$RUNTIME_PATH" || -e "$MODEL_PATH" || -e "$RUNTIME_MANIFEST" ]]; then
  print -u2 "기존 TTS 설치가 있어 덮어쓰지 않았습니다. 먼저 상태를 점검하세요."
  exit 1
fi

/bin/mkdir -p "$RUNTIME_ROOT" "$MODEL_ROOT" "${PRIVATE_ROOT}/config" \
  "$PRIVATE_TMP/home" "$PRIVATE_TMP/tmp" "$PRIVATE_TMP/cache" "$PRIVATE_TMP/huggingface"
/bin/chmod 700 "$RUNTIME_ROOT" "$MODEL_ROOT" "${PRIVATE_ROOT}/config" "$PRIVATE_TMP" \
  "$PRIVATE_TMP/home" "$PRIVATE_TMP/tmp" "$PRIVATE_TMP/cache" "$PRIVATE_TMP/huggingface"
stage_runtime="$(/usr/bin/mktemp -d "${RUNTIME_ROOT}/.install-${INSTALL_NAME}.XXXXXX")"
stage_model="$(/usr/bin/mktemp -d "${MODEL_ROOT}/.install-${INSTALL_NAME}.XXXXXX")"
/bin/chmod 700 "$stage_runtime" "$stage_model"
cd "$PRIVATE_TMP"

"$PYTHON_BIN" -m venv --copies "${stage_runtime}/venv"
/usr/bin/env -i \
  PATH="${stage_runtime}/venv/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="${PRIVATE_TMP}/home" \
  TMPDIR="${PRIVATE_TMP}/tmp/" \
  XDG_CACHE_HOME="${PRIVATE_TMP}/cache" \
  HF_HOME="${PRIVATE_TMP}/huggingface" \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PYTHONNOUSERSITE=1 \
  "$SANDBOX_EXECUTABLE" -f "$INSTALL_SANDBOX_PROFILE" \
  "${stage_runtime}/venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
    "mlx-audio @ git+https://github.com/Blaizzy/mlx-audio.git@${MLX_AUDIO_REVISION}" \
    "huggingface_hub[hf_xet]==${HUGGINGFACE_HUB_VERSION}"
/usr/bin/env -i \
  PATH="${stage_runtime}/venv/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="${PRIVATE_TMP}/home" TMPDIR="${PRIVATE_TMP}/tmp/" XDG_CACHE_HOME="${PRIVATE_TMP}/cache" \
  PYTHONNOUSERSITE=1 \
  "$SANDBOX_EXECUTABLE" -f "$INSTALL_SANDBOX_PROFILE" \
  "${stage_runtime}/venv/bin/python" -m pip check
/usr/bin/env -i \
  PATH="${stage_runtime}/venv/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="${PRIVATE_TMP}/home" TMPDIR="${PRIVATE_TMP}/tmp/" XDG_CACHE_HOME="${PRIVATE_TMP}/cache" \
  PYTHONNOUSERSITE=1 \
  "$SANDBOX_EXECUTABLE" -f "$INSTALL_SANDBOX_PROFILE" \
  "${stage_runtime}/venv/bin/python" -m pip freeze --all > "${stage_runtime}/PINNED_PACKAGES.txt"
/bin/cp "$WORKER_SOURCE" "${stage_runtime}/tts-worker.py"
/bin/cp "$SANDBOX_PROFILE_SOURCE" "${stage_runtime}/deny-network.sb"
/bin/chmod 700 "${stage_runtime}/tts-worker.py"

/usr/bin/env -i \
  LOCAL_AI_MODEL_REPOSITORY="$MODEL_REPOSITORY" \
  LOCAL_AI_MODEL_REVISION="$MODEL_REVISION" \
  LOCAL_AI_MODEL_PATH="$stage_model" \
  PATH="${stage_runtime}/venv/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="${PRIVATE_TMP}/home" TMPDIR="${PRIVATE_TMP}/tmp/" XDG_CACHE_HOME="${PRIVATE_TMP}/cache" \
  HF_HOME="${PRIVATE_TMP}/huggingface" PYTHONNOUSERSITE=1 \
  "$SANDBOX_EXECUTABLE" -f "$INSTALL_SANDBOX_PROFILE" \
  "${stage_runtime}/venv/bin/python" - <<'PY'
import os
import shutil
from pathlib import Path
from huggingface_hub import snapshot_download

model_path = Path(os.environ["LOCAL_AI_MODEL_PATH"])
snapshot_download(
    repo_id=os.environ["LOCAL_AI_MODEL_REPOSITORY"],
    revision=os.environ["LOCAL_AI_MODEL_REVISION"],
    local_dir=model_path,
)
cache_path = model_path / ".cache"
if cache_path.exists():
    shutil.rmtree(cache_path)
PY

# The smoke probe must fail closed: no sockets, no reads from the user's Documents,
# and no writes outside the dedicated non-synchronised TTS temp directory.
(
  cd "$PRIVATE_TMP"
  /usr/bin/env -i \
    PATH="${stage_runtime}/venv/bin" \
    HOME="${PRIVATE_TMP}/home" \
    TMPDIR="${PRIVATE_TMP}/tmp/" \
    XDG_CACHE_HOME="${PRIVATE_TMP}/cache" \
    HF_HOME="${PRIVATE_TMP}/huggingface" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    "$SANDBOX_EXECUTABLE" -f "${stage_runtime}/deny-network.sb" \
    "${stage_runtime}/venv/bin/python" -I - <<'PY'
import errno
import os
import socket
from pathlib import Path

def must_be_denied(action):
    try:
        action()
    except OSError as error:
        if error.errno not in {errno.EPERM, errno.EACCES}:
            raise
    else:
        raise RuntimeError("sandbox boundary is not enforced")

must_be_denied(lambda: socket.socket().bind(("127.0.0.1", 0)))
must_be_denied(lambda: os.listdir("/Users/hun/Documents"))
must_be_denied(lambda: Path("/Users/hun/PrivateAI/config/.tts-write-probe").write_text("blocked"))
probe = Path(os.environ["TMPDIR"]) / "write-probe"
probe.write_text("private", encoding="utf-8")
probe.unlink()
PY
)

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 LOCAL_AI_TTS_MODEL_PATH="$stage_model" \
PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 HOME="${PRIVATE_TMP}/home" \
TMPDIR="${PRIVATE_TMP}/tmp/" XDG_CACHE_HOME="${PRIVATE_TMP}/cache" HF_HOME="${PRIVATE_TMP}/huggingface" \
  "$SANDBOX_EXECUTABLE" -f "${stage_runtime}/deny-network.sb" \
  "${stage_runtime}/venv/bin/python" -I -c \
  'from mlx_audio.tts.utils import load_model; model = load_model(__import__("os").environ["LOCAL_AI_TTS_MODEL_PATH"]); assert model.sample_rate == 24000; assert "sohee" in {x.lower() for x in model.get_supported_speakers()}'

LOCAL_AI_MODEL_PATH="$stage_model" "$PYTHON_BIN" - <<'PY'
import hashlib
import os
from pathlib import Path

model_path = Path(os.environ["LOCAL_AI_MODEL_PATH"]).resolve(strict=True)
entries = []
for path in sorted(model_path.rglob("*")):
    if path.is_symlink():
        raise RuntimeError("model symlink rejected")
    if not path.is_file() or path.name == "LOCAL_AI_FILES.sha256":
        continue
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    entries.append(f"{digest.hexdigest()}  {path.relative_to(model_path).as_posix()}")
(model_path / "LOCAL_AI_FILES.sha256").write_text("\n".join(entries) + "\n", encoding="utf-8")
PY

/bin/chmod -R go-rwx "$stage_runtime" "$stage_model"
LOCAL_AI_RUNTIME_PATH="$stage_runtime" "$PYTHON_BIN" - <<'PY'
import hashlib
import json
import os
import stat
from pathlib import Path

root = Path(os.environ["LOCAL_AI_RUNTIME_PATH"]).resolve(strict=True)
files = []
for path in sorted(root.rglob("*")):
    if path.name == "LOCAL_AI_RUNTIME_FILES.json":
        continue
    if path.is_symlink():
        raise RuntimeError("runtime symlink rejected")
    if not path.is_file():
        continue
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    files.append({
        "path": path.relative_to(root).as_posix(),
        "sha256": digest.hexdigest(),
        "mode": stat.S_IMODE(path.stat().st_mode),
    })
content = json.dumps({"version": 1, "files": files}, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"
(root / "LOCAL_AI_RUNTIME_FILES.json").write_text(content, encoding="utf-8")
PY
/bin/chmod 600 "${stage_runtime}/LOCAL_AI_RUNTIME_FILES.json" "${stage_model}/LOCAL_AI_FILES.sha256"

/bin/mv "$stage_model" "$MODEL_PATH"
stage_model=""
created_model=1
/bin/mv "$stage_runtime" "$RUNTIME_PATH"
stage_runtime=""
created_runtime=1

manifest_temp="$(/usr/bin/mktemp "${PRIVATE_ROOT}/config/.tts-runtime.XXXXXX")"
LOCAL_AI_RUNTIME_PATH="$RUNTIME_PATH" \
LOCAL_AI_MODEL_PATH="$MODEL_PATH" \
LOCAL_AI_RUNTIME_MANIFEST="$manifest_temp" \
LOCAL_AI_PYTHON_VERSION="$PYTHON_VERSION" \
LOCAL_AI_MLX_AUDIO_REVISION="$MLX_AUDIO_REVISION" \
LOCAL_AI_MODEL_REVISION="$MODEL_REVISION" \
LOCAL_AI_MODEL_REPOSITORY="$MODEL_REPOSITORY" \
"$PYTHON_BIN" - <<'PY'
import hashlib
import json
import os
from pathlib import Path

def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()

runtime = Path(os.environ["LOCAL_AI_RUNTIME_PATH"]).resolve(strict=True)
model = Path(os.environ["LOCAL_AI_MODEL_PATH"]).resolve(strict=True)
python_path = runtime / "venv/bin/python"
worker_path = runtime / "tts-worker.py"
sandbox_profile = runtime / "deny-network.sb"
runtime_files = runtime / "LOCAL_AI_RUNTIME_FILES.json"
model_files = model / "LOCAL_AI_FILES.sha256"
manifest = {
    "version": 2,
    "runtime": {
        "rootPath": str(runtime),
        "pythonPath": str(python_path),
        "pythonVersion": os.environ["LOCAL_AI_PYTHON_VERSION"],
        "pythonSha256": sha256(python_path),
        "workerPath": str(worker_path),
        "workerSha256": sha256(worker_path),
        "sandboxExecutable": "/usr/bin/sandbox-exec",
        "sandboxProfilePath": str(sandbox_profile),
        "sandboxProfileSha256": sha256(sandbox_profile),
        "filesManifestSha256": sha256(runtime_files),
        "privateTmpPath": "/Users/hun/PrivateAI/tmp/tts",
        "mlxAudioRevision": os.environ["LOCAL_AI_MLX_AUDIO_REVISION"],
    },
    "model": {
        "repository": os.environ["LOCAL_AI_MODEL_REPOSITORY"],
        "revision": os.environ["LOCAL_AI_MODEL_REVISION"],
        "localPath": str(model),
        "filesManifestSha256": sha256(model_files),
    },
}
Path(os.environ["LOCAL_AI_RUNTIME_MANIFEST"]).write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
/bin/chmod 600 "$manifest_temp"
/bin/mv "$manifest_temp" "$RUNTIME_MANIFEST"
manifest_temp=""
installation_complete=1
print "고정 Qwen3-TTS 런타임 설치와 오프라인 샌드박스 검증을 완료했습니다."
