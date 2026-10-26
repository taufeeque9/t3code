import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { isUsageMetric, UsagePage } from "../components/usage/UsagePage";
import type { UsageMetric } from "../components/usage/usageShortcuts";

/**
 * Keeps the selected view in the URL so a "Limits" entry point opens it
 * directly instead of landing on Cost and making the reader switch.
 */
function UsageRoute() {
  const { metric } = Route.useSearch();
  const navigate = useNavigate();
  const onMetricChange = (next: UsageMetric) => {
    void navigate({
      to: "/usage",
      search: next === "cost" ? {} : { metric: next },
      replace: true,
    });
  };
  return <UsagePage metric={metric} onMetricChange={onMetricChange} />;
}

export const Route = createFileRoute("/_chat/usage")({
  component: UsageRoute,
  validateSearch: (search: Record<string, unknown>): { metric?: UsageMetric } => {
    const metric = search["metric"];
    return typeof metric === "string" && isUsageMetric(metric) ? { metric } : {};
  },
});
