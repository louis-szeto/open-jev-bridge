---
name: system-one-belay
description: Before reporting an implementation finished, check whether actual verification ran after the latest observed edit and distinguish completion from blocked or unverified work.
---

Use this workflow proactively when relevant; do not wait for the user to request an MCP call. Lifecycle hooks provide independent automatic checks, but they do not remove your responsibility to verify the task.
When a Stop hook requests verification, inspect the actual latest changes. Run relevant tests, build, lint or an equivalent executable check available in the repository. If a check fails, correct the failure and rerun it. Report the actual command and result.

Do not manufacture runner output, quote a command to simulate execution, reset loop guards, or invoke a trivial command merely to satisfy the hook. A passing check is evidence about its own coverage, not a guarantee that all requirements are met.

If verification cannot run, explain the concrete blocker and what remains unverified. Do not present that work as fully verified. The configured System One judge is probabilistic, and transcript recognition is best-effort. A hook allowing Stop does not certify completion. Hook failures deliberately preserve the host workflow rather than trapping the agent in a loop.
