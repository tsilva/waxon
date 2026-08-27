"use client";

import { ReviewFlagDialog } from "@/app/(app)/review/ReviewFlagDialog";
import type { ReviewFlagReason } from "@/app/lib/v2/reviewFlag";

const REFRESH_ERROR =
  "Question was Flagged, but the Question Bank could not be refreshed. Reload to see the latest state.";

export function QuestionBankFlagDialog({
  onClose,
  onCommitted,
  onFlag,
  onRefresh,
  onRefreshError,
}: {
  onClose: () => void;
  onCommitted: () => void;
  onFlag: (input: {
    reasons: ReviewFlagReason[];
    detail: string;
  }) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshError: (message: string) => void;
}) {
  return (
    <ReviewFlagDialog
      onClose={onClose}
      onSubmit={onFlag}
      onSubmitted={() => {
        onCommitted();
        void onRefresh().catch(() => onRefreshError(REFRESH_ERROR));
      }}
      surface="question-bank"
    />
  );
}
