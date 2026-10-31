---
description: Handle agent JSON envelopes, compact summaries, output files, and large TWG payloads.
---

# Agent Output

## Agent Mode

When the host sets `TWG_AGENT_DEFAULTS=1`, non-help commands run in agent mode.
The CLI defaults unspecified output to JSON, writes large payloads to files, and prints a compact summary on stdout.
Set this environment variable on individual commands only when the host requests it.
In some agent runtimes, an environment prefix can bypass authorization for that command.

A direct call such as `twg --mode agent --output json work query` also writes large payloads to files.
This automatic behavior applies unless you explicitly set `--output-summary`, `--output-file`, or `--output text`.
Use `--output-summary none` to get structured output directly on stdout.
The hidden `--mode agent` option supports agent hosts; ordinary help does not show it.

## Envelope Shape

A large agent call usually prints a YAML summary like this:

```yaml
output_files:
  stdout: "$TMPDIR/twg/.../stdout.json"
  stdout_lines: 1050
  stdout_bytes: 39779
  compact: "$TMPDIR/twg/.../stdout.compact.json"
  compact_bytes: 1402
command: "jira workitem query"
resource_type: "jira:workitem"
agent_output:
  summary: "stats"
  view: "compact"
  fields: [data.issues.key, data.issues.summary, data.issues.status]
stdout_stats:
  top_level_keys: [apiVersion, command, data, meta]
  collections:
    "data.issues": 50
---END---
```

- `collections` gives the number of elements in each array, primary collection first.
  `"[]"` means that the payload itself is an array. A count of `0` means no rows returned.
- If an array is absent from `collections`, the payload does not have it, unless `collections_omitted` is present.
  `collections_omitted: <n>` means the list has reached its limit; `n` more arrays exist.
  Use `stdout_shape` or `jq` to locate those arrays.
- A small payload can include the full JSON in `stdout_inline`. A large payload includes `stdout_stats`.
  The CLI omits `stdout_shape` only when `collections` locates the rows and `agent_output.fields` describes their contents.
- `agent_output.fields_unresolved` lists advertised fields absent from the payload when their container is present.
  It excludes paths for response types that do not apply. Empty results report no unresolved fields.

A failed command shows the error first, at every summary level:

```yaml
ok: false
error:
  code: "TWG_COMMAND_FAILED"
  kind: "twg_command_failed"
  message: "No goal found for key \"NONEXISTENT-1\"."
  repair: "Check the goal key with `twg goals query`."
  retry:
    recommended: false
    guidance: "do_not_retry_unchanged"
output_files:
  stdout: "$TMPDIR/twg/.../stdout.json"
---END---
```

Follow `error.repair`. Follow `error.retry.guidance` before you retry.
Full diagnostics, such as `backendFailure`, `traceId`, and `feedback`, stay in `output_files.stdout`.

## Reading Rule

Answer from facts already visible in `stdout_inline` or output that you read before.
Read more output or refetch only when that evidence does not contain or support a fact the answer needs.

- Choose the smallest view that supplies the fact: the compact file, a targeted projection, or full text.
  Extract currently known related facts together where practical. Keep each source and version identifiable.
- Returned fields describe the returned records, not whether the command covered every relevant source or row.
  Metadata and previews support only the facts they show. Current-state claims need evidence for the requested time.
- Keep relevant counts, partial-result signals, failures, and pagination data. Report unknown coverage as unknown.
- Inspect only output files from the same command invocation, if the host permits access.
  On restricted hosts, use supported output options or permitted file readers. Report inaccessible evidence as a gap.
  This permission excludes arbitrary host files, credentials, and output from other agent runs.

`stdout_shape` is a sample schema, not a full inventory. It includes only a few example string values per field.
For `context` commands, external links often appear near the end of relationship arrays and can be absent from samples.
For relationship or URL discovery, use sufficient inline or compact records, or a permitted projection of `output_files.stdout`.
See `twg-context-discovery/SKILL.md` for the related workflow.

## Output Size Controls

| Option | Result |
| --- | --- |
| `--output-summary stats` | Smallest stdout. Use for broad discovery. |
| `--output-summary auto` | Shows small results inline and summarizes large results. |
| `--output-summary inline` | Requests inline selected data. In agent mode, oversized results fall back to a file summary. |
| `--output-summary none` | Prints the selected structured format directly on stdout, without a summary envelope. |
| `--agent-fields <paths>` | Selects summary fields and creates a compact file. The full JSON file retains the payload. |
| `--select <paths>` | Selects payload fields before serialization, in `output_files.stdout`, `--output-file`, JSON stdout, and JSONL records. |

Use `--select` when you know the required fields.
Use `--agent-fields` when you might need more detail later; the full artifact remains available.
Neither option necessarily reduces backend retrieval.

Both options accept literal field paths and presets advertised for that command, such as `@rows`, `@compact`, and `@evidence`.
Without a preset contract, `--agent-fields` falls back to the normal summary envelope.
Use `@rows` or `@compact` for broad scans before custom filters. Use `@evidence` for selected artifacts that need fuller detail.

### Selection Fallbacks

- If no `--select` path matches, the CLI returns the full payload and reports `runtime_advisories.selectUnmatched`.
- If only some selection specs resolve, the CLI projects resolved paths and reports dropped presets under `runtime_advisories.selectUnresolved`.
- Routes without a summary envelope send these warnings to stderr.
- A top-level array stays an array.
- Failed commands retain the whole `ok: false` recovery envelope, including `error.code`, `error.repair`, and `error.retry`.

## Projections

For unknown field paths, use `twg help describe "<exact command>"` to find the advertised view or `jq` filter.
Use `jq` for structured JSON. Text search with `rg` can expose hundreds of KiB of raw payload.

```bash
jq '.data.edges[].node | {key, title, status, url}' "$OUT"
jq '.data.items[] | {name, owner, updatedAt}' "$OUT"
```

- Correct a failed projection from the advertised schema or facts already in context.
  A projection failure does not mean the source returned no matching rows.
- Combine known facts across batch files with `jq -n` and inputs or slurp where practical.
  Keep source and version identities in the result.

## Output Files

Agent defaults already write a JSON payload and show its path in `output_files.stdout`.
Use `--output-file` only when stable filenames simplify a recipe, for example a parallel context batch:

```bash
twg jira workitem get PROJ-123 --output-file "$TMPDIR/PROJ-123.json"
twg context jira workitem PROJ-123 --output-file "$TMPDIR/ctx_PROJ-123.json"
```

Use `$TMPDIR`, not a fixed `/tmp` path, because agent sandboxes use different temporary directories.

## Sandboxed Pipeline Logs

Pipeline logs can redirect to S3.
For sandboxed `twg bb pipeline get`, `wait`, `grep`, or `tail`, these signals indicate sandbox restrictions, not auth failure:

- Network blocks or S3 hostnames.
- HTTP 403 for logs when the metadata read succeeds.

Request approval to retry only that command unsandboxed, or provide its exact terminal command.
Do not request credentials.
