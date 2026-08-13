#!/usr/bin/env python3
"""Offline, persistent Qwen3-TTS worker. Protocol is private JSONL over stdio."""

import base64
import contextlib
import json
import os
import queue
import sys
import threading

PROTOCOL_STDOUT = sys.stdout
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    from mlx_audio.tts.utils import load_model


MODEL_PATH = os.environ.get("LOCAL_AI_TTS_MODEL_PATH", "")
STYLE_INSTRUCTIONS = {
    "natural": "따뜻하고 자연스러운 한국어로, 과장 없이 또렷하게 말하세요.",
    "calm": "차분하고 안정적인 한국어로, 조금 여유 있게 말하세요.",
    "concise": "명료하고 간결한 한국어로, 군더더기 없이 말하세요.",
}
commands = queue.Queue(maxsize=16)
cancelled = set()
cancel_lock = threading.Lock()
shutdown_requested = threading.Event()
output_lock = threading.Lock()


def emit(value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    with output_lock:
        PROTOCOL_STDOUT.write(encoded + "\n")
        PROTOCOL_STDOUT.flush()


def read_commands():
    try:
        for line in sys.stdin:
            try:
                value = json.loads(line)
                request_id = value.get("id")
                command_type = value.get("type")
                if command_type == "cancel" and isinstance(request_id, str):
                    with cancel_lock:
                        cancelled.add(request_id)
                elif command_type == "shutdown" and isinstance(request_id, str):
                    shutdown_requested.set()
                elif command_type == "synthesize" and isinstance(request_id, str):
                    try:
                        commands.put_nowait(value)
                    except queue.Full:
                        emit({"type": "error", "id": request_id, "code": "worker_busy"})
                else:
                    emit({"type": "protocol_error", "code": "invalid_worker_command"})
            except (json.JSONDecodeError, TypeError, AttributeError):
                emit({"type": "protocol_error", "code": "invalid_worker_command"})
    finally:
        # Parent death closes stdin. Never leave an orphan holding the MLX model.
        shutdown_requested.set()


def is_cancelled(request_id):
    with cancel_lock:
        return request_id in cancelled


def clear_cancelled(request_id):
    with cancel_lock:
        cancelled.discard(request_id)


def pcm16(audio):
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2", copy=False).tobytes()


def fix_text_tokenizer(model):
    """Apply the pinned Transformers Mistral-regex correction offline."""
    tokenizer = model.tokenizer
    if tokenizer is None or not hasattr(tokenizer, "_patch_mistral_regex"):
        raise RuntimeError("text tokenizer is unavailable")
    model.tokenizer = tokenizer._patch_mistral_regex(
        tokenizer,
        MODEL_PATH,
        is_local=True,
        init_kwargs={"fix_mistral_regex": True},
        fix_mistral_regex=True,
    )
    if getattr(model.tokenizer, "fix_mistral_regex", False) is not True:
        raise RuntimeError("text tokenizer correction failed")


def main():
    if not MODEL_PATH or not os.path.isabs(MODEL_PATH):
        emit({"type": "fatal", "code": "invalid_model_path"})
        return 2

    threading.Thread(target=read_commands, name="tts-command-reader", daemon=True).start()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            model = load_model(MODEL_PATH)
            fix_text_tokenizer(model)
        speakers = {str(value).lower() for value in model.get_supported_speakers()}
        if "sohee" not in speakers:
            emit({"type": "fatal", "code": "sohee_voice_missing"})
            return 3
    except Exception:
        emit({"type": "fatal", "code": "model_load_failed"})
        return 4

    emit({"type": "ready", "sampleRate": int(model.sample_rate), "speaker": "Sohee"})
    while not shutdown_requested.is_set():
        try:
            command = commands.get(timeout=0.25)
        except queue.Empty:
            continue
        request_id = command.get("id")
        if not isinstance(request_id, str):
            continue
        if is_cancelled(request_id):
            clear_cancelled(request_id)
            emit({"type": "cancelled", "id": request_id})
            continue
        text = command.get("text")
        style = command.get("style", "natural")
        if not isinstance(text, str) or not text.strip() or style not in STYLE_INSTRUCTIONS:
            emit({"type": "error", "id": request_id, "code": "invalid_synthesis_request"})
            continue
        try:
            sequence = 0
            with contextlib.redirect_stdout(sys.stderr):
                for result in model.generate_custom_voice(
                    text=text,
                    speaker="Sohee",
                    language="Korean",
                    instruct=STYLE_INSTRUCTIONS[style],
                    stream=True,
                    streaming_interval=0.32,
                    verbose=False,
                ):
                    if shutdown_requested.is_set() or is_cancelled(request_id):
                        break
                    audio = pcm16(result.audio)
                    if audio:
                        emit({
                            "type": "audio",
                            "id": request_id,
                            "sequence": sequence,
                            "encoding": "pcm_s16le",
                            "sampleRate": int(result.sample_rate),
                            "channels": 1,
                            "data": base64.b64encode(audio).decode("ascii"),
                        })
                        sequence += 1
            if shutdown_requested.is_set():
                return 0
            if is_cancelled(request_id):
                clear_cancelled(request_id)
                emit({"type": "cancelled", "id": request_id})
            else:
                emit({"type": "done", "id": request_id})
        except Exception:
            emit({"type": "error", "id": request_id, "code": "synthesis_failed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
