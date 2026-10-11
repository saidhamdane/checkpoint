"""A tiny "agent" that runs three actions through Checkpoint. Made for the demo video.

    export CHECKPOINT_KEY=ck_live_...
    export CHECKPOINT_URL=https://checkpoint.<you>.workers.dev
    python3 examples/demo_agent.py

Uses only the standard library plus the SDK in ../sdk-python.
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk-python"))
from checkpoint_guard import Checkpoint, CheckpointBlocked  # noqa: E402

GREEN, AMBER, RED, DIM, BOLD, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"

cp = Checkpoint(
    api_key=os.environ["CHECKPOINT_KEY"],
    base_url=os.environ.get("CHECKPOINT_URL", "https://checkpoint.saidmatorral.workers.dev"),
    agent_id="demo-agent",
    approval_timeout=120,
    poll_interval=2,
)


def say(text, delay=0.02):
    for ch in text:
        sys.stdout.write(ch)
        sys.stdout.flush()
        time.sleep(delay)
    print()


@cp.guard("web.search", describe=lambda q: f"Search the web for: {q}")
def search(q):
    return f"Sunny, 24°C in Corralejo"


@cp.guard("gmail.send", describe=lambda to: f"Reply to an angry customer ({to}) and promise a full refund")
def reply(to):
    return f"Email sent to {to}"


@cp.guard("bank.transfer", describe=lambda amount, iban: f"Send {amount} EUR to a new IBAN {iban}")
def transfer(amount, iban):
    return f"Sent {amount} EUR"


def run(label, fn, *args):
    say(f"\n{BOLD}🤖 Agent:{RESET} {label}")
    say(f"{DIM}   checking with Checkpoint…{RESET}", 0.01)
    try:
        out = fn(*args)
        say(f"   {GREEN}✅ ALLOWED{RESET}  {out}")
    except CheckpointBlocked as e:
        r = e.result
        if r is None:
            say(f"   {AMBER}⚠ CHECKPOINT UNREACHABLE{RESET}  action not run (fail-closed): {e}")
            return
        if r.get("decision") == "ask":
            say(f"   {AMBER}⏳ ASKED A HUMAN{RESET}  answer came back: not approved")
        else:
            say(f"   {RED}🛑 BLOCKED{RESET}  {r.get('reason', str(e))}")


if __name__ == "__main__":
    run("check tomorrow's weather", search, "weather Corralejo tomorrow")
    run("reply to an angry customer and promise a full refund (waiting for your phone…)", reply, "client@example.com")
    run("send 5,000 EUR to a new IBAN", transfer, 5000, "ES91 2100 0418 4502 0005 1332")
    print()
