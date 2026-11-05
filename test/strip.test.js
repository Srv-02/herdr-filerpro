import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdownImages, stripHtmlResources, markdownSteps, htmlSteps, MAX_LINE_CHARS } from "../mods/filer-pro/preview/strip.js";

test("inline and reference images become placeholders", () => {
  assert.equal(stripMarkdownImages('a ![Shot](https://example.com/p.gif "t") b'), "a [image: Shot] b");
  assert.equal(stripMarkdownImages("![](x.png)"), "[image]");
  assert.equal(stripMarkdownImages("![alt][ref]\n\n[ref]: https://example.com/p.gif"), "[image: alt]\n\n[ref]: https://example.com/p.gif");
  assert.equal(stripMarkdownImages("![alt]"), "[image: alt]");
  assert.equal(stripMarkdownImages('<img src="https://example.com/p.gif" alt="A">'), "[image: A]");
});
test("links stay links", () => {
  assert.equal(stripMarkdownImages("[a](https://example.com) <https://example.com/x>"), "[a](https://example.com) <https://example.com/x>");
});
test("image inside a link: the image goes, the link stays", () => {
  assert.equal(stripMarkdownImages("[![b](https://example.com/b.svg)](https://example.com)"), "[[image: b]](https://example.com)");
});
test("code stays code", () => {
  const md = "```md\n![x](y)\n<img src=y>\n```\nand `![x](y)` inline and ``<img src=z>``";
  assert.equal(stripMarkdownImages(md), md);
});
test("an open fence protects up to the end", () => {
  const md = "```md\n![x](y)";
  assert.equal(stripMarkdownImages(md), md);
});
test("HTML: everything that loads or runs is removed", () => {
  const html = '<p>Hi</p><IMG SRC="https://example.com/p.gif" ALT="A"><img src=x.png /><picture><source srcset="a.png"><img src="b.png"></picture>'
    + '<script>alert(1)<link rel="stylesheet" href="s.css"><meta http-equiv="refresh" content="0"><style>p{}</style><svg><image href="c.png"/></svg>';
  assert.equal(stripHtmlResources(html), "<p>Hi</p>[image: A][image][image]");
});
test("HTML: elements with content are removed together with their content", () => {
  const html = '<p>a</p><style>p{background:url(https://example.com/x)}</style><svg><image href="c.png"/></svg><iframe src="https://example.com"></iframe>'
    + '<video src="v.mp4">x</video><audio src="a.mp3"></audio><object data="o"></object><embed src="e"><noscript><img src=n></noscript><p>b</p>';
  assert.equal(stripHtmlResources(html), "<p>a</p><p>b</p>");
});
test("HTML: tags from the review list", () => {
  const html = '<image src="a.png"><input type="image" src="b.png"><input type="text" value="v"><frameset><frame src="f.html"></frameset><base href="https://example.com/"><video><track src="t.vtt"></video><link rel=icon href=i.ico><meta http-equiv=refresh content=0>';
  assert.equal(stripHtmlResources(html), '[image][image]<input type="text" value="v">');
});
test("HTML: background, poster, style and src are removed as attributes", () => {
  assert.equal(stripHtmlResources('<body background="https://example.com/b.png"><p style="background:url(https://example.com/x)" class="c">t</p>'),
    '<body><p class="c">t</p>');
  assert.equal(stripHtmlResources('<div poster=x SRC=y srcset=z data="d" onclick="f()" title="a style=b">t</div>'), '<div title="a style=b">t</div>');
});
test("HTML: a tag with hidden quotes stays one value", () => {
  assert.equal(stripHtmlResources(`<p title='" style="background:url(https://example.com/x)' class=k>t</p>`),
    '<p title="&quot; style=&quot;background:url(https://example.com/x)" class="k">t</p>');
});
test("HTML: alt text cannot smuggle in a tag", () => {
  assert.equal(stripHtmlResources('<img alt="<script>x</script>" src=a>'), "[image: &lt;script&gt;x&lt;/script&gt;]");
});
test("HTML: broken tags are defused, text stays", () => {
  assert.equal(stripHtmlResources("a < b and <3 <img"), "a < b and <3 &lt;img");
  assert.equal(stripHtmlResources('<img src="x" alt="a'), "&lt;img src=\"x\" alt=\"a");
});
test("HTML: comments and doctype stay", () => {
  assert.equal(stripHtmlResources("<!DOCTYPE html><!-- c --><p>x</p>"), "<!DOCTYPE html><!-- c --><p>x</p>");
});
test("Markdown with raw HTML: resources are removed there too", () => {
  assert.equal(stripMarkdownImages('text <script>alert(1)</script> <video src=v></video> ok'), "text   ok");
});

