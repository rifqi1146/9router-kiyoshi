import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import PulseClient from "./PulseClient";

export const metadata = {
  title: "Live Provider Pulse — 9Router",
  description: "Real-time provider health, latency percentiles, status distribution, and account breakdown",
};

export default function PulsePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <PulseClient />
    </Suspense>
  );
}
