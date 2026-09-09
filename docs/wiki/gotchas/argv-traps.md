---
title: What `parseArgs` does quietly, and the bugs it shipped
summary: "`strict: false` makes an undeclared long option a BOOLEAN, a value that lost its quotes falls through as positionals the greedy verbs join into prose, a DECLARED flag with no value is a boolean too — and a declared flag handed the NEXT FLAG swallows it as its value. Four traps, all silent, all of which corrupted the field a person was trying to fix."
category: gotchas
kind: explanation
audience: [dev]
read_when: "adding a flag, adding a verb that joins positionals, or wondering why a value arrived as one word — or as the word `true`, or as another flag"
covers:
  - path: src/hkb.ts
    sha: 07cc5da2cf62b8a7cb356558d805b9c2a29ba5b7
related:
  [
    architecture/transitions,
    features/workflow-templates,
    decisions/adr-015-machinery-and-consumer,
  ]
generated_at_commit: ff67f87
last_refreshed: 2026-09-09
---

# What `parseArgs` does quietly, and the bugs it shipped

> hkb parses arguments with `node:util`'s `parseArgs` under `strict: false`, chosen because the
> retired CLI's hand-rolled parser silently ate a value beginning with two dashes. It is the right
> parser and it has four behaviours that are entirely reasonable and entirely invisible, and every
> one of them reached `main` in September 2026.

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
verb body is not adding a flag.

`unknownFlags` (`src/hkb.ts`) now refuses any option token whose name is not in the declared table,
for every verb — which is the general form of this trap and also what makes a *misspelling* say so:

```
$ hkb new "n" --brefi "do it"
hkb: unknown flag: `--brefi` — `hkb --help` lists what each verb takes. An undeclared
flag is not an error to the argument parser, it is a boolean, so this would otherwise
have been accepted and its value filed as something else.
```

It is a check rather than `strict: true` because strict mode throws Node's own error: no exit code
of ours, no message naming the fix, and it fires before the `--help` path a person mistyping a flag
most wants next. Which means the check has to sit **after** that path itself — `hkb new --brefi x
--help` prints the help — and **before** the leftover check, or a misspelled flag is reported as a
quoting error on a value that was already quoted. Both orderings were wrong once.

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

### The rule, and the two wrong versions before it

`hkb new`'s name is **every positional**, so the only question worth asking is *which positionals
are the name*. They are the ones before the first flag — or, when there are none there, the first
one after it. Everything beyond that is a leftover, and `--` overrides the whole thing.

| typed | read as |
|---|---|
| `hkb new "a name" --input k=v:x y` | `y` is a leftover |
| `hkb new --triage "an idea"` | the idea IS the name |
| `hkb new --triage "a" --input k=v:x y` | `a` is the name, `y` is a leftover |
| `hkb new my great job --brief "x"` | all three words are the name |
| `hkb new "a" --brief x -- more` | `--` says the rest is positional |

**It took three attempts and each wrong one is worth knowing.** The first was *"any positional after
any option"*, which refused four documented forms including `hkb new --triage "…"`. The second asked
whether a positional appeared before the *first* flag and gave up if not — which made the check
entirely inert the moment a boolean led the line, so row three of that table went through silently.
Both were caught by review rather than by tests, for the same reason both times: **the tests said
what the guard must refuse and never what it must allow.**

That is the half of CLAUDE.md's rule that was not written down. "Every new guard gets a test that
makes it *refuse*" is necessary and not sufficient — a guard also has to be proven not to refuse
what people actually type, and without those cases 538 tests passed with four regressions live.

### Why only `hkb new`

`queue`, `done`, `cancel`, `approve` and `reject` join their trailing positionals into prose too, and
there a spilled value **cannot be told from an unquoted reason**: `hkb cancel 1 --board b
"superseded"` and `hkb cancel 1 --board my board name` produce the same token shape, and the first is
ordinary. Guarding them would mean giving up the greedy join — which exists so an unquoted reason is
not silently truncated to its first word, i.e. to prevent the *other* silent failure. One or the
other. The join stays and the guard covers the verb where the name is unambiguous.

Verbs of **fixed** arity are a different case and can be guarded exactly. `hkb job set` takes one id,
so `hkb job set 1 --name a better name` was setting the name to `a` and throwing away `better name`
— a leftover is *dropped* rather than absorbed there, which is the same fault wearing the other
face. It refuses now.

**A boolean flag changes the advice, not the verdict.** A word after `--json` is still a leftover and
still refused, but only a flag that consumed something can have spilled it, and telling somebody to
write `--json "…"` is advice that produces a different error. So the flag is named only when it took
a value, and never across an intervening boolean.

