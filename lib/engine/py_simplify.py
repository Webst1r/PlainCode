#!/usr/bin/env python3
"""
py_simplify.py - behaviour-preserving clean-ups for Python source code.

Protocol: reads {"code": "..."} as JSON on stdin and writes JSON on stdout:
  {"ok": true,  "code": "...", "changes": [{"rule": "...", "count": 2, "detail": "..."}]}
  {"ok": false, "error": "..."}

SAFETY: this script only PARSES code (ast.parse / tokenize). It never runs it.

HOW IT WORKS (read this first if you are learning from this file)
  1. Parse the code into a tree (ast) so we understand its structure, not just its text.
  2. Each "rule" looks at the tree and proposes EDITS: "replace bytes 120-150 with X".
     Editing the original text (instead of regenerating it from the tree) keeps the
     user's formatting and comments intact wherever we did not touch them.
  3. Non-overlapping edits are applied. If the result no longer parses, we fall back to
     applying the edits one at a time and keep only those that still parse.
  4. Repeat (a rewrite can expose another one) until nothing changes.
  5. Finally remove comments that do not explain WHY, and tidy blank lines.
"""
import ast
import io
import json
import re
import sys
import tokenize
from collections import Counter, defaultdict

MAX_PASSES = 6
TERMINATORS = (ast.Return, ast.Raise, ast.Break, ast.Continue)
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
AUG_OPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)

# Comments matching this are kept: they usually explain WHY, or are tool directives.
KEEP_COMMENT = re.compile(
    r"\b(because|why|so that|workaround|hack|todo|fixme|xxx|note|warning|careful|must|"
    r"otherwise|due to|bug|issue|avoid|ensure|legacy|deprecated|security|important|beware|"
    r"caveat|assumes?|invariant|unless|except when|reason)\b"
    r"|noqa|type:|pylint|pragma|mypy|isort|fmt:|coding[:=]|copyright|license|https?://",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------- source model
class Source:
    """The code as UTF-8 bytes plus line start offsets.

    Python's ast reports columns as UTF-8 BYTE offsets, so we edit bytes, not str.
    """

    def __init__(self, text):
        self.data = text.encode("utf-8")
        self.lines = self.data.split(b"\n")
        self.starts = []
        pos = 0
        for line in self.lines:
            self.starts.append(pos)
            pos += len(line) + 1

    def offset(self, lineno, col):
        return self.starts[lineno - 1] + col

    def node_range(self, node):
        return (
            self.offset(node.lineno, node.col_offset),
            self.offset(node.end_lineno, node.end_col_offset),
        )

    def line_range(self, first, last):
        """Byte range covering whole lines first..last (1-based), including the newline."""
        start = self.starts[first - 1]
        end = self.starts[last] if last < len(self.lines) else len(self.data)
        return start, end


def first_line(node):
    """First line of a statement, including any decorators above it."""
    lines = [node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])]
    return min(lines)


def owns_lines(src, first_stmt, last_stmt):
    """True if the statements start and end on their own lines (safe to delete whole lines)."""
    fl = first_line(first_stmt)
    line = src.lines[fl - 1]
    indent = len(line) - len(line.lstrip())
    if indent != first_stmt.col_offset:
        return False
    tail = src.lines[last_stmt.end_lineno - 1][last_stmt.end_col_offset:].strip()
    return tail == b"" or tail.startswith(b"#")


def delete_lines(src, first_stmt, last_stmt):
    start, end = src.line_range(first_line(first_stmt), last_stmt.end_lineno)
    return (start, end, b"")


# --------------------------------------------------------------------------- tree helpers
def stmt_lists(tree):
    """Every list of statements in the tree (module body, function bodies, if/else bodies...)."""
    for node in ast.walk(tree):
        for field in ("body", "orelse", "finalbody"):
            value = getattr(node, field, None)
            if isinstance(value, list) and value and isinstance(value[0], ast.stmt):
                yield value


