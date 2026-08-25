"""Sample MAF handoff orchestrator used for manual demos (test-requirements.md) and as the
production code path exercised by the automated Layer 1 tests (see tests/test_server.py,
which builds workflows from fake agents instead of this module's real OpenAI-backed agents).

Kept deliberately small: three cooperative participants (triage / billing / refunds) whose
system prompts explicitly instruct them to comply with an explicit user handoff request, so
that Demo 3's `steer_to_agent` nudge (test-requirements.md row 12) is reliably observable.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from agent_framework import tool
from agent_framework.openai import OpenAIChatClient
from agent_framework import Workflow
from agent_framework_orchestrations import HandoffBuilder

from .protocol import OrchestratorManifestEntry, Participant

RunLocalCommand = Callable[[str], Awaitable[str]]

# Explicit compliance instruction appended to every sample agent's prompt so that an advisory
# `steer_to_agent` nudge (design-proposal.md WS1) is honored whenever it's on-topic for the
# agent to comply with. This does not make steering a hard override — see test-requirements.md
# Demo 3 row 14 for the documented negative case.
_HANDOFF_COMPLIANCE_INSTRUCTION = (
    "If the user explicitly asks to be transferred or handed off to a specific colleague by "
    "name, comply by handing off to them, unless doing so would be clearly irrelevant to their "
    "request."
)

_TRIAGE_INSTRUCTIONS = (
    "You are a front-line support triage agent. Greet the user, understand their need, and "
    "hand off to 'billing' for billing/invoice questions or 'refunds' for refund requests. "
    "Handle anything else yourself. " + _HANDOFF_COMPLIANCE_INSTRUCTION
)
_BILLING_INSTRUCTIONS = (
    "You are a billing support agent. Help with invoices, charges, and payment methods. "
    "Hand off to 'refunds' if the user asks about a refund instead. " + _HANDOFF_COMPLIANCE_INSTRUCTION
)
_REFUNDS_INSTRUCTIONS = (
    "You are a refunds agent. Help process refund requests and explain refund policy. "
    "Hand off to 'billing' if the user asks a billing question instead. " + _HANDOFF_COMPLIANCE_INSTRUCTION
)


@dataclass(frozen=True)
class OrchestratorSpec:
    """Manifest metadata plus a factory for the underlying Workflow.

    Manifest fields are tracked explicitly here rather than introspected from
    `Workflow.executors`, since that internal dict is not a stable/public participant list.
    """

    id: str
    name: str
    description: str
    participant_ids: tuple[str, ...]
    build: Callable[[RunLocalCommand], Workflow]

    def manifest_entry(self) -> OrchestratorManifestEntry:
        return OrchestratorManifestEntry(
            id=self.id,
            name=self.name,
            description=self.description,
            participants=[Participant(id=pid, name=pid) for pid in self.participant_ids],
        )


def make_run_local_command_tool(run_local_command: RunLocalCommand):
    """Wrap a per-connection `run_local_command` bridge callable as a `FunctionTool` agents can
    call. Factored out so tests can attach the exact same tool implementation to fake agents
    without duplicating the wrapping logic (see tests/test_server.py's tool-bridge fixture).
    """

    async def run_local_command_tool(
        command: Annotated[str, "The shell command to run in the user's local workspace."],
    ) -> str:
        """Run a shell command in the user's local workspace and return its combined output."""
        return await run_local_command(command)

    return tool(
        run_local_command_tool,
        name="run_local_command",
        description="Run a shell command in the user's local workspace and return its combined output.",
    )


def _build_sample_support_workflow(run_local_command: RunLocalCommand) -> Workflow:
    local_command_tool = make_run_local_command_tool(run_local_command)

    client = OpenAIChatClient()
    triage = client.as_agent(instructions=_TRIAGE_INSTRUCTIONS, name="triage", tools=[local_command_tool])
    billing = client.as_agent(instructions=_BILLING_INSTRUCTIONS, name="billing", tools=[local_command_tool])
    refunds = client.as_agent(instructions=_REFUNDS_INSTRUCTIONS, name="refunds", tools=[local_command_tool])
    return (
        HandoffBuilder(
            name="support",
            description="Support triage handoff group: triage, billing, refunds",
            participants=[triage, billing, refunds],
        )
        .with_start_agent(triage)
        .build()
    )


SAMPLE_SUPPORT_ORCHESTRATOR = OrchestratorSpec(
    id="support",
    name="Support Triage",
    description="Support triage handoff group: triage, billing, refunds",
    participant_ids=("triage", "billing", "refunds"),
    build=_build_sample_support_workflow,
)


def default_orchestrators() -> list[OrchestratorSpec]:
    """The orchestrator registry served by `GET /agents/manifest`.

    A single sample orchestrator today; add entries here as more demo workflows are needed.
    """

    return [SAMPLE_SUPPORT_ORCHESTRATOR]
