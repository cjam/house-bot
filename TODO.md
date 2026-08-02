# TODO — planned enhancements

Deferred work, agreed but not yet built. Each fits the existing architecture
(agent definitions + scoped tools + sub-agents in [`src/agents.ts`](src/agents.ts),
the transcript log, and per-session storage).

## Recall Phase 2 — session compaction index

Phase 1 recall ([`src/recall.ts`](src/recall.ts)) keyword-searches the raw
per-session transcript files. Phase 2 adds a compacted lookup layer so recall
scales and gets more relevant as history grows:

- On session rollover (the next `fresh` turn after an idle gap), summarize the
  finished session into `{ sessionId, dateRange, summary, keyFacts }` with one
  cheap LLM call, appended to a per-chat index (e.g. `data/logs/<chatId>/index.jsonl`).
- `recall` searches the small index first, then drills into the chosen session's
  `data/logs/<chatId>/<sessionId>.jsonl` for full detail.

**Parked intentionally** until real transcripts accumulate, so keyword recall's
adequacy can be judged and the summaries tuned to what's actually searched for.

## Family calendar

Give the planning agent access to the family calendar — as a scoped tool
alongside recipe search / shopping / weather / the recipe sub-agent, or as its
own agent definition. Would let meal planning account for busy nights, events,
who's home, etc.

## Transcript log retention

The transcript log is append-only and grows over time. Per-session files make
pruning easy (delete or archive whole `<sessionId>.jsonl` files); add a simple
size- or age-based retention policy (and/or fold into Phase 2 when sessions are
summarized into the index, after which raw files can be aged out).
