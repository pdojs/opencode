"""FastAPI/WebSocket server bridging a MAF handoff `Workflow` to OpenCode's remote-agent
wire protocol (see protocol.py). One Workflow instance is created per WebSocket connection.

Endpoints:
  GET  /agents/manifest        -> Manifest of configured orchestrators + participants.
  WS   /agents/{id}/session    -> Chat + tool-bridge + handoff-status channel for one session.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterable

from agent_framework import AgentResponse, AgentResponseUpdate, WorkflowEvent
from agent_framework.orchestrations import HandoffAgentUserRequest, HandoffSentEvent
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from opentelemetry import trace

from .orchestrator import PATTERN_SEMANTICS, OrchestratorSpec, default_orchestrators
from .protocol import (
    AssistantDeltaFrame,
    ClientFrame,
    HandoffFrame,
    Manifest,
    SteerToAgentFrame,
    ToolCallFrame,
    ToolResultFrame,
    TurnCompleteFrame,
    UserMessageFrame,
)
from .telemetry import configure_telemetry

logger = logging.getLogger("remote_maf_handoff_bridge")
# Resolved lazily per span, so it picks up whichever TracerProvider `configure_telemetry()`
# installed regardless of import order; a no-op provider when telemetry is unconfigured.
_tracer = trace.get_tracer("remote_maf_handoff_bridge")

# Timeout for a single client-executed tool call round trip. Chosen generously since it covers
# real shell commands/file edits a human may need to approve locally, not just fast lookups.
TOOL_CALL_TIMEOUT_SECONDS = 300


def create_app(orchestrators: list[OrchestratorSpec] | None = None) -> FastAPI:
    """Build the FastAPI app. `orchestrators` is injectable so tests can supply fake-agent
    orchestrators instead of the real OpenAI-backed sample registry in `orchestrator.py`.
    """

    registry = {spec.id: spec for spec in (orchestrators if orchestrators is not None else default_orchestrators())}
    configure_telemetry()
    app = FastAPI(title="opencode-remote-maf-handoff-bridge")

    @app.get("/agents/manifest", response_model=Manifest)
    async def get_manifest() -> Manifest:
        return Manifest(orchestrators=[spec.manifest_entry() for spec in registry.values()])

    @app.websocket("/agents/{orchestrator_id}/session")
    async def session(
        websocket: WebSocket,
        orchestrator_id: str,
        start_agent: str | None = None,
        session_id: str | None = None,
    ) -> None:
        spec = registry.get(orchestrator_id)
        if spec is None:
            await websocket.close(code=4404, reason=f"unknown orchestrator '{orchestrator_id}'")
            return
        # `start_agent` lets a client address any participant in the network directly instead of
        # always entering through the orchestrator's default start agent. Handoffs still work
        # normally from wherever the conversation starts.
        if start_agent is not None and start_agent not in spec.participant_ids:
            await websocket.close(code=4404, reason=f"unknown participant '{start_agent}' in '{orchestrator_id}'")
            return
        # Only patterns whose entry point is a client decision can honour `start_agent`. In group
        # chat, magentic, sequential and concurrent workflows the pattern itself decides who
        # speaks, so silently ignoring the request would leave the client believing it addressed
        # an agent it did not.
        if start_agent is not None and not PATTERN_SEMANTICS[spec.pattern][2]:
            await websocket.close(
                code=4400,
                reason=f"'{orchestrator_id}' is a {spec.pattern} workflow; its participants are not directly addressable",
            )
            return

        await websocket.accept()
        pending_tool_calls: dict[str, asyncio.Future[str]] = {}
        # Turns are processed one at a time in the order received (steer/queue semantics), but
        # frames must still be *read* concurrently with turn processing — a tool call raised
        # mid-turn blocks on a `tool_result` frame arriving on this same connection, so a
        # single sequential read-then-process loop would deadlock (the read would never
        # happen because it's waiting on the very stream that's waiting on it). A background
        # reader task decouples "receive frames" from "process one turn at a time".
        turn_queue: asyncio.Queue[str | None] = asyncio.Queue()

        async def run_local_command(command: str) -> str:
            call_id = str(uuid.uuid4())
            future: asyncio.Future[str] = asyncio.get_event_loop().create_future()
            pending_tool_calls[call_id] = future
            await websocket.send_json(ToolCallFrame(call_id=call_id, name="run_local_command", arguments={"command": command}).model_dump())
            try:
                return await asyncio.wait_for(future, timeout=TOOL_CALL_TIMEOUT_SECONDS)
            finally:
                pending_tool_calls.pop(call_id, None)

        workflow = spec.build(run_local_command, start_agent)

        async def read_frames() -> None:
            try:
                while True:
                    raw = await websocket.receive_json()
                    try:
                        frame: ClientFrame = _parse_client_frame(raw)
                    except ValidationError as exc:
                        await websocket.send_json({"type": "error", "message": f"invalid frame: {exc}"})
                        continue

                    if isinstance(frame, ToolResultFrame):
                        future = pending_tool_calls.get(frame.call_id)
                        if future is not None and not future.done():
                            future.set_result(frame.output)
                        continue

                    text = _resolve_turn_text(frame)
                    if text is None:
                        await websocket.send_json({"type": "error", "message": f"unexpected frame type: {frame.type}"})
                        continue
                    await turn_queue.put(text)
            except WebSocketDisconnect:
                logger.info("session for orchestrator=%s disconnected; cancelling workflow", orchestrator_id)
                await turn_queue.put(None)

        reader_task = asyncio.create_task(read_frames())
        pending_request_id: str | None = None
        try:
            while True:
                text = await turn_queue.get()
                if text is None:
                    break
                stream = (
                    workflow.run(text, stream=True)
                    if pending_request_id is None
                    else workflow.run(
                        stream=True,
                        responses={pending_request_id: HandoffAgentUserRequest.create_response(text)},
                    )
                )
                # A bridge-owned span per user turn. Without it the Phoenix trace list shows only
                # `workflow.run` / `workflow.build`, and identifying which agent actually answered
                # means drilling into the executor tree. This span names the engaged agents up
                # front and carries the session correlation id.
                with _tracer.start_as_current_span(f"turn {orchestrator_id}") as span:
                    span.set_attribute("maf.orchestrator.id", orchestrator_id)
                    span.set_attribute("maf.orchestrator.pattern", spec.pattern)
                    if start_agent:
                        span.set_attribute("maf.start_agent", start_agent)
                    if session_id:
                        span.set_attribute("session.id", session_id)
                    engaged: list[str] = []
                    pending_request_id = await _consume_workflow_events(stream, websocket, engaged)
                    if engaged:
                        span.set_attribute("maf.agents.engaged", engaged)
                        span.set_attribute("maf.agent.responding", engaged[-1])
                        span.update_name(f"turn {orchestrator_id}/{'→'.join(engaged)}")
        finally:
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader_task

    return app


def _resolve_turn_text(frame: ClientFrame) -> str | None:
    """Translate a client frame into the text fed as the next turn's input, or None if the
    frame isn't turn-initiating (i.e. `ToolResultFrame`, handled separately by the caller).
    """

    if isinstance(frame, UserMessageFrame):
        return frame.text
    if isinstance(frame, SteerToAgentFrame):
        # Advisory nudge — see protocol.py's SteerToAgentFrame docstring and
        # design-proposal.md WS1 for why this cannot be a hard override.
        return f"The user has requested you hand off to '{frame.agent_id}' now."
    return None


def _parse_client_frame(raw: dict) -> ClientFrame:
    return TypeAdapter(ClientFrame).validate_python(raw)


async def _consume_workflow_events(
    stream: AsyncIterable[WorkflowEvent], websocket: WebSocket, engaged: list[str] | None = None
) -> str | None:
    """Consume workflow events, translate to wire frames, send over `websocket`.

    Returns the `request_id` of a pending `request_info` event if the workflow is now waiting
    for the next user turn, or `None` if the workflow reached idle/terminated on its own.
    """

    pending_request_id: str | None = None
    async for event in stream:
        if event.type == "output":
            text = _extract_text(event.data)
            if text:
                agent_id = event.executor_id or "unknown"
                # Ordered, de-duplicated: the turn's handoff chain, e.g. ["triage", "refunds"].
                if engaged is not None and (not engaged or engaged[-1] != agent_id):
                    engaged.append(agent_id)
                await websocket.send_json(AssistantDeltaFrame(agent_id=agent_id, text=text).model_dump())
        elif event.type == "handoff_sent" and isinstance(event.data, HandoffSentEvent):
            # Handoff edges, not just responders: an agent that hands off without emitting output
            # still participated, and the target is the one that will answer next. Without this
            # the chain collapses to whoever happened to speak last.
            if engaged is not None:
                for agent_id in (event.data.source, event.data.target):
                    if not engaged or engaged[-1] != agent_id:
                        engaged.append(agent_id)
            await websocket.send_json(HandoffFrame(source=event.data.source, target=event.data.target).model_dump())
        elif event.type == "request_info":
            pending_request_id = event.request_id

    await websocket.send_json(TurnCompleteFrame().model_dump())
    return pending_request_id


def _extract_text(data: object) -> str:
    if isinstance(data, (AgentResponse, AgentResponseUpdate)):
        return data.text or ""
    return ""
