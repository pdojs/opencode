"""Wire protocol for the OpenCode <-> MAF handoff bridge WebSocket channel.

This is the Python side of the contract; `packages/core/src/session/execution/remote-protocol.ts`
in the opencode repo is a manually-kept-in-sync TypeScript mirror (see design-proposal.md WS2
step 2 for the cross-repo drift note). Keep both in sync whenever a frame shape changes here.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

# region client -> server frames


class UserMessageFrame(BaseModel):
    """A new user turn. Sent for the first message and for follow-up steer/queue messages."""

    type: Literal["user_message"] = "user_message"
    text: str


class ToolResultFrame(BaseModel):
    """Result of a tool call the client executed locally, in response to a `ToolCallFrame`."""

    type: Literal["tool_result"] = "tool_result"
    call_id: str
    output: str


class SteerToAgentFrame(BaseModel):
    """Advisory nudge asking the currently active participant to hand off to `agent_id`.

    Best-effort only: MAF's handoff routing is entirely decided by the active agent's own
    `handoff_to_<target_id>` tool call (see `_handoff.py`). There is no force-override API, so
    this frame is implemented as a synthetic instruction injected as the active agent's next
    input, not a hard redirect.
    """

    type: Literal["steer_to_agent"] = "steer_to_agent"
    agent_id: str


ClientFrame = Annotated[
    Union[UserMessageFrame, ToolResultFrame, SteerToAgentFrame],
    Field(discriminator="type"),
]

# endregion

# region server -> client frames


class AssistantDeltaFrame(BaseModel):
    """An incremental text chunk from whichever agent currently holds the conversation."""

    type: Literal["assistant_delta"] = "assistant_delta"
    agent_id: str
    text: str


class HandoffFrame(BaseModel):
    """Emitted whenever the workflow's `HandoffSentEvent` fires."""

    type: Literal["handoff"] = "handoff"
    source: str
    target: str


class ToolCallFrame(BaseModel):
    """The active agent invoked a tool the client must execute locally (bash/edit-style)."""

    type: Literal["tool_call"] = "tool_call"
    call_id: str
    name: str
    arguments: dict


class TurnCompleteFrame(BaseModel):
    """The current turn has finished (workflow is idle or awaiting the next user input)."""

    type: Literal["turn_complete"] = "turn_complete"


class ErrorFrame(BaseModel):
    """An unrecognized frame type or a server-side failure, sent back to the client."""

    type: Literal["error"] = "error"
    message: str


ServerFrame = Annotated[
    Union[AssistantDeltaFrame, HandoffFrame, ToolCallFrame, TurnCompleteFrame, ErrorFrame],
    Field(discriminator="type"),
]

# endregion


class Participant(BaseModel):
    id: str
    name: str


class OrchestratorManifestEntry(BaseModel):
    id: str
    name: str
    description: str
    participants: list[Participant]


class Manifest(BaseModel):
    orchestrators: list[OrchestratorManifestEntry]
