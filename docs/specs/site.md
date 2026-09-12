# Site — jsmql.js.org

The project website. GitHub Pages builds it from the default branch of
`flash-oss/jsmql` and serves it at **https://jsmql.js.org**, a subdomain of the
[JS.ORG](https://js.org) free-subdomain service.

Three files reach the browser, all from the repository root:

| Path | Source | Role |
| --- | --- | --- |
| `index.html` | hand-authored | The landing page. What JSMQL is, how to install it, the compiled examples, links out. |
| `playground.html` | generated from `playground_skeleton.html` | The interactive editor. See [scripts/CLAUDE.md](../../scripts/CLAUDE.md). |
| `dist/jsmql.js` | generated from `src/index.ts` | The pure-ESM library bundle both pages import. |

`CNAME` holds the single line `jsmql.js.org`. GitHub Pages reads it as the
custom domain for the site, and JS.ORG reads it as proof that the repository
owner requested the subdomain.

## Jekyll passes all three through untouched

GitHub Pages runs Jekyll over the repository. Jekyll renders Liquid **only** in
files that carry YAML front matter, and treats every other file as a static
asset to copy verbatim. None of the three published files carries front matter,
so none is rendered — which is what keeps their JavaScript and MQL brace blocks
intact. A `{{ … }}` sequence in a rendered file is a Liquid tag and breaks the
build.

[_config.yml](../../_config.yml) excludes the rest of the repository for the
same reason: the Markdown docs contain JS-syntax `{{ … }}` blocks, and Jekyll
*does* render Markdown. `test/site.test.ts` asserts that `index.html` starts
with neither front matter nor a Liquid delimiter.

## The landing page states no MQL of its own

Every MQL document on the landing page is compiled in the reader's browser, at
load time, by `dist/jsmql.js` — the same bundle npm ships and the playground
imports. The page holds JSMQL inputs and nothing else, so it cannot show output
that the compiler no longer produces. This is the site's application of the
single-source-of-truth rule: the compiler owns its output, and the page quotes
it rather than copies it.

Each example is one `<article>` carrying:

- `data-mode` — the entry point to compile with, using the mode keys the
  playground already defines (`auto`, `filter`, `pipeline`, `expression`,
  `update`). `auto` is `jsmql()` itself, which picks the shape.
- a chip (`<span class="chip …">`) naming the output shape for the reader.
- the JSMQL source in `pre.src > code`.
- an empty `pre.out` that the page's module script fills.
- optionally the `tall` modifier (`class="example tall"`), which raises the
  height of both panes for an example whose MQL runs to hundreds of lines.
- optionally an empty `<span data-loc>`, which the script fills with the
  source-to-output line counts, measured from the text it has just rendered.

The MQL pane sits inside a `<details class="fold">`. The script leaves every
fold open on a wide screen, where the two panes sit side by side, and closes
them under 760px, where the panes stack: a phone then shows each example as its
title, its JSMQL and one line stating how many lines of MQL that made, and a
tap opens the pane. The prose and the JSMQL never fold.

The "SQL vs JSMQL" section holds a second kind of example: one
`<div class="vs" data-vs data-mode="…">` per idea, with the SQL in `pre.sql`
cells (one per dialect where the dialects disagree) and the JSMQL in
`pre.src > code`. These rows show **no MQL on the page**, on purpose — they
compare the two languages people write. The script still compiles each JSMQL
cell (a cell that stops compiling marks itself red with the error) and builds a
playground link for it, which is where its MQL is shown.

The script writes output with **`jsmql.stringify`**, the library's own printer,
taken from the same bundle it compiles with — see
[mql-stringify.md](mql-stringify.md). Neither page carries a printer of its own,
so an example, its "Open in playground" link and the terminal all show one text.

Two consequences the page's layout depends on. The output is JavaScript, not
JSON, so the MQL pane is highlighted with CodeMirror's JavaScript mode and not
its JSON mode. And the printer breaks a line at 80 columns, which is where the
panel width below comes from: a node stays on one line while it fits, so a
reader sees one stage per line rather than one brace per line. A pane is
narrower than 80 columns at the page's 1080px column, so the widest lines
scroll inside their own `pre`.

The module script also builds each "Open in playground" link. It encodes
`{ v: 1, input, vars, mode }` as base64url into a `#s=` fragment — the share
format `playground_skeleton.html` defines and consumes — so the example opens
in the playground with its source and mode intact.

When the bundle fails to load (the page opened over `file://`, say), the script
reveals a notice instead of leaving empty output blocks. The prose, the JSMQL
inputs and every link stay readable with JavaScript off.

## The page paints both languages with the playground's highlighter

A JSMQL input and an MQL document carry the same colours here as they do in the
editor, because the same three files from the pinned CodeMirror release do the
work:

| File | Role |
| --- | --- |
| `theme/neo.min.css` | The token colours. The theme keeps its base text colour on `.cm-s-neo.CodeMirror`, a selector only a live editor matches, so the page states that one colour itself for the `<pre>` that stands in for an editor. |
| `addon/runmode/runmode-standalone.min.js` | `CodeMirror.runMode`: the tokeniser with no editor around it. It fills an element with the same `cm-*` spans an editor holds, at a thirtieth of the core's weight. |
| `mode/javascript/javascript.min.js` | The JavaScript mode, in the two configurations the playground's editors use — plain for JSMQL, `json: true` for MQL. |

The markup holds each JSMQL source as plain text and the script rewrites the
block in place, so the source stays readable with JavaScript off, stays
selectable as text, and stays in the one shape both the page and the drift guard
below read. The script paints the inputs before it imports the bundle, because
their text is already on the page, and paints each MQL document as it compiles
it.

Two cases stay plain text. Where the CDN does not answer, `paint` writes the
text and returns, so the page loses the colours and nothing else. Where an
example fails to compile, the message is prose rather than JavaScript, and the
red `pre.out.failed` styling already carries it.

## Drift guards

[test/site.test.ts](../../test/site.test.ts) compiles each example through the
entry its `data-mode` names, and asserts:

- the extraction found as many examples as the markup declares, counted a
  second way — a lower bound alone stays green while an example slips out of the
  parse, which would review a page that is not the published one;
- every example compiles — a syntax change that breaks one fails the suite
  rather than putting an error message on the page;
- the output shape matches the chip (array for `pipeline` / `update`, object
  for `filter` / `expression`);
- the chip matches `data-mode`, except under `auto`, where the entry chooses
  the shape and the chip reports it;
- every SQL-vs-JSMQL row's JSMQL cell compiles to the shape its `data-mode`
  names, and the extraction found as many rows as the markup declares;
- `CNAME` matches the host in `package.json#homepage` **when the file is
  present**. It has to be absent while the domain does not resolve yet, because
  Pages redirects the github.io URL to whatever `CNAME` names, leaving nowhere
  to review the site;
- `_config.yml` publishes both pages, and the page imports the bundle.

What these guards cannot see is whether an example's MQL *does the right thing*
on real data — they assert what the compiler emits, never what the server
returns. An example whose behaviour matters belongs in
[test/integration.test.ts](../../test/integration.test.ts) as well.

The extraction fails loudly when the markup changes shape, so the cases cannot
quietly become a no-op.

## JS.ORG registration

JS.ORG maps the subdomain in
[`cnames_active.js`](https://github.com/js-org/js.org/blob/master/cnames_active.js)
in its own repository. The entry is:

```js
  "jsmql": "flash-oss.github.io/jsmql",
```

Entries are alphabetical, double-quoted, one per line, comma-terminated. The
service requires a working GitHub Pages site with real content behind the
`CNAME` before it accepts the request, and rejects placeholder pages, automatic
redirects off the js.org domain, and content unrelated to JavaScript.
