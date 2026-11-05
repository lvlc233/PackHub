---
name: doc-review
description: Use after a document is written, before handing it over. Check structure and links mechanically, then run one or two independent cold readers against the document's purpose. Report sufficiency and readability gaps, fix only those, and stop.
---

# Doc review

Review the document against its purpose, not against a checklist of everything a document could contain.

## 1. State the purpose

Write one sentence before reading:

> This document is for `<who>`; after reading it, they should be able to `<what>`.

If that sentence cannot be written, the document has no reviewable purpose yet.

## 2. Run the mechanical checks

```bash
SKILL_DIR="<directory containing this SKILL.md>"
node "$SKILL_DIR/scripts/check-structure.mjs" path/to/doc.md
node "$SKILL_DIR/scripts/check-links.mjs" path/to/doc.md
```

- Structure: multiple H1, heading jumps, duplicate headings, unclosed code fences, table column mismatches.
- Links: missing local files and anchors. Add `--http` only when network checks are wanted.
- If the bound Markdown lint MCP is available, call `lint_markdown` on the file. Apply `fix_markdown` only to deterministic formatting issues (blank lines, trailing spaces); never let it rewrite prose.

## 3. Cold read

Use the installed `reader-brief` prompt with a **fresh context** (subagent or a second model). One reader is enough for a short document; two for anything above ~200 lines. Do not let the author review their own draft and call it cold.

Ask the reader to return only:

1. What the document is for, in their own words.
2. The path it takes: what comes first, what comes next, where it breaks.
3. Contradictions, undefined terms, jumps.
4. A 1–5 score for "one-pass understanding", with the deductions.
5. Three pieces of information they still need.

## 4. Judge

- **Sufficiency**: can the reader answer the questions in the purpose sentence? If yes, stop. Do not add fields, sections, or edge cases that the purpose does not require.
- **Readability**: can the reader retell the path and name the one jump? If they stop at a definition and ask "what is this action", the section is not readable yet.

Rank findings by whether they block the purpose. Fix blockers; leave reference-level details to a linked document.

## 5. Fix and re-run

Patch the document where the reader broke, not everywhere. Re-run the mechanical checks. If the change is structural, run one more cold read only on the changed sections.

## Output

Report:

- purpose sentence;
- mechanical issues found and fixed;
- reader score before and after (if re-read);
- remaining gaps, explicitly marked as "outside this document's purpose" or "must fix".
