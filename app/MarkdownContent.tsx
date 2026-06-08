"use client";

import {
  Fragment,
  type ReactNode,
} from "react";

type MathParseResult = {
  content: string;
  nextIndex: number;
};

type InlineMarkdownOptions = {
  enableMath?: boolean;
};

type MarkdownInlineProps = InlineMarkdownOptions & {
  as: "h2" | "p";
  className: string;
  text: string;
};

type MarkdownContentProps = InlineMarkdownOptions & {
  className: string;
  text: string;
  enableCodeBlocks?: boolean;
  enableHeadings?: boolean;
  codeBlockClassName?: string;
  headingClassName?: string;
};

type MarkdownBlockOptions = Required<
  Pick<
    MarkdownContentProps,
    "codeBlockClassName" | "enableCodeBlocks" | "enableHeadings" | "enableMath" | "headingClassName"
  >
>;

const mathSymbolMap: Record<string, string> = {
  alpha: "α",
  beta: "β",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  eta: "η",
  gamma: "γ",
  lambda: "λ",
  mu: "μ",
  nabla: "∇",
  partial: "∂",
  theta: "θ",
};

function findClosingDelimiter(
  source: string,
  delimiter: string,
  startIndex: number,
) {
  for (let index = startIndex; index < source.length; index += 1) {
    if (
      source.startsWith(delimiter, index) &&
      source[index - 1] !== "\\"
    ) {
      return index;
    }
  }

  return -1;
}

function readMathGroup(source: string, startIndex: number): MathParseResult | null {
  if (source[startIndex] !== "{") {
    return null;
  }

  let depth = 0;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return {
          content: source.slice(startIndex + 1, index),
          nextIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function readMathAtom(source: string, startIndex: number): MathParseResult {
  const group = readMathGroup(source, startIndex);

  if (group) {
    return group;
  }

  const atomMatch = source.slice(startIndex).match(/^[A-Za-z0-9]+/);

  if (atomMatch) {
    return {
      content: atomMatch[0],
      nextIndex: startIndex + atomMatch[0].length,
    };
  }

  return {
    content: source[startIndex] ?? "",
    nextIndex: startIndex + 1,
  };
}

function renderMathNodes(expression: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < expression.length) {
    if (expression.startsWith("\\frac", index)) {
      const numerator = readMathGroup(expression, index + "\\frac".length);

      if (numerator) {
        const denominator = readMathGroup(expression, numerator.nextIndex);

        if (denominator) {
          nodes.push(
            <span className="math-fraction" key={`frac-${index}`}>
              <span className="math-fraction-numerator">
                {renderMathNodes(numerator.content)}
              </span>
              <span className="math-fraction-denominator">
                {renderMathNodes(denominator.content)}
              </span>
            </span>,
          );
          index = denominator.nextIndex;
          continue;
        }
      }
    }

    const character = expression[index];

    if (character === "_" || character === "^") {
      const atom = readMathAtom(expression, index + 1);
      const Element = character === "_" ? "sub" : "sup";

      nodes.push(
        <Element key={`${character}-${index}`}>
          {renderMathNodes(atom.content)}
        </Element>,
      );
      index = atom.nextIndex;
      continue;
    }

    if (character === "\\") {
      const command = expression.slice(index + 1).match(/^[A-Za-z]+/);

      if (command) {
        nodes.push(
          <span className="math-command" key={`command-${index}`}>
            {mathSymbolMap[command[0]] ?? command[0]}
          </span>,
        );
        index += command[0].length + 1;
        continue;
      }
    }

    nodes.push(character);
    index += 1;
  }

  return nodes;
}

function MathExpression({
  expression,
  display = false,
}: {
  expression: string;
  display?: boolean;
}) {
  return (
    <span className={display ? "math-expression display" : "math-expression"}>
      {renderMathNodes(expression.trim())}
    </span>
  );
}

function renderInlineMarkdown(
  text: string,
  options: InlineMarkdownOptions = {},
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  const specialPattern = options.enableMath ? /(\*\*|`|\$|\*)/ : /(\*\*|`|\*)/;

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const closeIndex = findClosingDelimiter(text, "**", index + 2);

      if (closeIndex > index) {
        nodes.push(
          <strong key={`strong-${index}`}>
            {renderInlineMarkdown(text.slice(index + 2, closeIndex), options)}
          </strong>,
        );
        index = closeIndex + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const closeIndex = findClosingDelimiter(text, "`", index + 1);

      if (closeIndex > index) {
        nodes.push(
          <code className="markdown-inline-code" key={`code-${index}`}>
            {text.slice(index + 1, closeIndex)}
          </code>,
        );
        index = closeIndex + 1;
        continue;
      }
    }

    if (
      options.enableMath &&
      text[index] === "$" &&
      text[index + 1] !== "$"
    ) {
      const closeIndex = findClosingDelimiter(text, "$", index + 1);

      if (closeIndex > index) {
        nodes.push(
          <MathExpression
            expression={text.slice(index + 1, closeIndex)}
            key={`math-${index}`}
          />,
        );
        index = closeIndex + 1;
        continue;
      }
    }

    if (
      text[index] === "*" &&
      text[index + 1] !== "*" &&
      text[index - 1] !== "*"
    ) {
      const closeIndex = findClosingDelimiter(text, "*", index + 1);

      if (closeIndex > index) {
        nodes.push(
          <em key={`em-${index}`}>
            {renderInlineMarkdown(text.slice(index + 1, closeIndex), options)}
          </em>,
        );
        index = closeIndex + 1;
        continue;
      }
    }

    const nextSpecial = text.slice(index + 1).search(specialPattern);
    const endIndex =
      nextSpecial === -1 ? text.length : index + 1 + nextSpecial;

    nodes.push(text.slice(index, endIndex));
    index = endIndex;
  }

  return nodes;
}