## 3. A DECLARED flag with no value is also a boolean

Trap 1 is about a flag nobody declared. This is the same shape one turn of the screw further in: a
flag that **is** in the options table as `type: 'string'`, given with nothing after it, still comes
back as the boolean `true` under `strict: false`. `unknownFlags` cannot see it — the flag is
perfectly well known — and neither can the leftover check, because a boolean swallows nothing.

What makes it dangerous is the idiom that reads the value. `String(values.check).trim()` turns
`true` into the **word** `true`, and a non-empty guard then waves it through:

```
$ hkb new "investigate the parser" --brief "…" --check
#12 investigate the parser  [pending]  on hkb
  must pass     true
```

`true` is a real shell command that exists and exits 0. Every attempt of that Job then "passed" a
check that verified nothing — a guard shipped inert while looking present, which is the class of
defect this codebase keeps rediscovering (`CLAUDE.md`: *a guard is not proven by a test that asks
whether it allows*). It reached three verbs at once, because all three shared the idiom:
`hkb new`, `hkb boards set` (via `setString`) and `hkb job set` (via `str`).

**The rule this leaves:** never `String(values.x)`. Test the type — `typeof values.x === 'string'`
— which is what `--gate` had always done one line away from the bug, and refuse by name. `given`
(`src/hkb.ts`) is that test in one place, and the flags that were reading their value with
`String(...)` now go through it.

**And a REPEATABLE flag is `[true]`, not `true`.** `multiple: true` wraps it, so a bare `--export`,
`--result`, `--artifact`, `--input`, `--label`, `--allow-tool` or `--plugin-dir` walked straight
past a guard written for the scalar case: `hkb new x --export` declared an output called `true`,
and the attempt failed for not producing it. `givenList` is `given` per item, for exactly that.

## 4. A declared flag hands over the NEXT FLAG as its value

The last turn of the same screw, and the one that gets past both earlier guards. A `type: 'string'`
option consumes exactly one token and **does not look at what that token is**, so the next flag on
the line becomes its value:

```
$ hkb new "investigate the parser" --brief "…" --check --json
#12 investigate the parser  [pending]  on hkb
  must pass     --json  [job]
```

Two things are wrong and neither says so. The Job's check — the command that judges every attempt of
it, run with the daemon's privileges — is the string `--json`, which no shell can run. And `--json`
is *not in effect*, because it was eaten: the operator asked for machine output and got prose.

`unknownFlags` cannot see it (both flags are declared) and `strayWords` cannot either (the token was
consumed, so nothing fell through as a positional). What catches it is the value's own shape:
`given` (`src/hkb.ts`) refuses a **flag-shaped** value — a dash followed by a letter, or two dashes
— on every flag that shares it. Not every leading dash: a brief that opens with a Markdown bullet
(`--brief "- add a test"`) and a negative number are values, and a first version refused the bullet.

Nothing legitimate is lost. A shell line, a git ref, a repo-relative path, a model name and a
comma-separated list all begin with something else, and a value that really does start with a dash
is reachable as `--check " -x"` — a leading space, which `given` tests for *before* it trims (a
first version trimmed first and refused its own escape with the same message; `--check=-x` and
`--` do not work, because the parser hands the flag `-x` either way). Where a checker existed already — `checkRef` refuses
a ref beginning with a dash, because a ref reaches git as a bare argv token and `--upload-pack=…`
runs a command — this guard now speaks first, with a different sentence and the same refusal.

**The rule this leaves:** a string flag's value is not just "a string". `given` is where all four of
these questions are asked once, and a new flag gets the answers by using it — *every* string flag,
which took three passes to make true: `--brief` and `--gate` were still `typeof === 'string'` after
the first (so `--brief --json` filed the word `--json` as a two-character brief and ran a session
on it), and `hkb job set`'s list helper cast to `string[]` after the second. A numeric flag has the
same trap in a different coat: a bare `--max-turns` is `true`, `Number(true)` is `1`, and a ceiling
of one turn was filed silently — `num` refuses a non-string by name and a value that is a flag,
while a negative number stays a number.

## Why all four of these are the same bug

None is a parser fault. All four are hkb accepting something malformed and *writing it down*
rather than saying so — which is the failure the fifth value names outright: *never a silent
failure*. The board is a record, and a record that quietly contains what somebody did not type is
worse than a board that refused them.

The pattern to watch for when adding an argument: ask what happens when the value is **absent**,
when it is **unquoted**, when the flag is **misspelled**, and when the next thing on the line is
**another flag**. Under `strict: false` all four succeed by default.
