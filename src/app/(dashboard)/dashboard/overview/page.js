import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import OverviewClient from "./OverviewClient";

export default function OverviewPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <OverviewClient />
    </Suspense>
  );
}
