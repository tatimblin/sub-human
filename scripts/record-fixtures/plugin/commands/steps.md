---
description: The recorder's steps, one tool call each.
---
This is a test harness recording tool payloads. Do each step in order with exactly one tool call, no commentary, then reply "done".

1. Write the file notes.txt with the single line `one`.
2. Edit notes.txt, changing `one` to `two`.
3. Run with Bash: `git add -A && git commit -m "add notes"`
4. Run with Bash: `ls does-not-exist`
5. Run with Bash: `npm test`
6. TaskCreate with subject `demo task` and description `a recorded task`.
7. TaskUpdate that task to status `in_progress`.
8. TaskUpdate that task to status `completed`.
9. If you have a SendMessage tool, send the message `hi` to `nobody`. If you do not, skip this step.
10. AskUserQuestion with one question, "Which one?", header "Pick", options `A` and `B`. If it fails, go on.
