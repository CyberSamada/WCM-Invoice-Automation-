#!/usr/bin/env node
/**
 * build-gem-pack.js — bundles this repo into upload files for a Google AI Studio Gem, so Gemini can
 * answer questions about how the invoice automation works.
 *
 * Why a build step and not "upload the repo": AI Studio takes a handful of files, not a folder, and
 * a Gem has no link back here — whatever you upload is frozen until you upload again. So this makes
 * TWO files, keeps them small enough to paste or attach, and puts a generated-on date at the top of
 * each so a stale pack is obvious rather than silently wrong.
 *
 *   node tools/build-gem-pack.js [outputDir]     # default: ./gem-pack (gitignored)
 *
 *   gem-pack/01-how-it-works.md   the docs + a function index: what exists and why
 *   gem-pack/02-source.md         every .gs file and the dashboard's server code, verbatim
 *
 * Deliberately EXCLUDED: nothing here is secret beyond what the repo already holds, but the pack
 * skips LogoAsset.gs (a megabyte of base64 image, pure noise for a Q&A bot) and any file matching
 * the credential/PII patterns in .gitignore.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'gem-pack'));

const DOCS = [
  'README.md',
  'CLAUDE.md',
  'EMPLOYEE_GUIDE.md',
  'apps-script/SETUP.md',
  'WCM_Invoice_Automation_Plan.md',
  'property_addresses.md'
];

// Source order matters for a reader: entry points first, then the services they call.
const SOURCE = [
  'apps-script/Config.gs',
  'apps-script/Main.gs',
  'apps-script/GmailService.gs',
  'apps-script/GeminiService.gs',
  'apps-script/ExtractionNotes.gs',
  'apps-script/AliasSeed.gs',
  'apps-script/DriveService.gs',
  'apps-script/DriveSetup.gs',
  'apps-script/SheetService.gs',
  'apps-script/DashboardServer.gs',
  'apps-script/NexusSync.gs',
  'apps-script/Refile.gs',
  'apps-script/Reconcile.gs',
  'apps-script/Setup.gs',
  'apps-script/Test.gs',
  'apps-script/appsscript.json',
  '.github/workflows/deploy-apps-script.yml'
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const kb = (s) => Math.round(Buffer.byteLength(s, 'utf8') / 1024);

/**
 * Pulls a one-line purpose for every top-level function in a .gs file: the FIRST sentence of the
 * JSDoc block above it (the summary), or the first line of a run of `//` comments. Taking the last
 * line instead gives a fragment from the middle of a paragraph, which reads like nonsense in an
 * index. Brace counting isn't needed — only the signature line is wanted, and top-level functions
 * in these files start at column 0.
 */
function docAbove(lines, i) {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === '') j--;
  if (j < 0) return '';
  // Trim FIRST, then peel the comment markers. Doing it the other way round leaves the leading
  // " * " in place (the line starts with a space, so /^\*/ never matches) and then @param tags
  // sail straight past the tag filter below and into the index.
  const strip = (t) => t.trim()
    .replace(/^\/\*\*?/, '')
    .replace(/^\*\/$/, '')
    .replace(/^\*/, '')
    .replace(/^\/\//, '')
    .trim();

  let body = [];
  if (lines[j].trim() === '*/') {
    // Walk up to the opening /** and collect the block in reading order.
    let k = j - 1;
    const buf = [];
    while (k >= 0 && !/^\s*\/\*\*/.test(lines[k])) { buf.unshift(lines[k]); k--; }
    if (k < 0) return '';
    body = buf.map(strip);
  } else if (lines[j].trim().startsWith('//')) {
    let k = j;
    while (k >= 0 && lines[k].trim().startsWith('//')) k--;
    body = lines.slice(k + 1, j + 1).map(strip);
  } else {
    return '';
  }

  // Join until the first sentence end, stopping at @tags and blank separators.
  const parts = [];
  for (const line of body) {
    if (!line || /^@/.test(line)) { if (parts.length) break; else continue; }
    parts.push(line);
    if (/[.!?]$/.test(line)) break;
    if (parts.join(' ').length > 190) break;
  }
  let out = parts.join(' ').replace(/\s+/g, ' ').trim();
  const dot = out.search(/[.!?](\s|$)/);
  if (dot > 30) out = out.slice(0, dot + 1);
  if (out.length > 200) out = out.slice(0, 197).replace(/\s\S*$/, '') + '…';
  return out;
}

