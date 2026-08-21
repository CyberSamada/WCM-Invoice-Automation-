# canon/ — facts this repo imports, and must never edit

Everything in this folder is **owned by another repository**. It is pulled in
by `canon.py` and stamped in `canon.json` with the exact commit it came from.

**Do not edit a file in here.** An edit is silently thrown away on the next
pull, and worse, it makes this repo disagree with the owner while looking
authoritative. Fix the fact where it is owned, merge it there, then run:

```bash
python3 canon.py pull
```

| File | Owner | What it is |
|---|---|---|
| `procore-facts.json` | `CyberSamada/Procore_Claude_Intergration` | How Procore's API actually behaves, what that server refuses to do, and which of its 62 tools have been run against live Procore. |

## Why this folder exists

This repo and the Procore MCP both call Procore. Only the MCP runs tools
against a live Procore and records what came back. This repo used to keep its
own prose copy of those findings in `HANDOFF.md` §3, tagged `[SPEC]` or
`[OBSERVED]`. Those tags froze on 2026-08-20, one day before the MCP verified
32 tools live and learned six new rules.

The cost was real and is worth remembering. The MCP had already recorded that
a requisition attachment needs `upload_ids`, and that `prostore_file_ids`
takes integers which Procore **drops in silence**. This repo shipped
`prostore_file_ids`, logged `attached: true`, and attached nothing. It then
rediscovered the same fact days later, in production code.

The same lesson was paid for twice because nothing carried it across. That is
what this folder ends.

## Reading it

`procore-facts.json` has four parts worth knowing:

- `boundaries` — what the MCP refuses to do, and why. **`no-approval-human-approval-only` is the one that blocks this repo's send flow.** It is not negotiable and has been asked and answered.
- `api_rules` — how Procore actually behaves. Start with `attachments-are-not-one-flow` and `money-on-requisition-line-items-goes-to-procore-as-a-string`.
- `tools` — each tool, whether it has been verified against live Procore, and the evidence or the reason it has not.
- `counts` — how much of that server is actually proven.
