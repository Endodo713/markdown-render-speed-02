import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// Driver for markdown-render-speed-02: render every case in
// /input/cases.json with the fast parser and write the HTML strings,
// in the cases' order, to /output/html.json.
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  rendered[k] = parse(cases[k].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
