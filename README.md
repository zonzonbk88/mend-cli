# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zonzonbk88/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zonzonbk88/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies an edit an AI model wrote to a tree of
text files. Models write edits in four formats — a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON — and mend reads all four to one written contract, `SPEC.md`:
it finds the lines each edit names even when the model drifted their whitespace
or indentation, and changes every file or none.

## Running it

Node 22 and its standard library only; there is nothing to install.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file. When it is absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or
  `json`; the default, `auto`, detects the format from the patch text.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only). Without it, lines also match
  with trailing whitespace removed (tier 1), then with leading and trailing
  whitespace removed (tier 2), and added lines are re-indented to the file's
  own indentation at tier 2.

## Output and exit codes

- Exit 0: one line per changed path (`A` added, `D` deleted, `M` modified,
  `R <old> -> <new>` moved), in byte order of the paths, then `ok: <n> files`.
- Exit 1: nothing is written. One `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), in the patch's
  order, then `failed: <k> of <n> edits`.
- Exit 2: a single line — `error: usage`, `error: no-patch`, `error: format`
  or `error: parse <N>`.

`SPEC.md` is the whole contract: formats, matching tiers, line endings
(LF/CRLF, final line breaks), safe paths and atomicity are all specified there.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the make.fun trial runner (hands checks from the trial env to
  `main.ts`); kept as the kit ships it.
- `check.ts` — runs `main.ts` over the kit's 100 public practice checks:
  `node check.ts <practice.json>`.
- `SPEC.md` — the specification mend implements.
