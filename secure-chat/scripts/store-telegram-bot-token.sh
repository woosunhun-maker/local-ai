#!/bin/zsh

set -euo pipefail
unsetopt XTRACE VERBOSE GLOBAL_EXPORT
umask 077

typeset -gr CONFIGURATOR="${0:A:h}/configure-telegram-general.mjs"
typeset -gr TELEGRAM_TOKEN_PATTERN='^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{30,128}$'

# Always create a fresh, non-exported shell parameter. An inherited environment
# value with the same name must never become an alternate input channel.
unset telegram_bot_token_input 2>/dev/null || true
typeset -g telegram_bot_token_input=""

cleanup() {
  unset telegram_bot_token_input
  exec 3>&- 2>/dev/null || true
}

on_signal() {
  exit 130
}

trap cleanup EXIT
trap on_signal HUP INT TERM

if (( $# != 0 )); then
  builtin printf '이 도구는 명령줄 인수를 받지 않습니다.\n' >&2
  exit 64
fi

if [[ ! -r "${CONFIGURATOR}" ]]; then
  builtin printf 'Telegram 로컬 설정 도구를 찾을 수 없어 변경하지 않았습니다.\n' >&2
  exit 1
fi

open_controlling_terminal() {
  exec 3<>/dev/tty
}

if ! open_controlling_terminal 2>/dev/null; then
  builtin printf '대화형 로컬 터미널을 열 수 없어 변경하지 않았습니다.\n' >&2
  exit 1
fi

builtin printf '새 Telegram 봇 토큰을 붙여넣으세요(입력은 표시되지 않음): ' >&3
if ! IFS= read -r -s telegram_bot_token_input <&3; then
  builtin printf '\n' >&3
  builtin printf 'Telegram 토큰 입력에 실패해 변경하지 않았습니다.\n' >&2
  exit 1
fi
builtin printf '\n' >&3

if [[ ! "${telegram_bot_token_input}" =~ ${TELEGRAM_TOKEN_PATTERN} ]]; then
  builtin printf 'Telegram 봇 토큰 형식이 올바르지 않아 변경하지 않았습니다.\n' >&2
  exit 1
fi

# The token is encoded safely because its validated alphabet cannot contain a
# JSON quote, backslash, control character, or whitespace. It is sent only on
# stdin; the child argv is fixed and contains only the configurator path.
if builtin printf '{"botToken":"%s"}\n' "${telegram_bot_token_input}" | \
  /opt/homebrew/bin/node "${CONFIGURATOR}" >/dev/null 2>&1; then
  builtin printf 'Telegram 토큰 교체와 로컬 설정 검증이 완료되었습니다.\n'
else
  builtin printf 'Telegram 설정에 실패했습니다. 기존 설정은 안전 복원을 시도했으며 비밀값은 표시하지 않았습니다.\n' >&2
  exit 1
fi
