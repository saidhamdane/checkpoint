# checkpoint-guard

Python client for [Checkpoint](https://github.com/saidhamdane/checkpoint), a safety gate for AI agents.
Before your agent pays, deletes or emails anyone, Checkpoint answers **allow**, **block** or **ask a human** (Telegram).

```bash
pip install checkpoint-guard
```

```python
import os
from checkpoint_guard import Checkpoint, CheckpointBlocked

cp = Checkpoint(
    api_key=os.environ["CHECKPOINT_KEY"],  # free key: https://checkpoint.saidmatorral.workers.dev
    base_url="https://checkpoint.saidmatorral.workers.dev",
    agent_id="ops-bot",
)

@cp.guard("bank.transfer", describe=lambda amount, iban: f"Send {amount} EUR to {iban}")
def transfer(amount, iban):
    ...

try:
    transfer(5000, "ES91 2100 0418 4502 0005 1332")
except CheckpointBlocked as e:
    print(e)  # Checkpoint blocked action: Blocked: Moves money (97%)
```

- `allow` runs the function.
- `block` raises `CheckpointBlocked`.
- `ask` waits for Approve/Deny on Telegram (up to 10 minutes by default), then runs or raises.

`cp.check(tool, description=..., input=..., dry_run=True)` returns the decision without sending an approval request.

Standard library only. Python 3.9+. MIT license.
