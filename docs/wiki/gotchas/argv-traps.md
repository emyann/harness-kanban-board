---
title: What `parseArgs` does quietly, and the two bugs it shipped
summary: "`strict: false` makes an undeclared long option a BOOLEAN, and a value that lost its quotes falls through as positionals the greedy verbs join into prose. Both shipped, both silent, both corrupted the field a person was trying to fix. What the guards are and which invocations they must not break."
category: gotchas
kind: explanation
audience: [dev]
read_when: "adding a flag, adding a verb that joins positionals, or wondering why a value arrived as one word"
covers:
  - path: src/hkb.ts
    sha: a33ff66368b4d6248281a0a74e94910891c77862
related:
  [
    architecture/transitions,
    features/workflow-templates,
    decisions/adr-015-machinery-and-consumer,
  ]
generated_at_commit: c7bd3d1
last_refreshed: 2026-09-07
---

# What `parseArgs` does quietly, and the two bugs it shipped

> hkb parses arguments with `node:util`'s `parseArgs` under `strict: false`, chosen because the
> retired CLI's hand-rolled parser silently ate a value beginning with two dashes. It is the right
> parser and it has two behaviours that are entirely reasonable and entirely invisible, and both
> reached `main` in September 2026.

## 1. An undeclared long option is a boolean

Under `strict: false`, `parseArgs` does not refuse a flag it has never heard of — it accepts it as a
**boolean**. So a flag you forgot to declare does not fail loudly; it succeeds quietly with the
value `true`, and its intended argument falls through as a positional.

`hkb job set` shipped with `--name` handled in the verb body and never added to the options table:

```
$ hkb job set 1 --name "a much better name"
#1 1 field set  (pending)
  name  original name → true
```

The Job was renamed to the literal string `"true"`. On the one field a person is most likely to be
there to fix.

**The rule this leaves:** a flag that a verb reads must be in the options table, and adding one to a
verb body is not adding a flag. There is no "unknown flag" error under `strict: false` to catch the
omission for you.

## 2. A value that lost its quotes becomes positionals

A string option consumes exactly one token. So an unquoted value with spaces in it hands over its
first word and abandons the rest:

```
$ hkb new "review the parser" --input page=value:the wiki page
```

`--input` gets `page=value:the`; `wiki` and `page` fall through as positionals; and `hkb new` joins
**every** positional into the Job's name. The result was a Job called *"review the parser wiki
page"* whose declared input was the single word `the` — two fields silently wrong, filed without a
word of complaint. `queue`, `done`, `cancel`, `approve` and `reject` join positionals the same way
and took the same damage: `hkb queue 33 --brief do the thing` filed `the thing` as the inline brief,
which silently *beats* the `--brief` the operator typed.

`strayWords` (`src/hkb.ts`) refuses it, naming the flag whose value spilled:

```
hkb new: 2 stray words after `--input` — `wiki`, `page`. A value with spaces in it needs
quoting, as in --input "…"; text that belongs to the name goes before the flags.
```

**It is a refusal rather than a repair, and that is deliberate.** The two readings — *this is part of
the value* and *this is part of the name* — need opposite fixes, and only the person who typed it
knows which they meant. Guessing would be the same silence in a different costume.

### The three invocations it must not break

The guard is narrow because the obvious wide version breaks real usage, and each of these has a test:

- **`hkb new my great job --brief …`** — an unquoted multi-word *name* before the flags. `hkb new`
  joins positionals on purpose, so this is legal and must stay so. Only positionals appearing
  **after a flag** are stray.
- **`hkb watch --board other 999`** — a positional after a flag, and entirely real. A verb that
  takes a *fixed* number of positionals cannot absorb a stray one into prose, so the check applies
  only to the six verbs that join.
- **`hkb --json new x`** — an option before the verb. Flags preceding the verb are ignored, or the
  verb itself would read as stray.

## Why both of these are the same bug

Neither is a parser fault. Both are hkb accepting something malformed and *writing it down* rather
than saying so — which is the failure the fifth value names outright: *never a silent failure*. The
board is a record, and a record that quietly contains what somebody did not type is worse than a
board that refused them.

The pattern to watch for when adding an argument: ask what happens when the value is **absent**,
when it is **unquoted**, and when the flag is **misspelled**. Under `strict: false` all three
succeed by default.
