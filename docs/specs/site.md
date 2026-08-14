# Site — jsmql.js.org

The project website. GitHub Pages builds it from the default branch of
`flash-oss/jsmql` and serves it at **https://jsmql.js.org**, a subdomain of the
[JS.ORG](https://js.org) free-subdomain service.

Three files reach the browser, all from the repository root:

| Path | Source | Role |
| --- | --- | --- |
| `index.html` | hand-authored | The landing page. What JSMQL is, how to install it, six compiled examples, links out. |
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

The module script also builds each "Open in playground" link. It encodes
`{ v: 1, input, vars, mode }` as base64url into a `#s=` fragment — the share
format `playground_skeleton.html` defines and consumes — so the example opens
in the playground with its source and mode intact.

When the bundle fails to load (the page opened over `file://`, say), the script
reveals a notice instead of leaving empty output blocks. The prose, the JSMQL
inputs and every link stay readable with JavaScript off.

## Drift guards

[test/site.test.ts](../../test/site.test.ts) compiles each example through the
entry its `data-mode` names, and asserts:

- every example compiles — a syntax change that breaks one fails the suite
  rather than putting an error message on the page;
- the output shape matches the chip (array for `pipeline` / `update`, object
  for `filter` / `expression`);
- the chip matches `data-mode`, except under `auto`, where the entry chooses
  the shape and the chip reports it;
- `CNAME` matches the host in `package.json#homepage`;
- `_config.yml` publishes both pages, and the page imports the bundle.

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
