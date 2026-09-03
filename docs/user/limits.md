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
credential has expired or does not grant access to subscription usage.

Claude accounts that are not reporting limits show a **Sign in** button. It opens that account's
sign-in page in your browser. Some sign-ins complete on their own once you approve them, and others
hand back a code to paste; the dialog takes a code when there is one and otherwise finishes as soon
as you select Continue. Limits refresh automatically once it succeeds. Each account signs in
separately, so an account whose card looks healthy is left alone.

The Limits and Usage pages answer different questions: Limits shows subscription allowance, while
Usage estimates token activity and API-equivalent cost from local session history.
