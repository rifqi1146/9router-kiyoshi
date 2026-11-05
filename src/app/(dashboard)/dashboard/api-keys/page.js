import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import AccessKeysClient from "./AccessKeysClient";

export default function AccessKeysPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <AccessKeysClient />
    </Suspense>
  );
}
