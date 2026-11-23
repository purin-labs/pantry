#!/usr/bin/env bash
# Runs a command and stops it when it prints nothing for a time.
#
#   bash scripts/ci-stall-guard.sh <seconds> <command> [arguments]
#
# CI run 45107749694 (23 November 2026) printed no line for 2.5 hours in the
# second shard of the E2E suite, with no failure and no time limit of Vitest.
# The job limit is 300 minutes, and the next run on dev waits behind it. The
# same shard passed on the same commit in a later run, so the cause is not
# known. This guard ends such a run after <seconds> of silence, prints what
# the runner was doing, and exits with 124.
set -u
limit=$1
shift

log=$(mktemp)
# With job control, the command gets its own process group, so the stop
# reaches each process that it started.
set -m
"$@" >"$log" 2>&1 &
run=$!
set +m
tail -n +1 -f "$log" &
tailer=$!
stop_tail() {
  kill "$tailer" 2>/dev/null
  wait "$tailer" 2>/dev/null
}

stalled=0
size=0
while kill -0 "$run" 2>/dev/null; do
  sleep 5
  now=$(wc -c <"$log")
  if [ "$now" -eq "$size" ]; then stalled=$((stalled + 5)); else stalled=0; fi
  size=$now
  if [ "$stalled" -ge "$limit" ]; then
    stop_tail
    echo "::error::No output for $stalled seconds. The command is stopped: $*"
    echo "--- memory"
    free -m 2>/dev/null || true
    echo "--- processes by CPU"
    ps -eo pid,ppid,etimes,pcpu,pmem,rss,stat,args --sort=-pcpu 2>/dev/null |
      cut -c1-200 | head -20 || true
    echo "--- threads by CPU"
    ps -eLo pid,tid,pcpu,stat,wchan:32,comm --sort=-pcpu 2>/dev/null |
      head -30 || true
    echo "--- kernel log"
    sudo -n dmesg 2>/dev/null | tail -20 || true
    kill -KILL -- "-$run" 2>/dev/null || kill -KILL "$run" 2>/dev/null
    rm -f "$log"
    exit 124
  fi
done
wait "$run"
status=$?
sleep 1
stop_tail
rm -f "$log"
exit "$status"
