# App session titles

Idle primary sessions are conservatively judged for a clear topic change.
Configure an exact catalog model/variant (`openai/gpt-6-luna#low` in the shared
profiles). Missing judges disable setup rather than choosing a paid fallback.
This is stateless helper inference, not a delegated child.

Only this location's primary sessions are evaluated. A manual title change
observed after adoption opts that session out immediately, including while a
judge is pending. The opt-out is persisted per session and restored on reload;
storage read failures suppress judging. Failed writes stay dirty and retry on
later rename/idle activity and once at cleanup, with concurrent writes coalesced.
Protection is in-memory during an outage: if persistence never succeeds before
unload or a crash, a reload can lose that opt-out. A title set before initial
plugin adoption is indistinguishable from the initial auto-title.

The live title is re-read before updating. Unload prevents late updates, but
cannot retract an update already submitted or cancel an already-running
stateless judge request through the Promise context API. Reload may overlap
that old helper request; no late rename is applied. There is no API
compare-and-set for titles, so a last-moment concurrent edit can still race.

No tmux or notification behavior is implied by app-visible session titles.
Run `npm ci --ignore-scripts` and `npm test` for mocked regression checks.
