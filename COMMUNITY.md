# Community resources for sarvamai-cli

This file contains ready-to-use content for promoting sarvamai-cli.
Pick what's useful, edit to your voice, and share.

---

## 1. Sarvam Discord post

Post in Sarvam's Discord (https://discord.com/invite/5rAsykttcs) in the
#general or #showcase channel.

---

Hey folks — long-time lurker, first time posting here. rrskris here.

I've been hacking on **sarvamai-cli**, a terminal coding agent built on the
**official sarvamai SDK**. It runs in your terminal, calls four tools
(`read_file`, `write_file`, `patch`, `run_shell`), and asks for approval
before any mutation — so nothing gets written or run behind your back.

A few things I'm finding genuinely useful:
- **Ctrl+O** toggles reasoning tokens mid-session
- **/model** swaps models without restarting
- **!** drops you into a shell escape
- OpenAI-compatible fallback for when you want to compare providers

It's MIT-licensed, v0.2.10, and rough around the edges — which is exactly
why I'm posting. If a few of you could kick the tires and tell me what's
broken, missing, or just feels off, I'd really appreciate it.

Repo: https://github.com/indic-ai-contribs/sarvamai-cli

No pitch, no launch — just looking for honest feedback from people who
actually care about Sarvam models. Thanks.

---

## 2. Dev.to / blog post

Title: "I let sarvamai-cli write, run, and fix a test. Here's what happened."

---

I had a tiny `math_utils.py` with a buggy `is_prime` — it returned `True`
for `1`. Instead of fixing it myself, I wanted to see whether sarvamai-cli
could read the file, write a test, run it, catch the failure, and patch
the bug. One loop, no hand-holding.

Here's `math_utils.py`:

```python
def is_prime(n):
    if n % 2 == 0:
        return n == 2
    i = 3
    while i * i <= n:
        if n % i == 0:
            return False
        i += 2
    return True
```

Classic off-by-one: `is_prime(1)` walks into the `while`, skips it, and
returns `True`.

### Read the file, propose a test

I started the agent and described the task in one line. It called
`read_file`, then immediately drafted a test:

```
▸ read_file {"path":"math_utils.py"}
  ↳ 9 lines read

▸ write_file {"path":"test_math_utils.py"}
  proposed content:
    from math_utils import is_prime

    def test_is_prime():
        assert is_prime(2)
        assert is_prime(3)
        assert not is_prime(1)
        assert not is_prime(4)
        assert not is_prime(9)
  approve? [y/N]
> y
  ↳ wrote test_math_utils.py
```

The thing to notice: it paused. It didn't write silently. Every mutation
in sarvamai-cli goes through an approval gate, so you see the exact content
before it lands on disk.

### Run the test, watch it fail

```
▸ run_shell {"command":"python -m pytest test_math_utils.py -q"}
  approve? [y/N]
> y
  ↳ exit 1
    FAILED test_math_utils.py::test_is_prime
    assert not is_prime(1)  # is_prime(1) returned True
```

### Reasoning, then a patch

I hit **Ctrl+O** to flip reasoning on. The agent streamed its thinking —
natively, using Sarvam's reasoning tokens, not a separate "explain
yourself" step — then proposed a patch:

```
[reasoning] n=1 skips the while loop entirely, so it falls through to
return True. Guard n < 2 first.

▸ patch {"path":"math_utils.py"}
    - def is_prime(n):
    -     if n % 2 == 0:
    -         return n == 2
    + def is_prime(n):
    +     if n < 2:
    +         return False
    +     if n % 2 == 0:
    +         return n == 2
  approve? [y/N]
> y
  ↳ patched math_utils.py
```

### Re-run, green

```
▸ run_shell {"command":"python -m pytest test_math_utils.py -q"}
  approve? [y/N]
> y
  ↳ exit 0
    1 passed
✓ done
```

### What made this feel different

Three things stood out across the loop.

First, the **reasoning tokens are Sarvam-native**. Hitting Ctrl+O didn't
trigger a second model call or a bolted-on "thinking mode" — the reasoning
was already there, part of the same stream, and I just toggled whether to
render it. That keeps latency flat and the reasoning honest.

Second, **approval gates on every mutation**. `write_file`, `patch`, and
`run_shell` all prompt. I approved each one knowing exactly what would
change. In a longer session that's the difference between trusting the
agent and babysitting it.

Third, **compact output**. Between steps there's no essay — just the tool
call, the approval line, and the result. The terminal stays readable even
after a dozen turns, which matters more than it sounds.

It's v0.2.10, MIT-licensed, and still rough around the edges. If you want
to kick the tires: https://github.com/indic-ai-contribs/sarvamai-cli. Point
it at a real file in one of your projects and tell me where it stumbles —
that's the feedback I actually need.

---