def lists_in_scope(scope):
    """Statement lists belonging to ONE function (not crossing into nested functions/classes)."""
    stack = [scope]
    while stack:
        node = stack.pop()
        for field in ("body", "orelse", "finalbody"):
            value = getattr(node, field, None)
            if isinstance(value, list) and value and isinstance(value[0], ast.stmt):
                yield value
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, SCOPES):
                stack.append(child)


def walk_scope(scope):
    """All nodes of one scope. Nested scopes are yielded but not entered."""
    stack = [scope]
    while stack:
        node = stack.pop()
        yield node
        for child in ast.iter_child_nodes(node):
            if isinstance(child, SCOPES):
                yield child
            else:
                stack.append(child)


def is_multiline_string(node):
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, (str, bytes))
        and node.end_lineno > node.lineno
    ) or (isinstance(node, ast.JoinedStr) and node.end_lineno > node.lineno)


def is_pure(value):
    """True for literals whose evaluation cannot have side effects."""
    if isinstance(value, ast.Constant):
        return True
    if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
        return all(is_pure(e) for e in value.elts)
    if isinstance(value, ast.Dict):
        return all(k is not None and is_pure(k) for k in value.keys) and all(
            is_pure(v) for v in value.values
        )
    return False


# --------------------------------------------------------------------------- rules
# Each rule appends edits to `out`: (start_byte, end_byte, replacement_bytes, rule_id, detail)


def rule_unreachable(tree, src, out):
    """Code after return/raise/break/continue can never run."""
    for lst in stmt_lists(tree):
        for i, stmt in enumerate(lst[:-1]):
            if isinstance(stmt, TERMINATORS):
                rest = lst[i + 1:]
                if owns_lines(src, rest[0], rest[-1]):
                    s, e, r = delete_lines(src, rest[0], rest[-1])
                    out.append((s, e, r, "unreachable", len(rest)))
                break


def rule_pass(tree, src, out):
    """`pass` is only needed in an otherwise empty block."""
    for lst in stmt_lists(tree):
        if len(lst) > 1 and any(not isinstance(s, ast.Pass) for s in lst):
            for stmt in lst:
                if isinstance(stmt, ast.Pass) and owns_lines(src, stmt, stmt):
                    s, e, r = delete_lines(src, stmt, stmt)
                    out.append((s, e, r, "pass", 1))


def rule_trailing_return(tree, src, out):
    """A bare `return` / `return None` as the last line of a function does nothing."""
    for node in ast.walk(tree):
        if isinstance(node, FUNCTIONS) and len(node.body) > 1:
            last = node.body[-1]
            if (
                isinstance(last, ast.Return)
                and (last.value is None or (isinstance(last.value, ast.Constant) and last.value.value is None))
                and owns_lines(src, last, last)
            ):
                s, e, r = delete_lines(src, last, last)
                out.append((s, e, r, "trailing_return", 1))


ELSE_RE = re.compile(rb"^(\s*)else\s*:\s*(#.*)?$")


