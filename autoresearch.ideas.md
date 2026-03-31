# Deferred ideas

- Add a first-class desktop automation runner case that replays the historical
  managed cutoff prompt and asserts the final assistant message is non-empty
  after multi-round tool use.
- Expose assistant `messageParts` or reasoning summaries in the automation
  snapshot if future reload-order regressions need stronger live assertions than
  screenshots plus saved-chat reload.
- If chronology now reads correctly but still feels too boxy, soften the
  content-part chrome for mid-turn content fragments without reintroducing
  aggregation.
