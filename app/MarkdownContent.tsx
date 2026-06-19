"use client";

import {
  Fragment,
  type ReactNode,
} from "react";
import {
  isUprightMathLiteral,
  renderLatexCommandText,
} from "@/app/lib/latexMath";

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

function isFormulaInlineCode(value: string): boolean {
  return /[=+\-*/^≈≤≥<>]|\\[A-Za-z]+|\b(?:cos|exp|ln|log|logit|sigmoid|sin|softmax|sum|tan|tanh)\b/iu.test(
    value,
  );
}

function decodeLatexText(value: string): string {
  return value.replace(/\\([_$%&#{}])/gu, "$1").replace(/\\textbackslash\b/gu, "\\");
}

function renderMathNodes(expression: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < expression.length) {
    if (expression.startsWith("\\operatorname", index)) {
      const operator = readMathGroup(expression, index + "\\operatorname".length);

      if (operator) {
        nodes.push(
          <span className="math-operator" key={`operator-${index}`}>
            {decodeLatexText(operator.content)}
          </span>,
        );
        index = operator.nextIndex;
        continue;
      }
    }

    if (expression.startsWith("\\text", index)) {
      const text = readMathGroup(expression, index + "\\text".length);

      if (text) {
        nodes.push(
          <span className="math-text" key={`text-${index}`}>
            {decodeLatexText(text.content)}
          </span>,
        );
        index = text.nextIndex;
        continue;
      }
    }

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
        const commandText = renderLatexCommandText(command[0]);

        if (commandText === null) {
          index += command[0].length + 1;
          continue;
        }

        nodes.push(
          <span className="math-command" key={`command-${index}`}>
            {commandText}
          </span>,
        );
        index += command[0].length + 1;
        continue;
      }
    }

    nodes.push(
      isUprightMathLiteral(character) ? (
        <span className="math-literal" key={`literal-${index}`}>
          {character}
        </span>
      ) : (
        character
      ),
    );
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
  const specialPattern = options.enableMath
    ? /(\*\*|`|\$|\\\(|\*)/
    : /(\*\*|`|\*)/;

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
        const codeText = text.slice(index + 1, closeIndex);

        nodes.push(
          <code
            className={
              isFormulaInlineCode(codeText)
                ? "markdown-inline-code markdown-formula-code"
                : "markdown-inline-code"
            }
            key={`code-${index}`}
          >
            {codeText}
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

    if (options.enableMath && text.startsWith("\\(", index)) {
      const closeIndex = findClosingDelimiter(text, "\\)", index + 2);

      if (closeIndex > index) {
        nodes.push(
          <MathExpression
            expression={text.slice(index + 2, closeIndex)}
            key={`latex-math-${index}`}
          />,
        );
        index = closeIndex + 2;
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

type MarkdownListKind = "ordered" | "unordered";

type MarkdownListLine = {
  marker?: number;
  text: string;
};

function readListLine(line: string): {
  kind: MarkdownListKind;
  line: MarkdownListLine;
} | null {
  const trimmedLine = line.trim();
  const unorderedMatch = trimmedLine.match(/^[-*]\s+(.+)$/u);

  if (unorderedMatch?.[1]) {
    return {
      kind: "unordered",
      line: { text: unorderedMatch[1] },
    };
  }

  const orderedMatch = trimmedLine.match(/^(\d+)\.\s+(.+)$/u);

  if (orderedMatch?.[1] && orderedMatch[2]) {
    return {
      kind: "ordered",
      line: {
        marker: Number.parseInt(orderedMatch[1], 10),
        text: orderedMatch[2],
      },
    };
  }

  return null;
}

function renderListRun(
  kind: MarkdownListKind,
  listLines: MarkdownListLine[],
  key: string,
  options: MarkdownBlockOptions,
): ReactNode {
  const start =
    kind === "ordered" && listLines[0]?.marker && listLines[0].marker !== 1
      ? listLines[0].marker
      : undefined;
  const items = listLines.map((line, lineIndex) => (
    <li key={`${line.text}-${lineIndex}`}>
      {renderInlineMarkdown(line.text, {
        enableMath: options.enableMath,
      })}
    </li>
  ));

  return kind === "ordered" ? (
    <ol className="markdown-list" key={`ol-${key}`} start={start}>
      {items}
    </ol>
  ) : (
    <ul className="markdown-list" key={`ul-${key}`}>
      {items}
    </ul>
  );
}

function renderParagraphRun(
  lines: string[],
  key: string,
  options: MarkdownBlockOptions,
): ReactNode {
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

function renderMarkdownLineRuns(
  lines: string[],
  key: string,
  options: MarkdownBlockOptions,
): ReactNode {
  const nodes: ReactNode[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const listLine = readListLine(lines[lineIndex] ?? "");

    if (listLine) {
      const listLines: MarkdownListLine[] = [listLine.line];
      const listKind = listLine.kind;
      lineIndex += 1;

      while (lineIndex < lines.length) {
        const nextListLine = readListLine(lines[lineIndex] ?? "");

        if (!nextListLine || nextListLine.kind !== listKind) {
          break;
        }

        listLines.push(nextListLine.line);
        lineIndex += 1;
      }

      nodes.push(
        renderListRun(listKind, listLines, `${key}-${nodes.length}`, options),
      );
      continue;
    }

    const paragraphLines = [lines[lineIndex] ?? ""];
    lineIndex += 1;

    while (lineIndex < lines.length && !readListLine(lines[lineIndex] ?? "")) {
      paragraphLines.push(lines[lineIndex] ?? "");
      lineIndex += 1;
    }

    nodes.push(
      renderParagraphRun(paragraphLines, `${key}-${nodes.length}`, options),
    );
  }

  return <Fragment key={`lines-${key}`}>{nodes}</Fragment>;
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

  if (
    options.enableMath &&
    trimmedBlock.startsWith("\\[") &&
    trimmedBlock.endsWith("\\]")
  ) {
    return (
      <p className="markdown-paragraph" key={`display-latex-${key}`}>
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

  return renderMarkdownLineRuns(lines, key, options);
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
