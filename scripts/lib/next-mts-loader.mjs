import ts from "typescript";

export default function nextMtsLoader(source) {
  return ts.transpileModule(source.toString(), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2017,
    },
    fileName: this.resourcePath,
  }).outputText;
}
