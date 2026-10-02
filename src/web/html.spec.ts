import { html, raw } from './html';

describe('html', () => {
  it('escapes interpolations but not nested fragments', () => {
    const name = '<script>alert("x")</script>';
    const out = html`<p title="${name}">${name}${html`<b>${'&'}</b>`}${[html`<i>1</i>`, '<2>']}${raw('<hr>')}${null}${false}</p>`;
    expect(out.toString()).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<b>&amp;</b><i>1</i>&lt;2&gt;<hr></p>',
    );
  });
});
