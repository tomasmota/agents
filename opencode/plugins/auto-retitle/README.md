# App session titles

Idle primary sessions are conservatively judged for a clear topic change.
Configure an exact catalog model/variant (`openai/gpt-6-luna#low` in the shared
profiles). Missing judges disable setup rather than choosing a paid fallback.
This is stateless helper inference, not a delegated child.

Only this location's primary sessions are evaluated. A manual title change
observed after adoption opts that session out for the life of the plugin
instance, including while a judge is pending. The live title is re-read before
updating. Unload prevents late updates, but cannot retract an update already
submitted or cancel an already-running stateless judge request through the
2.0.16 Promise context API. Reload may overlap that old helper request; no late
rename is applied. A title set before plugin load is indistinguishable from the initial
auto-title; the opt-out is not durable across server restarts. There is no API
compare-and-set for titles, so a last-moment concurrent edit can still race.

No tmux or notification behavior is implied by app-visible session titles.
Run `npm ci --ignore-scripts` and `npm test` for mocked regression checks.
