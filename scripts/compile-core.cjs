// Compile a dependency-free core module for the Node test runner.
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
for (const name of ['core', 'checkout', 'studiopro']) {
  const source = fs.readFileSync(path.resolve(__dirname, `../src/${name}.ts`), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const out = path.resolve(__dirname, `../dist-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, outputText.replace('require("./core")', 'require("./core.cjs")'));
}
