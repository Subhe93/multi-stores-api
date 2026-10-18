/**
 * Jest transform for the few ESM-only packages that `sanitize-html` depends
 * on (htmlparser2 12, domhandler, domutils, dom-serializer, entities,
 * domelementtype). Node itself loads them through `require(esm)` (Node
 * >= 22.12 / 20.19), but jest's CommonJS runtime cannot parse `import`
 * statements, so their JavaScript is transpiled to CommonJS with the
 * TypeScript compiler on the fly. Wired in `package.json` → `jest.transform`
 * and `jest.transformIgnorePatterns`.
 */
const { createHash } = require('crypto');
const ts = require('typescript');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  allowJs: true,
  sourceMap: false,
};

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      compilerOptions,
      fileName: sourcePath,
      reportDiagnostics: false,
    });
    return { code: outputText };
  },
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha1')
      .update(sourceText)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(ts.version)
      .update('\0esm-cjs-v1')
      .digest('hex');
  },
};
