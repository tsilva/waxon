import type { V2TagRef } from "@/app/lib/v2/types";

export type QuestionTag = V2TagRef & {
  comparison?: "unscored" | "matched" | "missing" | "extra";
};

function tagLabel(tag: QuestionTag): string {
  if (tag.comparison === "missing") {
    return `${tag.label}, in ground truth but not predicted`;
  }
  if (tag.comparison === "extra") {
    return `${tag.label}, predicted but not in ground truth`;
  }
  if (tag.comparison === "matched") {
    return `${tag.label}, predicted and in ground truth`;
  }
  return tag.label;
}

export function QuestionTags({
  ariaLabel,
  className,
  onTagClick,
  tags,
}: {
  ariaLabel: string;
  className?: string;
  onTagClick?: (tagId: string) => void;
  tags: QuestionTag[];
}) {
  if (tags.length === 0) return null;

  return (
    <div
      aria-label={ariaLabel}
      className={`lean-question-tags${className ? ` ${className}` : ""}`}
    >
      {tags.map((tag) => {
        const label = tagLabel(tag);
        const tagClassName = `is-${tag.comparison ?? "unscored"}`;
        return onTagClick ? (
          <button
            aria-label={label}
            className={tagClassName}
            key={tag.id}
            onClick={() => onTagClick(tag.id)}
            title={label}
            type="button"
          >
            {tag.label}
          </button>
        ) : (
          <span className={tagClassName} key={tag.id}>
            {tag.label}
          </span>
        );
      })}
    </div>
  );
}
