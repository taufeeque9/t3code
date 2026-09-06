import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { isUsageMetric, UsagePage, type UsageMetric } from "../components/usage/UsagePage";

/**
 * Keeps the selected view in the URL so a "Limits" entry point opens it
 * directly instead of landing on Cost and making the reader switch.
 */
function UsageRoute() {
  const { metric } = Route.useSearch();
  const navigate = useNavigate();
  const onMetricChange = useCallback(
    (next: UsageMetric) => {
      void navigate({
        to: "/usage",
        search: next === "cost" ? {} : { metric: next },
        replace: true,
      });
    },
    [navigate],
  );
  return <UsagePage metric={metric ?? "cost"} onMetricChange={onMetricChange} />;
}

export const Route = createFileRoute("/usage")({
  component: UsageRoute,
  validateSearch: (search: Record<string, unknown>): { metric?: UsageMetric } => {
    const metric = search["metric"];
    return typeof metric === "string" && isUsageMetric(metric) ? { metric } : {};
  },
});
