# Review subscription limits

The Limits page reads the rolling usage windows reported by each configured Claude and Codex
account. Open **Limits** from the bottom of the project sidebar, or select refresh to request a new
snapshot from every connected environment.

Claude reports its five-hour session, weekly allowance, and any model-specific weekly allowance.
When extra usage is enabled, its card also shows the exact credits used, monthly credit limit, and
provider-reported utilization.
Codex reports every limit bucket exposed by the app server, including separate model limits when
available. Each row shows the percentage used and the provider's reset time.

Limits are read directly from the provider and are cached for five minutes. Reading them does not
send a model prompt or consume inference tokens. An unavailable card usually means that account's
credential does not grant access to subscription usage; sign in with the provider's full OAuth flow
and refresh the page.

The Limits and Usage pages answer different questions: Limits shows subscription allowance, while
Usage estimates token activity and API-equivalent cost from local session history.