function functionIndex(rel) {
  const lines = read(rel).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(lines[i]);
    if (!m) continue;
    const doc = docAbove(lines, i);
    const priv = m[1].endsWith('_') ? ' *(private)*' : '';
    out.push('- `' + m[1] + '(' + m[2].trim() + ')`' + priv + (doc ? ' — ' + doc : ''));
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);

// ---------- file 1: how it works ----------
let a = '';
a += '# WCM Invoice Automation — how it works\n\n';
a += '> Knowledge pack generated **' + stamp + '** from the repo. If today is much later than that,\n';
a += '> ask whoever maintains this to regenerate it (`node tools/build-gem-pack.js`) and re-upload —\n';
a += '> a Gem has no link back to the repo, so this file is frozen at the date above.\n\n';
a += 'You are answering questions about this system for the team that runs it. Prefer the documents\n';
a += 'below over guesswork. When a question is about exact behaviour, quote the relevant function\n';
a += 'from the companion file `02-source.md`. If something is genuinely not covered here, say so\n';
a += 'rather than inventing it.\n\n';
a += '---\n\n';
for (const rel of DOCS) {
  if (!exists(rel)) continue;
  a += '\n\n# ==== ' + rel + ' ====\n\n' + read(rel).replace(/^# /m, '## ') + '\n';
}
a += '\n\n# ==== Function index (generated) ====\n\n';
a += 'Every top-level function, in the order the files are loaded. `_` suffix means private by\n';
a += 'convention and NOT callable from the dashboard via `google.script.run`.\n';
for (const rel of SOURCE) {
  if (!exists(rel) || !rel.endsWith('.gs')) continue;
  const idx = functionIndex(rel);
  if (!idx.length) continue;
  a += '\n## ' + rel + '\n\n' + idx.join('\n') + '\n';
}
// The dashboard's client script is huge; index its functions rather than shipping the markup.
if (exists('apps-script/Dashboard.html')) {
  const idx = [];
  read('apps-script/Dashboard.html').split('\n').forEach((l) => {
    const m = /^\s{4}function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(l);
    if (m) idx.push('- `' + m[1] + '(' + m[2].trim() + ')`');
  });
  a += '\n## apps-script/Dashboard.html (browser-side functions)\n\n' + idx.join('\n') + '\n';
}

// ---------- file 2: source ----------
let b = '';
b += '# WCM Invoice Automation — source\n\n';
b += 'Generated **' + stamp + '**. Server-side Apps Script, in load order, plus the deploy workflow.\n';
b += '`Dashboard.html` is omitted (mostly markup and CSS); its functions are indexed in\n';
b += '`01-how-it-works.md`, and its server endpoints all live in `DashboardServer.gs` and\n';
b += '`NexusSync.gs` below.\n\n';
for (const rel of SOURCE) {
  if (!exists(rel)) { console.warn('skip (missing): ' + rel); continue; }
  const lang = rel.endsWith('.json') ? 'json' : rel.endsWith('.yml') ? 'yaml' : 'javascript';
  b += '\n\n# ==== ' + rel + ' ====\n\n```' + lang + '\n' + read(rel) + '\n```\n';
}

fs.writeFileSync(path.join(OUT, '01-how-it-works.md'), a);
fs.writeFileSync(path.join(OUT, '02-source.md'), b);
console.log('01-how-it-works.md  ' + kb(a) + ' KB');
console.log('02-source.md        ' + kb(b) + ' KB');
console.log('written to ' + OUT);