export function MarkdownInline({
  as: Element,
  className,
  enableMath = false,
  text,
}: MarkdownInlineProps) {
  const lines = text.split("\n");

  return (
    <Element className={className}>
      {lines.map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {index > 0 ? <br /> : null}
          {renderInlineMarkdown(line, { enableMath })}
        </Fragment>
      ))}
    </Element>
  );
}

function renderMarkdownBlock(
  block: string,
  key: string,
  options: MarkdownBlockOptions,
): ReactNode {
  const trimmedBlock = block.trim();
  const lines = trimmedBlock.split("\n");
  const firstLine = lines[0]?.trim() ?? "";

  if (
    options.enableCodeBlocks &&
    trimmedBlock.startsWith("```") &&
    trimmedBlock.endsWith("```")
  ) {
    const codeLines = lines.slice(1, -1);

    return (
      <pre className={options.codeBlockClassName} key={`code-${key}`}>
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
  }

  if (
    options.enableMath &&
    trimmedBlock.startsWith("$$") &&
    trimmedBlock.endsWith("$$")
  ) {
    return (
      <p className="markdown-paragraph" key={`display-${key}`}>
        <MathExpression display expression={trimmedBlock.slice(2, -2)} />
      </p>
    );
  }

  if (options.enableHeadings && /^#{1,3}\s+/.test(firstLine)) {
    const rest = lines.slice(1).join("\n").trim();

    return (
      <Fragment key={`hblock-${key}`}>
        <h3 className={options.headingClassName}>
          {renderInlineMarkdown(firstLine.replace(/^#{1,3}\s+/, ""), {
            enableMath: options.enableMath,
          })}
        </h3>
        {rest ? renderMarkdownBlock(rest, `${key}-body`, options) : null}
      </Fragment>
    );
  }

  if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
    return (
      <ul className="markdown-list" key={`ul-${key}`}>
        {lines.map((line, lineIndex) => (
          <li key={`${line}-${lineIndex}`}>
            {renderInlineMarkdown(line.trim().slice(2), {
              enableMath: options.enableMath,
            })}
          </li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line.trim()))) {
    return (
      <ol className="markdown-list" key={`ol-${key}`}>
        {lines.map((line, lineIndex) => (
          <li key={`${line}-${lineIndex}`}>
            {renderInlineMarkdown(line.trim().replace(/^\d+\.\s+/, ""), {
              enableMath: options.enableMath,
            })}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <p className="markdown-paragraph" key={`p-${key}`}>
      {lines.map((line, lineIndex) => (
        <Fragment key={`${line}-${lineIndex}`}>
          {lineIndex > 0 ? <br /> : null}
          {renderInlineMarkdown(line, { enableMath: options.enableMath })}
        </Fragment>
      ))}
    </p>
  );
}

export function MarkdownContent({
  className,
  codeBlockClassName = "markdown-code",
  enableCodeBlocks = false,
  enableHeadings = false,
  enableMath = false,
  headingClassName = "markdown-heading",
  text,
}: MarkdownContentProps) {
  const blocks = text.trim().split(/\n{2,}/);
  const options: MarkdownBlockOptions = {
    codeBlockClassName,
    enableCodeBlocks,
    enableHeadings,
    enableMath,
    headingClassName,
  };

  return (
    <div className={`markdown-content ${className}`}>
      {blocks.map((block, index) =>
        renderMarkdownBlock(block, String(index), options),
      )}
    </div>
  );
}
