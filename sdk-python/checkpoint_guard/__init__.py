"""Checkpoint Python SDK — standard library only.

    from checkpoint_guard import Checkpoint, CheckpointBlocked

    cp = Checkpoint(api_key=os.environ["CHECKPOINT_KEY"], base_url="https://checkpoint.you.workers.dev")

    @cp.guard("stripe.refund")
    def refund(amount, customer):
        ...

    refund(amount=80, customer="cus_123")   # raises CheckpointBlocked if denied
"""

from __future__ import annotations

import functools
import inspect
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

__all__ = ["Checkpoint", "CheckpointBlocked"]


def _named_args(fn, args, kwargs) -> dict:
    """Send arguments by parameter name, e.g. {"amount": 5000, "iban": "ES91..."}."""
    try:
        bound = inspect.signature(fn).bind_partial(*args, **kwargs)
        return dict(bound.arguments)
    except (TypeError, ValueError):
        return {"args": list(args), "kwargs": kwargs} if args else dict(kwargs)


class CheckpointBlocked(Exception):
    def __init__(self, result: Optional[dict], reason: str):
        super().__init__(f"Checkpoint blocked action: {reason}")
        self.result = result


class Checkpoint:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        agent_id: Optional[str] = None,
        policies: Optional[list[str]] = None,
        thresholds: Optional[dict] = None,
        approval_timeout: float = 600,
        poll_interval: float = 3,
        on_unreachable: str = "closed",
        timeout: float = 10,
    ):
        if not api_key or not base_url:
            raise ValueError("api_key and base_url are required")
        self.api_key = api_key
        self.base = base_url.rstrip("/")
        self.agent_id = agent_id
        self.policies = policies
        self.thresholds = thresholds
        self.approval_timeout = approval_timeout
        self.poll_interval = poll_interval
        self.on_unreachable = on_unreachable
        self.timeout = timeout

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {self.api_key}",
                "content-type": "application/json",
                # Cloudflare rejects the default "Python-urllib" user agent with 403.
                "user-agent": "checkpoint-guard-python/0.1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode())

    def check(self, tool: str, input: Any = None, description: Optional[str] = None,
              context: Optional[str] = None, dry_run: bool = False) -> dict:
        """Ask Checkpoint about one action. Does not wait for human approval.

        dry_run=True computes and logs the decision without sending an approval request.
        """
        body = {
            "action": {"tool": tool, "input": input, "description": description},
            "context": context,
            "agent_id": self.agent_id,
            "policies": self.policies,
            "thresholds": self.thresholds,
            "dry_run": True if dry_run else None,
        }
        return self._request("POST", "/v1/check", {k: v for k, v in body.items() if v is not None})

    def wait_for_approval(self, approval_id: str) -> bool:
        deadline = time.monotonic() + self.approval_timeout
        path = "/v1/approvals/" + urllib.parse.quote(approval_id, safe="")
        while time.monotonic() < deadline:
            try:
                status = self._request("GET", path).get("status")
                if status == "approved":
                    return True
                if status in ("denied", "expired"):
                    return False
            except (urllib.error.URLError, TimeoutError, ValueError):
                pass
            time.sleep(self.poll_interval)
        return False

    def enforce(self, tool: str, input: Any = None, description: Optional[str] = None,
                context: Optional[str] = None) -> Optional[dict]:
        """Check, wait for approval if needed, raise CheckpointBlocked unless allowed."""
        try:
            result = self.check(tool, input, description, context)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            if self.on_unreachable == "open":
                return None
            raise CheckpointBlocked(None, f"checkpoint unreachable ({e})") from e

        decision = result.get("decision")
        if decision == "allow":
            return result
        if decision == "block":
            raise CheckpointBlocked(result, result.get("reason", "blocked"))
        approval_id = result.get("approval_id")
        if approval_id and self.wait_for_approval(approval_id):
            return result
        raise CheckpointBlocked(result, "not approved: " + result.get("reason", ""))

    def guard(self, tool: str, describe: Optional[Callable[..., str]] = None):
        """Decorator: every call to the function goes through Checkpoint first."""
        def deco(fn):
            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                payload = _named_args(fn, args, kwargs)
                self.enforce(tool, input=payload,
                             description=describe(*args, **kwargs) if describe else None)
                return fn(*args, **kwargs)
            return wrapper
        return deco
