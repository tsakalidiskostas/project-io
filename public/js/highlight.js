// Line-at-a-time Monokai colouring per HANDOFF §6: keywords and operators pink, calls green, numbers,
// booleans and UPPER_CASE purple, types cyan italic, everything else plain. Strings and comments
// (// and shell-style #) are matched first so keywords inside them stay plain.
const KEYWORDS = new Set(
    `abstract as async await break case catch class const continue default delete do else enum export extends
    finally for foreach from function get if implements import in instanceof interface is let namespace new
    of override private protected public readonly return set static super switch this throw try type typeof
    using var void while yield fi then elif esac local echo exit def elif pass lambda with`.split(/\s+/),
);

const TOKEN = /(\/\/.*$|(?:^|(?<=\s))#(?![!{[]).*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*\b|\b(?:true|false|null|undefined|nil|None|True|False)\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([=+\-*/!<>&|?:%^~]+)/g;

export function highlight(line) {
    const out = [];
    let last = 0;
    for (const m of line.matchAll(TOKEN)) {
        if (m.index > last) out.push(['', line.slice(last, m.index)]);
        const [text, comment, string, literal, call, word, op] = m;
        let cls = '';
        if (comment || string) cls = '';
        else if (literal) cls = 'tok-num';
        else if (call) cls = KEYWORDS.has(call) ? 'tok-kw' : 'tok-fn';
        else if (word) {
            if (KEYWORDS.has(word)) cls = 'tok-kw';
            else if (/^[A-Z][A-Z0-9_]+$/.test(word)) cls = 'tok-num';
            else if (/^[A-Z]/.test(word)) cls = 'tok-type';
        } else if (op) cls = 'tok-kw';
        out.push([cls, text]);
        last = m.index + text.length;
    }
    if (last < line.length) out.push(['', line.slice(last)]);
    return out;
}
