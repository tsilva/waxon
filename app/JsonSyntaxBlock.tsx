"use client";

import { ChevronDown, ChevronRight, Eye } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MarkdownContent } from "@/app/MarkdownContent";

type JsonStringPreview = {
  title: string;
  value: string;
};

const LONG_STRING_PREVIEW_CHARS = 96;
const LONG_STRING_MIN_CHARS = 120;

function parseJsonPayload(payload: string): unknown | null {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function normalizeJsonPayload(payload: string): {
  parsed: unknown | null;
  text: string;
} {
  const parsed = parseJsonPayload(payload);

  if (parsed === null) {
    return {
      parsed: null,
      text: payload,
    };
  }

  return {
    parsed,
    text: JSON.stringify(parsed, null, 2),
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCollapsibleJsonValue(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isJsonRecord(value);
}

function encodeJsonPathPart(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonStringPreview(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  const source = singleLine.length > 0 ? singleLine : value;

  if (source.length <= LONG_STRING_PREVIEW_CHARS) {
    return JSON.stringify(source);
  }

  return JSON.stringify(`${source.slice(0, LONG_STRING_PREVIEW_CHARS).trimEnd()}...`);
}

function shouldShowStringPreview(value: string): boolean {
  return value.length >= LONG_STRING_MIN_CHARS || value.includes("\n");
}

function branchSummary(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? "1 item" : `${value.length} items`;
  }

  const count = Object.keys(value).length;
  return count === 1 ? "1 field" : `${count} fields`;
}

function renderIndent(depth: number): ReactNode {
  return (
    <span className="admin-json-indent" aria-hidden="true">
      {"  ".repeat(depth)}
    </span>
  );
}

function renderJsonKey(name: string): ReactNode {
  return (
    <>
      <span className="admin-json-token admin-json-token-key">
        {JSON.stringify(name)}
      </span>
      <span className="admin-json-token admin-json-token-punctuation">: </span>
    </>
  );
}

function renderJsonPrimitive(
  value: unknown,
): ReactNode {
  if (typeof value === "string") {
    if (shouldShowStringPreview(value)) {
      return (
        <span className="admin-json-token admin-json-token-string">
          {jsonStringPreview(value)}
        </span>
      );
    }

    return (
      <span className="admin-json-token admin-json-token-string">
        {JSON.stringify(value)}
      </span>
    );
  }

  if (typeof value === "number") {
    return (
      <span className="admin-json-token admin-json-token-number">
        {JSON.stringify(value)}
      </span>
    );
  }

  if (typeof value === "boolean") {
    return (
      <span className="admin-json-token admin-json-token-boolean">
        {JSON.stringify(value)}
      </span>
    );
  }

  if (value === null) {
    return <span className="admin-json-token admin-json-token-null">null</span>;
  }

  return (
    <span className="admin-json-token admin-json-token-string">
      {JSON.stringify(String(value))}
    </span>
  );
}

function renderStringPreviewButton(input: {
  keyName?: string;
  onPreviewString: (preview: JsonStringPreview) => void;
  path: string;
  value: string;
}): ReactNode {
  return (
    <button
      className="admin-json-string-preview"
      type="button"
      aria-label={`Preview ${input.keyName ?? "string"} as markdown`}
      title="Preview markdown"
      onClick={() =>
        input.onPreviewString({
          title: input.keyName ?? input.path,
          value: input.value,
        })
      }
    >
      <Eye aria-hidden="true" size={12} strokeWidth={2.7} />
    </button>
  );
}

function renderJsonLine(input: {
  children: ReactNode;
  key: string;
  toggle?: ReactNode;
}): ReactNode {
  return (
    <span className="admin-json-line" key={input.key}>
      <span className="admin-json-branch-gutter">
        {input.toggle ?? null}
      </span>
      <span className="admin-json-code-content">{input.children}</span>
    </span>
  );
}

export function JsonSyntaxBlock({
  payload,
  className,
}: {
  payload: string;
  className: string;
}) {
  const { parsed, text } = useMemo(() => normalizeJsonPayload(payload), [payload]);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [stringPreview, setStringPreview] = useState<JsonStringPreview | null>(
    null,
  );
  const preClassName =
    parsed === null ? className : `${className} admin-json-payload`;

  useEffect(() => {
    setCollapsedPaths(new Set());
    setStringPreview(null);
  }, [payload]);

  useEffect(() => {
    if (!stringPreview) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setStringPreview(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stringPreview]);

  function togglePath(path: string) {
    setCollapsedPaths((current) => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }

  function renderJsonValue(input: {
    value: unknown;
    keyName?: string;
    depth: number;
    path: string;
    trailingComma?: boolean;
  }): ReactNode[] {
    const { depth, keyName, path, trailingComma, value } = input;

    if (!isCollapsibleJsonValue(value)) {
      const previewButton =
        typeof value === "string"
          ? renderStringPreviewButton({
              keyName,
              onPreviewString: setStringPreview,
              path,
              value,
            })
          : undefined;

      return [
        renderJsonLine({
          key: path,
          toggle: previewButton,
          children: (
            <>
              {renderIndent(depth)}
              {keyName === undefined ? null : renderJsonKey(keyName)}
              {renderJsonPrimitive(value)}
              {trailingComma ? (
                <span className="admin-json-token admin-json-token-punctuation">
                  ,
                </span>
              ) : null}
            </>
          ),
        }),
      ];
    }

    const isArray = Array.isArray(value);
    const entries = isArray
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    const isCollapsed = collapsedPaths.has(path);
    const openToken = isArray ? "[" : "{";
    const closeToken = isArray ? "]" : "}";
    const lines: ReactNode[] = [
      renderJsonLine({
        key: `${path}:open`,
        toggle: (
          <button
            className="admin-json-branch-toggle"
            type="button"
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${
              keyName ?? "root"
            } branch`}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? "Expand branch" : "Collapse branch"}
            onClick={() => togglePath(path)}
          >
            {isCollapsed ? (
              <ChevronRight aria-hidden="true" size={14} strokeWidth={3.25} />
            ) : (
              <ChevronDown aria-hidden="true" size={14} strokeWidth={3.25} />
            )}
          </button>
        ),
        children: (
          <>
            {renderIndent(depth)}
            {keyName === undefined ? null : renderJsonKey(keyName)}
            <span className="admin-json-token admin-json-token-punctuation">
              {openToken}
            </span>
            {isCollapsed ? (
              <>
                <span className="admin-json-branch-summary">
                  {" "}
                  {branchSummary(value)}
                  {" "}
                </span>
                <span className="admin-json-token admin-json-token-punctuation">
                  {closeToken}
                  {trailingComma ? "," : ""}
                </span>
              </>
            ) : null}
          </>
        ),
      }),
    ];

    if (isCollapsed) {
      return lines;
    }

    entries.forEach(([entryKey, entryValue], index) => {
      lines.push(
        ...renderJsonValue({
          value: entryValue,
          keyName: isArray ? undefined : entryKey,
          depth: depth + 1,
          path: `${path}/${encodeJsonPathPart(entryKey)}`,
          trailingComma: index < entries.length - 1,
        }),
      );
    });

    lines.push(
      renderJsonLine({
        key: `${path}:close`,
        children: (
          <>
            {renderIndent(depth)}
            <span className="admin-json-token admin-json-token-punctuation">
              {closeToken}
              {trailingComma ? "," : ""}
            </span>
          </>
        ),
      }),
    );

    return lines;
  }

  return (
    <>
      <pre className={preClassName}>
        <code className={parsed === null ? undefined : "admin-json-tree"}>
          {parsed === null
            ? text
            : renderJsonValue({
                value: parsed,
                depth: 0,
                path: "$",
              })}
        </code>
      </pre>
      {stringPreview ? (
        <div
          className="admin-json-string-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setStringPreview(null);
            }
          }}
        >
          <section
            className="admin-json-string-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-json-string-modal-title"
          >
            <div className="admin-json-string-modal-header">
              <div>
                <p className="admin-json-string-modal-kicker">Markdown preview</p>
                <h2
                  className="admin-json-string-modal-title"
                  id="admin-json-string-modal-title"
                >
                  {stringPreview.title}
                </h2>
              </div>
              <button
                className="stats-modal-close"
                type="button"
                aria-label="Close markdown preview"
                onClick={() => setStringPreview(null)}
              />
            </div>
            <MarkdownContent
              className="admin-json-string-markdown"
              codeBlockClassName="admin-call-markdown-code"
              enableMath
              text={stringPreview.value}
            />
          </section>
        </div>
      ) : null}
    </>
  );
}
