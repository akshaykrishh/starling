---
name: handoff
description: Write or refresh the handoff for the current piece of work (a starling stream) so another session, on any account or after a usage limit, can continue it. Use when context or a usage limit is running low, before /clear, before switching accounts, when the user asks for a handoff or resume prompt, or when stopping work that is not finished.
---

# Hand off a stream

A stream is one piece of work that outlives any single session. Its handoff file has two
parts: **Notes**, which you write because only you know the intent, and **State**, which
starling regenerates from git every time so it is never stale.

## Steps

1. Pick the stream name. If this session was started by `starling resume <name>`, the handoff
   loaded at session start names it. Otherwise run `starling streams` and use the stream for
   this folder, or choose a short new name for the work (`billing-retry`, `hr-onboarding-ui`).
2. Write the notes to starling on stdin. Keep them under about 40 lines, and write for a
   reader with no memory of this conversation:

   ```sh
   starling handoff <name> --notes-file - <<'NOTES'
   **Goal:** what done looks like, in one or two sentences.

   **Done:** what is finished and verified (say how: the command and its result).

   **In progress:** what was being changed when this session stopped, and where.

   **Next:** the next 1–3 concrete steps, in order.

   **Decisions:** choices made and why, so the next session does not reopen them.

   **Watch out:** traps found (a flaky test, a command that hangs, a file not to touch).

   **Waiting on the user:** anything only they can decide. Omit if nothing.
   NOTES
   ```

3. Report the handoff path starling prints, and the resume command:
   `starling resume <name>` (add `--profile <p>` to continue on another account).

## Rules

- Do not copy git facts (branch, uncommitted files, commits, PR) into the notes; starling
  writes those itself, and copies go stale.
- Do not claim something is done or passing unless this session saw the output.
- The handoff is overwritten each time. Do not create dated or numbered handoff files.
- Never put secrets, tokens or customer data in a handoff.
