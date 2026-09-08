---
title: What `parseArgs` does quietly, and the two bugs it shipped
summary: "`strict: false` makes an undeclared long option a BOOLEAN, and a value that lost its quotes falls through as positionals the greedy verbs join into prose. Both shipped, both silent, both corrupted the field a person was trying to fix. What the guards are and which invocations they must not break."
category: gotchas
kind: explanation
audience: [dev]
read_when: "adding a flag, adding a verb that joins positionals, or wondering why a value arrived as one word"
covers:
  - path: src/hkb.ts
    sha: de723e5a29b4eecb20165522e7f8aba7a059d7be
related:
  [
    architecture/transitions,
    features/workflow-templates,
    decisions/adr-015-machinery-and-consumer,
  ]
generated_at_commit: 238e866
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
most wants next.

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

### The rule, and how it got narrower

The first version was "any positional after any option", and it broke **four** legal invocations
that no test covered. That is the finding behind the finding: the tests asserted only what the guard
must *refuse*. CLAUDE.md's rule about proving a guard by making it refuse has a second half nobody
had written down — **a guard also has to be proven not to refuse what people actually type**, and
without those cases 538 tests passed with four regressions live.

A positional is stray only when:

1. **a positional already appeared before the flags.** That is what says the verb has what it came
   for. Without it, the first positional after a flag *is* the thing — `hkb new --triage "capture
   this"` is the frictionless-capture path, `hkb cancel --board other 12 "superseded"` puts the id
   after a flag because there is nowhere else for it to go, and `hkb new --from tmpl "My Name"` is
   documented on the templates page. All three were refused, the last two with advice that could not
   be followed.
2. **`--` has not been seen.** The standard way to say *everything after this is a positional*, and
   the only override the guard has.

And two things the check is scoped by rather than conditioned on: it runs for the six verbs that
join positionals into prose (`hkb watch --board other 999` is real, and a verb taking a fixed number
of positionals cannot absorb a stray one), and options *before* the verb are ignored, or `hkb --json
new x` would read its own verb as stray.

**A boolean flag changes the advice, not the verdict.** A word after `--json` was still silently
joined into the name, so it is still refused — but only a flag that consumed something can have
spilled it, and telling somebody to write `--json "…"` is advice that produces a different error. So
the flag is named only when it took a value, and never across an intervening boolean.

## Why both of these are the same bug

Neither is a parser fault. Both are hkb accepting something malformed and *writing it down* rather
than saying so — which is the failure the fifth value names outright: *never a silent failure*. The
board is a record, and a record that quietly contains what somebody did not type is worse than a
board that refused them.

The pattern to watch for when adding an argument: ask what happens when the value is **absent**,
when it is **unquoted**, and when the flag is **misspelled**. Under `strict: false` all three
succeed by default.