// Bypasses found in review, each a real <img src=http...> in a CommonMark renderer (checked against commonmark 0.31).
test("bypass a: alt text over a line break", () => {
  assert.equal(stripMarkdownImages("x ![a\nb](http://t/1.png) y"), "x \\![a\nb](http://t/1.png) y");
});
test("bypass b: an escaped backtick opens no code span", () => {
  assert.equal(stripMarkdownImages("\\`![x](http://t/2.png)`"), "\\`[image: x]`");
});
test("bypass c: a backtick in the info string is no fence", () => {
  assert.equal(stripMarkdownImages("```x`\n![x](http://t/3.png)\ntext"), "```x`\n[image: x]\ntext");
});
test("bypass d: a fence inside an HTML block is no fence", () => {
  assert.equal(stripMarkdownImages("<div>\n```\n</div>\n\n![x](http://t/4.png)\n<img src=http://t/5.png>"),
    "<div>\n```\n</div>\n\n[image: x]\n[image]");
});
test("a real fence after the HTML block ended is code again", () => {
  const md = "<div>\nx\n</div>\n\n```\n![x](http://t/6.png)\n<img src=y>\n```\n";
  assert.equal(stripMarkdownImages(md), md);
});
test("an HTML comment or script block keeps fences untrusted until it ends", () => {
  assert.equal(stripMarkdownImages("<!--\n\n```\n![x](http://t/7.png)\n-->\n"), "<!--\n\n```\n[image: x]\n-->\n");
});
test("fences that are indented or inside a list are not trusted, their images go too", () => {
  assert.equal(stripMarkdownImages("- a\n  ```\n  ![x](http://t/8.png)\n  ```"), "- a\n  ```\n  [image: x]\n  ```");
});
test("an HTML tag over several lines is removed", () => {
  assert.equal(stripMarkdownImages("a <img\n  src=\"http://t/9.png\"\n  alt=\"z\"> b"), "a [image: z] b");
});
test("an escaped image marker stays escaped, an even number of backslashes does not", () => {
  assert.equal(stripMarkdownImages("\\![x](http://t/a.png)"), "\\![x](http://t/a.png)");
  assert.equal(stripMarkdownImages("\\\\![x](http://t/b.png)"), "\\\\[image: x]");
  assert.equal(stripMarkdownImages("\\\\![x"), "\\\\\\![x");
});
test("an image marker inside an alt text cannot survive", () => {
  const out = stripMarkdownImages("![![z](http://t/c.png)](http://t/d.png)");
  assert.doesNotMatch(out, /(^|[^\\])!\[/);
});
test("reference-style images, also shortcut and collapsed, are neutralized", () => {
  assert.doesNotMatch(stripMarkdownImages("![a][r]\n![b][]\n![c]\n\n[r]: http://t/e.png\n[b]: http://t/f.png\n[c]: http://t/g.png"), /(^|[^\\])!\[[abc]\]\s*(\[|$)/m);
});
test("inline code on one line still stays code", () => {
  assert.equal(stripMarkdownImages("a `![x](y)` and ``<img src=z>`` b"), "a `![x](y)` and ``<img src=z>`` b");
});
test("a code span that never closes on its line protects nothing", () => {
  assert.equal(stripMarkdownImages("`a\n![x](http://t/h.png)\nb`"), "`a\n[image: x]\nb`");
});
test("the steps yield in pieces and give the same result as the plain call", () => {
  const md = "text ![a](b) and `c` <b>x</b>\n\n".repeat(3000);
  const gen = markdownSteps(md);
  let n = 0, r;
  while (!(r = gen.next()).done) n++;
  assert.ok(n >= 5, `only ${n} steps`);
  assert.equal(r.value.text, stripMarkdownImages(md));
  const html = "<b>x</b>".repeat(20000), hg = htmlSteps(html);
  let hn = 0, hr;
  while (!(hr = hg.next()).done) hn++;
  assert.ok(hn >= 5);
  assert.equal(hr.value, stripHtmlResources(html));
});
test("a very long line is cut, so one step stays small", () => {
  const out = markdownSteps("a".repeat(100000));
  let r;
  while (!(r = out.next()).done);
  assert.ok(r.value.cut);
  assert.ok(r.value.text.length <= MAX_LINE_CHARS + 5);
});
test("a tag before a backtick makes the code spans after it untrusted (the renderer may pair them differently)", () => {
  const out = stripMarkdownImages("<a title=\"`\">![i](http://t/i.png)`y`");
  assert.doesNotMatch(out, /(^|[^\\])!\[/);
  assert.equal(stripMarkdownImages("`a\n![x](http://t/m.png) `b` c"), "`a\n[image: x] `b` c");
});
test("a blank line makes code spans trusted again", () => {
  assert.equal(stripMarkdownImages("`a\n\n`![x](y)`"), "`a\n\n`![x](y)`");
});
test("adjacent literal backticks and a following code span are not merged into one run", () => {
  const out = stripMarkdownImages("``![a](u)`![x](y)`");
  assert.doesNotMatch(out, /``+!\[/);
});
test("backticks inside an HTML block start no code span", () => {
  assert.equal(stripMarkdownImages("<pre>\n`<video poster=http://t/k.png></video>`\n</pre>"), "<pre>\n``\n</pre>");
  assert.equal(stripMarkdownImages("<!--\n`<img src=http://t/l.png>`\n"), "<!--\n`[image]`\n");
});
