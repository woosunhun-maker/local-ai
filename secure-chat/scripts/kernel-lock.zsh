#!/bin/zsh

# Shared, fail-closed macOS kernel lock for privileged maintenance scripts.
# The caller keeps fd 9 open for the complete protected lifetime.  The lock
# file is deliberately persistent; deleting or replacing it would split the
# kernel lock domain between old and new inodes.

_local_ai_kernel_lock_validate_parent() {
  local parent_path="$1"
  local -A parent_state

  zstat -L -H parent_state -- "$parent_path" 2>/dev/null || return 1
  (( (parent_state[mode] & 8#170000) == 8#040000 )) || return 1
  (( (parent_state[mode] & 8#000777) == 8#000700 )) || return 1
  (( parent_state[uid] == EUID )) || return 1
  return 0
}

_local_ai_kernel_lock_validate_file_state() {
  local state_name="$1"
  local -A file_state

  file_state=( "${(@Pkv)state_name}" )
  (( (file_state[mode] & 8#170000) == 8#100000 )) || return 1
  (( (file_state[mode] & 8#000777) == 8#000600 )) || return 1
  (( file_state[uid] == EUID )) || return 1
  (( file_state[nlink] == 1 )) || return 1
  (( file_state[size] == 0 )) || return 1
  return 0
}

local_ai_kernel_lock_acquire() {
  if (( $# != 1 )); then
    print -u2 -- "kernel lock path is required"
    return 1
  fi

  local lock_path="$1"
  local parent_path="${lock_path:h}"
  local canonical_parent
  local opened_here=0
  local lock_status=0
  local -A path_state fd_state

  [[ "$lock_path" == /* && "$parent_path" != "$lock_path" ]] || {
    print -u2 -- "kernel lock path must be absolute"
    return 1
  }

  zmodload -F zsh/stat b:zstat 2>/dev/null || {
    print -u2 -- "zsh/stat is unavailable"
    return 1
  }
  zmodload -F zsh/system b:sysopen 2>/dev/null || {
    print -u2 -- "zsh/system is unavailable"
    return 1
  }

  _local_ai_kernel_lock_validate_parent "$parent_path" || {
    print -u2 -- "kernel lock parent is not a private 0700 directory"
    return 1
  }
  canonical_parent="${parent_path:A}"
  [[ "$canonical_parent" == "$parent_path" ]] || {
    print -u2 -- "kernel lock parent must not traverse a symlink"
    return 1
  }

  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    zstat -L -H path_state -- "$lock_path" 2>/dev/null || return 1
    _local_ai_kernel_lock_validate_file_state path_state || {
      print -u2 -- "kernel lock file has unsafe metadata"
      return 1
    }
  fi

  if zstat -H fd_state -f 9 2>/dev/null; then
    # fd 9 may be inherited by a nested maintenance script.  It is reusable
    # only when it is the exact same safe inode as the requested lock path.
    zstat -L -H path_state -- "$lock_path" 2>/dev/null || return 1
    _local_ai_kernel_lock_validate_file_state fd_state || return 1
    _local_ai_kernel_lock_validate_file_state path_state || return 1
    [[ "$fd_state[device]:$fd_state[inode]" == "$path_state[device]:$path_state[inode]" ]] || {
      print -u2 -- "fd 9 is already open for a different file"
      return 1
    }
  else
    local old_umask="$(umask)"
    umask 077
    if ! sysopen -r -w -m 0600 -o creat,nofollow -u 9 "$lock_path"; then
      umask "$old_umask"
      print -u2 -- "kernel lock file could not be opened safely"
      return 1
    fi
    umask "$old_umask"
    opened_here=1
  fi

  zstat -H fd_state -f 9 2>/dev/null || {
    (( opened_here == 0 )) || exec 9>&-
    return 1
  }
  zstat -L -H path_state -- "$lock_path" 2>/dev/null || {
    (( opened_here == 0 )) || exec 9>&-
    return 1
  }
  if ! _local_ai_kernel_lock_validate_file_state fd_state \
      || ! _local_ai_kernel_lock_validate_file_state path_state \
      || [[ "$fd_state[device]:$fd_state[inode]" != "$path_state[device]:$path_state[inode]" ]]; then
    (( opened_here == 0 )) || exec 9>&-
    print -u2 -- "kernel lock path changed while opening"
    return 1
  fi

  if /usr/bin/lockf -s -t 0 9; then
    lock_status=0
  else
    lock_status=$?
  fi
  if (( lock_status != 0 )); then
    (( opened_here == 0 )) || exec 9>&-
    if (( lock_status == 75 )); then
      print -u2 -- "another maintenance operation holds the kernel lock"
    else
      print -u2 -- "kernel lock acquisition failed closed (status ${lock_status})"
    fi
    return 1
  fi

  # Re-check the parent and exact path after the kernel has granted the lock.
  if ! _local_ai_kernel_lock_validate_parent "$parent_path"; then
    (( opened_here == 0 )) || exec 9>&-
    return 1
  fi
  canonical_parent="${parent_path:A}"
  if [[ "$canonical_parent" != "$parent_path" ]] \
      || ! zstat -H fd_state -f 9 2>/dev/null \
      || ! zstat -L -H path_state -- "$lock_path" 2>/dev/null \
      || ! _local_ai_kernel_lock_validate_file_state fd_state \
      || ! _local_ai_kernel_lock_validate_file_state path_state \
      || [[ "$fd_state[device]:$fd_state[inode]" != "$path_state[device]:$path_state[inode]" ]]; then
    (( opened_here == 0 )) || exec 9>&-
    print -u2 -- "kernel lock boundary changed after acquisition"
    return 1
  fi

  typeset -g LOCAL_AI_KERNEL_LOCK_PATH="$lock_path"
  return 0
}
