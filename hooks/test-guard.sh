#!/bin/bash
# Regression cases for guard-bash.sh. Run: bash hooks/test-guard.sh
H=$(cd "$(dirname "$0")" && pwd)
pass=0; fail=0
check() { # expect(0|2) command label
  local expect=$1 cmd=$2 label=$3
  jq -cn --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' | "$H/guard-bash.sh" >/dev/null 2>&1; local got=$?
  if [ "$got" = "$expect" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL ($got != $expect): $label"; fi
}

check 2 'git stash' "stash"
check 2 'git stash pop' "stash pop"
check 2 'cd app && git stash push -m wip' "stash after cd"
check 0 'git stash list' "stash list"
check 0 'git stash show -p stash@{0}' "stash show"
check 2 'git push -f origin x' "push -f"
check 2 'git push --force-with-lease' "force-with-lease"
check 2 'git push origin +main' "push +refspec"
check 0 'git push -u origin fix/foo-f' "branch ending -f"
check 0 'git push origin feat/a' "plain push"
check 2 'git reset --hard origin/main' "reset hard"
check 0 'git reset --soft HEAD~1' "reset soft"
check 2 'git clean -fd' "clean -fd"
check 2 'git branch -D x' "branch -D"
check 0 'git branch -d x' "branch -d"
check 2 'git checkout .' "checkout ."
check 0 'git checkout -b feat/x' "checkout -b"
check 2 'git restore .' "restore ."
check 0 'git restore --staged a.ts' "restore file"
check 2 'until [ -f done ]; do sleep 20; done' "until sleep"
check 2 'while ! grep -q Tests: log; do sleep 30; done; tail log' "while sleep"
check 2 'watch -n 5 ls' "watch"
check 0 'sleep 2 && curl localhost:3000/health' "short sleep"
check 0 'for f in *.ts; do echo $f; done' "for loop"
check 0 "$(printf 'cat > /tmp/x.sh <<EOF\ngit push -f\nuntil x; do sleep 1; done\nEOF\nbash /tmp/x.sh')" "heredoc body ignored"

echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