def rule_else_after_exit(tree, src, out):
    """`if c: return x / else: y`  ->  `if c: return x` then `y` (one level less nesting)."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.If) or not node.orelse or not node.body:
            continue
        if not isinstance(node.body[-1], TERMINATORS):
            continue
        if src.lines[node.lineno - 1].lstrip().startswith(b"elif"):
            continue  # this `if` is itself an elif branch: flattening would change the logic
        first = node.orelse[0]
        # Find the `else:` line by scanning upwards from the first else-statement.
        idx = first_line(first) - 2
        else_idx = None
        while idx >= node.lineno - 1:
            line = src.lines[idx]
            m = ELSE_RE.match(line)
            if m and len(m.group(1)) == node.col_offset:
                else_idx = idx
                break
            if line.strip() == b"" or line.lstrip().startswith(b"#"):
                idx -= 1
                continue
            break
        if else_idx is None:
            continue  # it was an `elif` (or odd layout): leave it alone
        if any(is_multiline_string(n) for s in node.orelse for n in ast.walk(s)):
            continue  # dedenting would change the text inside multi-line strings
        shift = first.col_offset - node.col_offset
        if shift <= 0:
            continue
        last_line = node.orelse[-1].end_lineno
        new_lines, ok = [], True
        for ln in range(else_idx + 2, last_line + 1):
            line = src.lines[ln - 1]
            if line.strip() == b"":
                new_lines.append(b"")
            elif line[:shift].strip() == b"" and len(line[:shift]) == shift:
                new_lines.append(line[shift:])
            else:
                ok = False
                break
        if not ok:
            continue
        start = src.starts[else_idx]
        end = src.line_range(last_line, last_line)[1]
        out.append((start, end, b"\n".join(new_lines) + b"\n", "else_after_exit", 1))


def _is_none(n):
    return isinstance(n, ast.Constant) and n.value is None


def rule_none_compare(tree, src, out):
    """`x == None` -> `x is None` (and `!=` -> `is not`)."""
    in_fstring = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.JoinedStr):
            in_fstring.update(id(c) for c in ast.walk(n))
    for node in ast.walk(tree):
        if id(node) in in_fstring:  # positions inside f-strings are unreliable before 3.12
            continue
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], (ast.Eq, ast.NotEq)):
            left, right = node.left, node.comparators[0]
            if _is_none(right) and not _is_none(left):
                subject = left
            elif _is_none(left) and not _is_none(right):
                subject = right
            else:
                continue
            op = ast.Is() if isinstance(node.ops[0], ast.Eq) else ast.IsNot()
            new = ast.Compare(left=subject, ops=[op], comparators=[ast.Constant(value=None)])
            s, e = src.node_range(node)
            out.append((s, e, ast.unparse(new).encode("utf-8"), "none_compare", 1))


def _analyse_scope(scope, always_excluded):
    """Find `x = x + y` statements that are safe to turn into `x += y`.

    `x += y` can behave differently from `x = x + y` for MUTABLE objects (lists, arrays),
    so we only rewrite names we can prove hold immutable values: every assignment to the
    name in this scope is a number/string constant or one of these accumulations.
    """
    excluded = set(always_excluded)
    good = set()
    const_assigned = set()
    candidates = []
    for n in walk_scope(scope):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            target, value = n.targets[0], n.value
            if isinstance(value, ast.Constant) and isinstance(value.value, (int, float, str)):
                good.add(id(target))
                const_assigned.add(target.id)
            elif (
                isinstance(value, ast.BinOp)
                and isinstance(value.op, AUG_OPS)
                and isinstance(value.left, ast.Name)
                and value.left.id == target.id
            ):
                good.add(id(target))
                candidates.append(n)
        elif isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name):
            good.add(id(n.target))
    for n in walk_scope(scope):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)) and id(n) not in good:
            excluded.add(n.id)
        elif isinstance(n, ast.arg):
            excluded.add(n.arg)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not scope:
            excluded.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                excluded.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            excluded.add(n.name)
        elif type(n).__name__ in ("MatchAs", "MatchStar") and getattr(n, "name", None):
            excluded.add(n.name)
        elif type(n).__name__ == "MatchMapping" and getattr(n, "rest", None):
            excluded.add(n.rest)
    return [c for c in candidates if c.targets[0].id in const_assigned and c.targets[0].id not in excluded]


def rule_augassign(tree, src, out):
    declared = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.Global, ast.Nonlocal)):
            declared.update(n.names)
    scopes = [tree] + [n for n in ast.walk(tree) if isinstance(n, FUNCTIONS)]
    for scope in scopes:
        for stmt in _analyse_scope(scope, declared):
            if stmt.end_lineno != stmt.lineno:
                continue  # multi-line: rewriting could drop comments inside it
            value = stmt.value
            new = ast.AugAssign(
                target=ast.Name(id=stmt.targets[0].id, ctx=ast.Store()), op=value.op, value=value.right
            )
            s, e = src.node_range(stmt)
            out.append((s, e, ast.unparse(new).encode("utf-8"), "augassign", 1))


def rule_unused_imports(tree, src, out):
    """Remove module-level imports whose names are never used."""
    for n in ast.walk(tree):
        targets = []
        if isinstance(n, ast.Assign):
            targets = n.targets
        elif isinstance(n, (ast.AugAssign, ast.AnnAssign)):
            targets = [n.target]
        if any(isinstance(t, ast.Name) and t.id == "__all__" for t in targets):
            return  # the module declares its public names: imports may be re-exports
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    for n in ast.walk(tree):  # names mentioned inside strings (annotations, eval, doctests)
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            used.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", n.value))
    for stmt in tree.body:
        is_import = isinstance(stmt, ast.Import)
        is_from = isinstance(stmt, ast.ImportFrom) and stmt.module != "__future__"
        if not (is_import or is_from):
            continue
        if any(a.name == "*" for a in stmt.names):
            continue
        text = b"\n".join(src.lines[stmt.lineno - 1:stmt.end_lineno])
        if b"noqa" in text:
            continue
        keep, drop = [], []
        for a in stmt.names:
            bound = (a.asname or a.name).split(".")[0]
            reexport = a.asname is not None and a.asname == a.name  # `import x as x` marks a re-export
            (keep if (bound in used or reexport) else drop).append(a)
        if not drop:
            continue
        names = ", ".join((a.asname or a.name) for a in drop)
        if not keep:
            if owns_lines(src, stmt, stmt):
                s, e, r = delete_lines(src, stmt, stmt)
                out.append((s, e, r, "unused_import", names))
        else:
            if is_import:
                new = ast.Import(names=keep)
            else:
                new = ast.ImportFrom(module=stmt.module, names=keep, level=stmt.level)
            s, e = src.node_range(stmt)
            out.append((s, e, ast.unparse(new).encode("utf-8"), "unused_import", names))


def rule_unused_locals(tree, src, out):
    """Remove `name = <constant>` inside a function when `name` is never read."""
    for func in [n for n in ast.walk(tree) if isinstance(n, FUNCTIONS)]:
        all_names = {n.id for n in ast.walk(func) if isinstance(n, ast.Name)}
        if all_names & {"locals", "vars", "eval", "exec", "globals", "dir"}:
            continue  # these can read variables by name, so we cannot prove anything
        loaded = {n.id for n in ast.walk(func) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
        blocked = set()
        for n in ast.walk(func):
            if isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name):
                blocked.add(n.target.id)
            elif isinstance(n, ast.Delete):
                blocked.update(t.id for t in n.targets if isinstance(t, ast.Name))
            elif isinstance(n, (ast.Global, ast.Nonlocal)):
                blocked.update(n.names)
            elif isinstance(n, ast.arg):
                blocked.add(n.arg)
        for lst in lists_in_scope(func):
            doomed = [
                s
                for s in lst
                if isinstance(s, ast.Assign)
                and len(s.targets) == 1
                and isinstance(s.targets[0], ast.Name)
                and is_pure(s.value)
                and s.targets[0].id not in loaded
                and s.targets[0].id not in blocked
                and owns_lines(src, s, s)
            ]
            if len(doomed) == len(lst):
                doomed = doomed[:-1]  # never leave an empty block
            for s in doomed:
                a, b, r = delete_lines(src, s, s)
                out.append((a, b, r, "unused_local", s.targets[0].id))


RULES = [
    rule_unreachable,
    rule_pass,
    rule_trailing_return,
    rule_else_after_exit,
    rule_none_compare,
    rule_augassign,
    rule_unused_imports,
    rule_unused_locals,
]


# --------------------------------------------------------------------------- applying edits
def parses(text):
    try:
        ast.parse(text)
        return True
    except (SyntaxError, ValueError, RecursionError):
        return False


def apply_bytes(data, edits):
    for start, end, repl, *_ in sorted(edits, key=lambda e: e[0], reverse=True):
        data = data[:start] + repl + data[end:]
    return data


def resolve_overlaps(edits):
    kept, last_end = [], -1
    for e in sorted(edits, key=lambda e: (e[0], e[1])):
        if e[0] >= last_end:
            kept.append(e)
            last_end = e[1]
    return kept


def apply_edits(src, edits):
    """Apply all edits; if the result is invalid Python, keep only the edits that are safe."""
    edits = resolve_overlaps(edits)
    candidate = apply_bytes(src.data, edits).decode("utf-8")
    if parses(candidate):
        return candidate, edits
    data, applied = src.data, []
    for e in sorted(edits, key=lambda e: e[0], reverse=True):  # back to front keeps offsets valid
        trial = apply_bytes(data, [e])
        if parses(trial.decode("utf-8")):
            data, applied = trial, applied + [e]
    return data.decode("utf-8"), applied


# --------------------------------------------------------------------------- comments + whitespace
def clean_comments(text):
    """Drop comments that do not explain WHY; strip trailing spaces; collapse blank runs."""
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return text, 0, 0
    lines = text.split("\n")
    protected = set()  # 0-based rows inside multi-line strings: never touch their whitespace
    fstring_starts = []
    fs_start, fs_end = getattr(tokenize, "FSTRING_START", None), getattr(tokenize, "FSTRING_END", None)
    delete_rows, removed, kept = set(), 0, 0
    for tok in tokens:
        if tok.type == tokenize.STRING and tok.start[0] != tok.end[0]:
            protected.update(range(tok.start[0] - 1, tok.end[0] - 1))
        elif fs_start is not None and tok.type == fs_start:
            fstring_starts.append(tok.start[0])
        elif fs_end is not None and tok.type == fs_end and fstring_starts:
            begin = fstring_starts.pop()
            protected.update(range(begin - 1, tok.end[0] - 1))
        elif tok.type == tokenize.COMMENT:
            row, col = tok.start
            keep = KEEP_COMMENT.search(tok.string) or (row <= 2 and tok.string.startswith("#!"))
            if keep:
                kept += 1
                continue
            removed += 1
            if lines[row - 1][:col].strip() == "":
                delete_rows.add(row - 1)
            else:
                lines[row - 1] = lines[row - 1][:col].rstrip()
    out, blank_run = [], 0
    for i, line in enumerate(lines):
        if i in delete_rows:
            continue
        if i not in protected:
            line = line.rstrip()
        if line == "" and i not in protected:
            blank_run += 1
            if blank_run > 2:
                continue
        else:
            blank_run = 0
        out.append(line)
    while out and out[0].strip() == "":
        out.pop(0)
    while out and out[-1].strip() == "":
        out.pop()
    return "\n".join(out) + "\n", removed, kept


# --------------------------------------------------------------------------- orchestration
def simplify(code):
    if not hasattr(ast, "unparse"):
        raise RuntimeError("Python 3.9+ is required")
    text = code.replace("\r\n", "\n").replace("\r", "\n")
    ast.parse(text)  # raises SyntaxError for non-Python-3 input
    counts, details = Counter(), defaultdict(list)
    for _ in range(MAX_PASSES):
        tree = ast.parse(text)
        src = Source(text)
        edits = []
        for rule in RULES:
            rule(tree, src, edits)
        if not edits:
            break
        new_text, applied = apply_edits(src, edits)
        if new_text == text or not applied:
            break
        for _s, _e, _r, rule_id, detail in applied:
            if isinstance(detail, int):
                counts[rule_id] += detail
            else:
                counts[rule_id] += 1
                details[rule_id].append(detail)
        text = new_text
    cleaned, removed, kept = clean_comments(text)
    if parses(cleaned):
        text = cleaned
        if removed:
            counts["comments"] += removed
    changes = [
        {"rule": rule, "count": n, "detail": ", ".join(dict.fromkeys(details.get(rule, [])))}
        for rule, n in counts.items()
    ]
    return {"code": text, "changes": changes, "keptComments": kept}


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        out = {"ok": True, **simplify(payload["code"])}
    except SyntaxError as e:
        out = {"ok": False, "error": "not valid Python 3 (line %s: %s)" % (e.lineno, e.msg)}
    except Exception as e:  # always answer with JSON, never a traceback
        out = {"ok": False, "error": type(e).__name__}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=True).encode("ascii"))


if __name__ == "__main__":
    main()
